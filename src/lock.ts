/**
 * 并发锁 —— 数据目录里的 `backup.lock`。
 *
 * 三条路都能触发一次全流程备份：定时器那一轮、命令总线上打的 `windows-backup.run`、
 * （将来的 CLI 门）。命令那两条跑在**同一个宿主进程**里时闭包布尔管得住，但锁落在磁盘上
 * 是为**跨进程**的场面准备的——另一个 home / 另一个入口同时起一轮，谁也不认识谁。
 *
 * 锁内容是 `{ pid, lease, startedAt, beatAt }`：
 *
 * - `lease` 是这次占锁的唯一租约——**释放与心跳都只动自己那把**。pid 不够用：同一个进程
 *   里先后两代任务共用 pid，靠 pid 认锁的新旧两代会互相误删。
 * - `beatAt` 是最后一次心跳。持锁方每几分钟 `renew()` 一次；陈旧判定看的是「心跳静默了
 *   多久」，不是「这轮跑了多久」——一轮合法地串四个六小时上限的子步骤时，锁不该被抢。
 *
 * 陈旧判据两支，命中任一就当无主：
 *
 * - 进程已经不在了（`process.kill(pid, 0)` 抛 `ESRCH`）——上一轮备份崩了 / 机器断电了，
 *   锁文件留在那里没人删。不认这一支的话，一次崩溃会让备份永久停摆，而且毫无症状。
 * - 或者最后一次心跳（旧格式锁退回 `startedAt`）距今超过 6 小时——活任务一直在跳心跳，
 *   走到这一支的是心跳彻底停了的死任务；pid 恰好被系统回收给别的进程时也靠这一支兜底。
 *
 * **占锁是原子的**（`flag: 'wx'`）：读到「没有有效锁」之后、写进去之前，别人可能恰好也
 * 写进去——`wx` 只有一个赢家，输家回 `null`。读-查-写三步分开的写法在跨进程下两边都
 * 以为自己占到了，两轮 restic 并发跑。
 *
 * **释放只删 lease 对得上的那份**：抢过陈旧锁的新主人正在跑，被抢的那一方晚一步来删，
 * 删掉的就是新主人的锁。
 *
 * 零第三方依赖，只用 node 内置（`src/` 域库的硬约束）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 锁文件里的内容。`lease` / `beatAt` 是心跳制加的；读到旧格式（缺这两格）按可选处理。 */
export type LockInfo = { pid: number; lease?: string; startedAt: string; beatAt?: string }

/** 超过这么久没有心跳就当陈旧。 */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000
/** 持锁方的心跳间隔。比 STALE_AFTER_MS 小两个数量级：丢十几跳也不误判死。 */
export const HEARTBEAT_MS = 5 * 60 * 1000

/** 注入点：测试不真起进程、不真等 6 小时。 */
export type LockOptions = {
  /** 本进程的 pid；默认 `process.pid`。 */
  pid?: number | undefined
  /** 这次占锁的租约 id；默认现生成。测试用它造「同一把锁的两次 acquire」。 */
  lease?: string | undefined
  now?: (() => Date) | undefined
  /** 某个 pid 还活着吗；默认 `process.kill(pid, 0)`。 */
  alive?: ((pid: number) => boolean) | undefined
}

/** 读锁文件；不存在 / 坏掉 / 形状不对一律 `null`（都按「没有有效的锁」处理）。 */
export function readLock(file: string): LockInfo | null {
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const raw = parsed as Record<string, unknown>
    const pid = raw.pid
    const startedAt = raw.startedAt
    if (typeof pid !== 'number' || !Number.isFinite(pid)) return null
    if (typeof startedAt !== 'string') return null
    const lease = raw.lease
    const beatAt = raw.beatAt
    return {
      pid,
      startedAt,
      ...(typeof lease === 'string' ? { lease } : {}),
      ...(typeof beatAt === 'string' ? { beatAt } : {}),
    }
  } catch {
    return null
  }
}

/** 这把锁算不算陈旧：进程没了、时刻认不出、或最后一次心跳静默超过上限。 */
export function isStale(lock: LockInfo, options: LockOptions = {}): boolean {
  const now = (options.now ?? (() => new Date()))()
  const alive = options.alive ?? defaultAlive
  if (!alive(lock.pid)) return true
  const beat = new Date(lock.beatAt ?? lock.startedAt).getTime()
  if (Number.isNaN(beat)) return true
  return now.getTime() - beat > STALE_AFTER_MS
}

/** 占到锁之后拿在手里的两样：释放（幂等、绝不抛）与心跳。 */
export type HeldLock = {
  /** 删掉自己那把锁；别人的锁一个字都不动。 */
  release(): void
  /** 刷新自己那把锁的心跳时刻；没占到 / 已释放 / 锁已被抢时是空操作。 */
  renew(): void
}

/**
 * 占锁。原子：`wx` 只有一个赢家。
 *
 * @returns 占到了回持有句柄；已经有别人在跑回 `null`。
 */
export function acquire(file: string, options: LockOptions = {}): HeldLock | null {
  const pid = options.pid ?? process.pid
  const now = (options.now ?? (() => new Date()))()
  const lease = options.lease ?? `${String(pid)}-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const iso = now.toISOString()
  const mine: LockInfo = { pid, lease, startedAt: iso, beatAt: iso }
  const text = `${JSON.stringify(mine, null, 2)}\n`

  mkdirSync(path.dirname(file), { recursive: true })
  if (!tryCreate(file, text)) {
    // 文件已经在：只有它确实无主（陈旧 / 读不出有效形状）才清掉重抢；再撞上就是别人刚抢下
    const existing = readLock(file)
    if (existing !== null && !isStale(existing, options)) return null
    try {
      rmSync(file, { force: true })
    } catch {
      return null
    }
    if (!tryCreate(file, text)) return null
  }

  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      releaseLock(file, lease)
    },
    renew: () => {
      if (released) return
      renewLock(file, lease)
    },
  }
}

/** `wx` 创建：文件已存在回 false（EEXIST），其余异常照抛。 */
function tryCreate(file: string, text: string): boolean {
  try {
    writeFileSync(file, text, { flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/** 心跳：把 `beatAt` 刷到现在。只改 lease 对得上的那份——锁已被抢走时是空操作。 */
function renewLock(file: string, lease: string): void {
  const current = readLock(file)
  if (current === null || current.lease !== lease) return
  try {
    writeFileSync(file, `${JSON.stringify({ ...current, beatAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  } catch {
    // 心跳写不进不算事故：陈旧判定退回上一跳 / startedAt，STALE_AFTER_MS 兜底
  }
}

/**
 * 删锁——**只删 lease 对得上的那份**。别人的锁一个字都不动：抢过陈旧锁的新主人正在跑，
 * 被抢的那一方晚一步来删，删掉的就是新主人的锁。
 */
function releaseLock(file: string, lease: string): void {
  const current = readLock(file)
  if (current === null || current.lease !== lease) return
  try {
    rmSync(file, { force: true })
  } catch {
    // 删不掉不抛：备份本身已经跑完了，为一个删不掉的锁文件把结论弄坏不划算；
    // 下一轮会按「陈旧」把它抢过来
  }
}

/** 默认的「还活着吗」：0 号信号只做权限与存在性检查，不真的发信号。 */
function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH = 没这个进程；EPERM = 进程在、但不是我们能碰的（别的账户），那也算活着
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
