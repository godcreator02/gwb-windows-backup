import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 锁文件里的内容。 */
export type LockInfo = { pid: number; lease: string; startedAt: string; beatAt: string }

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
    const { pid, lease, startedAt, beatAt } = parsed as Record<string, unknown>
    if (typeof pid !== 'number' || !Number.isFinite(pid)) return null
    if (typeof lease !== 'string' || typeof startedAt !== 'string' || typeof beatAt !== 'string') return null
    return { pid, lease, startedAt, beatAt }
  } catch {
    return null
  }
}

/** 这把锁算不算陈旧：进程没了、时刻认不出、或最后一次心跳静默超过上限。 */
export function isStale(lock: LockInfo, options: LockOptions = {}): boolean {
  const now = (options.now ?? (() => new Date()))()
  const isAlive = options.alive ?? isProcessAlive
  if (!isAlive(lock.pid)) return true
  const lastBeatMs = new Date(lock.beatAt).getTime()
  if (Number.isNaN(lastBeatMs)) return true
  return now.getTime() - lastBeatMs > STALE_AFTER_MS
}

/** 正有一轮备份持着的锁：锁文件在、形状对、不陈旧。没有就回 `null`。「正在备份」只看它。 */
export function activeLock(file: string): LockInfo | null {
  const lock = readLock(file)
  return lock !== null && !isStale(lock) ? lock : null
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
  const lease = options.lease ?? newLeaseId(pid, now)
  const iso = now.toISOString()
  const mine: LockInfo = { pid, lease, startedAt: iso, beatAt: iso }
  const lockText = `${JSON.stringify(mine, null, 2)}\n`

  mkdirSync(path.dirname(file), { recursive: true })
  const claimed = tryCreateExclusive(file, lockText) || claimAfterClearingStaleLock(file, lockText, options)
  if (!claimed) return null

  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      releaseOwnLock(file, lease)
    },
    renew: () => {
      if (released) return
      renewOwnLock(file, lease)
    },
  }
}

function newLeaseId(pid: number, now: Date): string {
  return `${String(pid)}-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** `wx` 创建：文件已存在回 false（EEXIST），其余异常照抛。 */
function tryCreateExclusive(file: string, lockText: string): boolean {
  try {
    writeFileSync(file, lockText, { flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/** 已有的锁确实无主（陈旧 / 读不出有效形状）才清掉重抢；重抢时又撞上文件，就是别人刚抢下。 */
function claimAfterClearingStaleLock(file: string, lockText: string, options: LockOptions): boolean {
  const existing = readLock(file)
  if (existing !== null && !isStale(existing, options)) return false
  try {
    rmSync(file, { force: true })
  } catch {
    return false
  }
  return tryCreateExclusive(file, lockText)
}

/** 把 `beatAt` 刷到现在。只改 lease 对得上的那份——锁已被抢走时是空操作。 */
function renewOwnLock(file: string, lease: string): void {
  const current = readLock(file)
  if (current === null || current.lease !== lease) return
  try {
    writeFileSync(file, `${JSON.stringify({ ...current, beatAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  } catch {
    // 写不进只少一次心跳：陈旧判定看上一次写进去的 beatAt，STALE_AFTER_MS 比心跳间隔大两个数量级
  }
}

/** 只删 lease 对得上的那份：抢过陈旧锁的新主人正在跑时，被抢的一方晚一步来删，删不到新主人的锁。 */
function releaseOwnLock(file: string, lease: string): void {
  const current = readLock(file)
  if (current === null || current.lease !== lease) return
  try {
    rmSync(file, { force: true })
  } catch {
    // 删不掉不抛：备份已经跑完，下一轮按陈旧把它抢过来
  }
}

/** 0 号信号只做存在性检查。ESRCH = 没这个进程；EPERM = 进程在、只是属于别的账户，也算活着。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
