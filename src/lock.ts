/**
 * 并发锁 —— 数据目录里的 `backup.lock`。
 *
 * 三条路都能触发一次全流程备份：定时器那一轮、命令总线上打的 `windows-backup.run`、
 * （将来的 CLI 门）。命令那两条跑在**同一个宿主进程**里时闭包布尔管得住，但锁落在磁盘上
 * 是为**跨进程**的场面准备的——另一个 home / 另一个入口同时起一轮，谁也不认识谁。
 *
 * 锁内容是 `{ pid, startedAt }` 两格，为的是判**陈旧**：
 *
 * - 进程已经不在了（`process.kill(pid, 0)` 抛 `ESRCH`）——上一轮备份崩了 / 机器断电了，
 *   锁文件留在那里没人删。不认这一支的话，一次崩溃会让备份永久停摆，而且毫无症状。
 * - 或者 `startedAt` 已经超过 6 小时——备份超时上限就是 6 小时，跑得比这还久的 restic
 *   早被自己的超时杀了；pid 恰好被系统回收给别的进程时靠这一支兜底。
 *
 * **释放只删自己写的那份**（比 pid）：抢过陈旧锁的那一方跑完删锁时，被抢的那一方要是还
 * 活着并且晚一步删，会把新主人的锁一起删掉。
 *
 * 零第三方依赖，只用 node 内置（`src/` 域库的硬约束）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 锁文件里那两格。 */
export type LockInfo = { pid: number; startedAt: string }

/** 超过这么久就当陈旧——与备份超时上限（6 小时）对齐。 */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000

/** 注入点：测试不真起进程、不真等 6 小时。 */
export type LockOptions = {
  /** 本进程的 pid；默认 `process.pid`。 */
  pid?: number | undefined
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
    return { pid, startedAt }
  } catch {
    return null
  }
}

/** 这把锁算不算陈旧：进程没了、或者开始时刻认不出 / 超过 6 小时。 */
export function isStale(lock: LockInfo, options: LockOptions = {}): boolean {
  const now = (options.now ?? (() => new Date()))()
  const alive = options.alive ?? defaultAlive
  if (!alive(lock.pid)) return true
  const startedAt = new Date(lock.startedAt).getTime()
  if (Number.isNaN(startedAt)) return true
  return now.getTime() - startedAt > STALE_AFTER_MS
}

/**
 * 占锁。
 *
 * @returns 占到了回一个**释放函数**（幂等、绝不抛）；已经有别人在跑回 `null`。
 */
export function acquire(file: string, options: LockOptions = {}): (() => void) | null {
  const pid = options.pid ?? process.pid
  const now = (options.now ?? (() => new Date()))()
  const existing = readLock(file)
  if (existing !== null && !isStale(existing, options)) return null

  mkdirSync(path.dirname(file), { recursive: true })
  const mine: LockInfo = { pid, startedAt: now.toISOString() }
  writeFileSync(file, `${JSON.stringify(mine, null, 2)}\n`, 'utf8')

  let released = false
  return () => {
    if (released) return
    released = true
    release(file, pid)
  }
}

/**
 * 删锁——**只删 pid 对得上的那份**。别人的锁一个字都不动：抢过陈旧锁的新主人正在跑，
 * 被抢的那一方晚一步来删，删掉的就是新主人的锁。
 */
export function release(file: string, pid: number): void {
  const current = readLock(file)
  if (current === null || current.pid !== pid) return
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
