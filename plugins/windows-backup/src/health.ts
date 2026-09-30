import { existsSync, statfsSync } from 'node:fs'
import path from 'node:path'
import { daysSince, localTimestamp, minutesSince } from './clock.js'
import type { BackupConfig } from './config.js'
import { resolveResticExe } from './config.js'
import type { BackupPaths } from './paths.js'
import type { RunProcess } from './process.js'
import { resticEnv, runRestic } from './restic.js'
import type { BackupState } from './state.js'

/** 每项的结论。`unknown` = 判不了（缺组件 / 仓库锁着 / 还没读过），**不算失败**。 */
export type ItemStatus = 'ok' | 'problem' | 'unknown'

/** ① 上次备份：`state.json` 里的 `lastRun*` 与 `lastPrune`。 */
export type LastRunItem = {
  status: ItemStatus
  /** 距上次备份多少分钟；从没跑过是 `null`。 */
  ageMinutes: number | null
  /** 容忍上限 = `frequency-minutes` × 2。 */
  toleranceMinutes: number
  /** 上次 forget+prune 成功的时间（`state.lastPrune` 原文）；从没成功过是 `null`。 */
  lastPruneAt: string | null
  /** 距上次 prune 成功几个日历日。 */
  pruneAgeDays: number | null
  message: string
}

/** ② 磁盘：本地仓库所在的盘还剩多少。 */
export type DiskItem = {
  status: ItemStatus
  /** 看的是哪个盘（跟着 `local-repo` 走）。 */
  drive: string | null
  freeBytes: number | null
  totalBytes: number | null
  /** 剩余比例，0–1。 */
  freeRatio: number | null
  /** `ok` / `notice`（<20%）/ `alert`（<10%）。 */
  level: 'ok' | 'notice' | 'alert' | 'unknown'
  message: string
}

/** ③ 快照新鲜度：本地仓库里最新一个快照有多老。 */
export type SnapshotsItem = {
  status: ItemStatus
  /** 上次读仓库的时刻（本地时间戳）；还没读过是 `null`。 */
  readAt: string | null
  /** 最新快照的时间（restic 报的原文）。 */
  latestAt: string | null
  ageMinutes: number | null
  /** 容忍上限 = `frequency-minutes` × 2。 */
  toleranceMinutes: number
  message: string
}

/** 「备份还在正常运行吗」的结论。每次问都现算，只有快照那项用的是最近一次读仓库的结果。 */
export type HealthReport = {
  /** 一个问题都没有才是 `true`。 */
  ok: boolean
  /** 中文、一条一句——直接念给用户听的那种。 */
  problems: string[]
  items: {
    lastRun: LastRunItem
    disk: DiskItem
    snapshots: SnapshotsItem
  }
}

/** 最近一次读本地仓库的结果。读仓库要启动 restic，所以每轮备份结束后读一次、`check` 命令读一次，其余时候用这份。 */
export type SnapshotReading = {
  /** 读的时刻（本地时间戳）。 */
  readAt: string
  /** 最新快照的时间（restic 报的原文）；读不出是 `null`。 */
  latestAt: string | null
  /** 读不出的原因；读出来了是 `null`。 */
  unreadable: string | null
}

/** 该做的人工维护：到期了才出现在列表里。它们不是故障，不算进 `HealthReport`。 */
export type Reminder = {
  what: 'usb-copy' | 'exclude-audit' | 'review'
  /** 距上次做过几天；从没做过是 `null`。 */
  days: number | null
  message: string
}

export type DiskFree = (probePath: string) => { freeBytes: number; totalBytes: number } | null

/** USB 离机副本的提醒阈值：≥ 7 天。 */
export const USB_COPY_DUE_DAYS = 7
/** exclude 误伤扫描的提醒阈值：≥ 30 天。 */
export const EXCLUDE_AUDIT_DUE_DAYS = 30
/** prune 每日一次；隔了这么多个日历日还没成功就报问题。 */
export const PRUNE_OVERDUE_DAYS = 2

/** 现算三项结论。只读 state、磁盘余量与传进来的那份快照读数，不启动任何进程。 */
export function assessHealth(input: {
  state: BackupState
  config: BackupConfig
  snapshots: SnapshotReading | null
  now: Date
  diskFree?: DiskFree | undefined
}): HealthReport {
  const toleranceMinutes = input.config.frequencyMinutes * 2
  const items = {
    lastRun: assessLastRun(input.state, toleranceMinutes, input.now),
    disk: assessDisk(input.config.localRepo, input.diskFree ?? readDiskFree),
    snapshots: assessSnapshots(input.snapshots, toleranceMinutes, input.now),
  }
  const problems = [items.lastRun, items.disk, items.snapshots].filter((item) => item.status === 'problem').map((item) => item.message)
  return { ok: problems.length === 0, problems, items }
}

/** 读本地仓库最新快照的时间。restic 不在、仓库锁着、输出认不出都记进 `unreadable`，不抛。 */
export async function readLatestSnapshot(paths: BackupPaths, config: BackupConfig, run: RunProcess | undefined, now: Date): Promise<SnapshotReading> {
  const readAt = localTimestamp(now)
  const exe = resolveResticExe(config.resticExe, paths.dir)
  if (!existsSync(exe)) return { readAt, latestAt: null, unreadable: `restic 还没装到位（${exe}）` }
  if (config.localRepo.trim() === '') return { readAt, latestAt: null, unreadable: '还没配本地仓库路径' }
  const result = await runRestic(exe, config.localRepo, ['snapshots', '--latest', '1', '--json'], {
    passwordFile: paths.passwordFile,
    env: resticEnv(config.gomaxprocs),
    run,
  })
  if (result.code !== 0) return { readAt, latestAt: null, unreadable: 'restic 读不到仓库（锁着或盘不在）' }
  const latestAt = parseLatestSnapshotTime(result.stdout)
  if (latestAt === null) return { readAt, latestAt: null, unreadable: '仓库里还没有快照，或输出格式认不出' }
  return { readAt, latestAt, unreadable: null }
}

/** 到期了的人工维护：USB 离机副本 ≥ 7 天、exclude 误伤扫描 ≥ 30 天、人工复核 ≥ `review-interval-days`。从没做过也算到期。 */
export function dueReminders(state: BackupState, config: BackupConfig, now: Date): Reminder[] {
  const candidates: Array<{ what: Reminder['what']; days: number | null; dueAfterDays: number; name: string }> = [
    { what: 'usb-copy', days: daysSince(state.lastUsbCopy, now), dueAfterDays: USB_COPY_DUE_DAYS, name: 'USB 离机副本' },
    { what: 'exclude-audit', days: daysSince(state.lastExcludeAudit, now), dueAfterDays: EXCLUDE_AUDIT_DUE_DAYS, name: 'exclude 误伤扫描' },
    { what: 'review', days: daysSince(state.lastReview, now), dueAfterDays: config.reviewIntervalDays, name: '人工复核' },
  ]
  return candidates
    .filter((one) => one.days === null || one.days >= one.dueAfterDays)
    .map(({ what, days, name }) => ({
      what,
      days,
      message: days === null ? `${name}：还没做过` : `${name}：已经 ${String(days)} 天没做了`,
    }))
}

/** 跑过 + 上次成了 + 距上次不超过两个周期；备份没问题时再看 prune 有没有超期。 */
function assessLastRun(state: BackupState, toleranceMinutes: number, now: Date): LastRunItem {
  const ageMinutes = minutesSince(state.lastRunAt, now)
  const lastPruneAt = state.lastPrune ?? null
  const pruneAgeDays = daysSince(state.lastPrune, now)
  const facts = { ageMinutes, toleranceMinutes, lastPruneAt, pruneAgeDays }

  if (ageMinutes === null) {
    return { status: 'problem', ...facts, message: '还没备份过——定时那轮还没轮到，或者工作台一直没运行' }
  }
  if (state.lastRunOk === false) {
    const summary = state.lastRunSummary === undefined ? '' : `：${state.lastRunSummary}`
    return { status: 'problem', ...facts, message: `上一轮备份失败了（${state.lastRunAt ?? ''}${summary}）` }
  }
  if (ageMinutes > toleranceMinutes) {
    return { status: 'problem', ...facts, message: `已经 ${String(ageMinutes)} 分钟没成功备份了（超过两个周期 ${String(toleranceMinutes)} 分钟）` }
  }
  if (pruneAgeDays === null) {
    return { status: 'problem', ...facts, message: `上次备份 ${String(ageMinutes)} 分钟前成功，但 forget+prune 还没成功过` }
  }
  if (pruneAgeDays >= PRUNE_OVERDUE_DAYS) {
    return {
      status: 'problem',
      ...facts,
      message: `上次备份 ${String(ageMinutes)} 分钟前成功，但 forget+prune 已经 ${String(pruneAgeDays)} 天没成功了（上次 ${lastPruneAt ?? ''}）`,
    }
  }
  return { status: 'ok', ...facts, message: `上次备份 ${String(ageMinutes)} 分钟前成功` }
}

/** 看 `local-repo` 所在的那个盘。 */
function assessDisk(localRepo: string, diskFree: DiskFree): DiskItem {
  const noReading = { freeBytes: null, totalBytes: null, freeRatio: null, level: 'unknown' as const }
  const repo = localRepo.trim()
  if (repo === '') {
    return { status: 'unknown', drive: null, ...noReading, message: '还没配本地仓库路径，判不了磁盘余量' }
  }
  const root = path.parse(path.resolve(repo)).root
  const drive = root.replace(/[\\/]+$/, '') || root
  const free = diskFree(root)
  if (free === null || free.totalBytes <= 0) {
    return { status: 'unknown', drive, ...noReading, message: `读不到 ${drive} 的余量，判不了` }
  }
  const freeRatio = free.freeBytes / free.totalBytes
  const percent = Math.round(freeRatio * 100)
  const level = freeRatio < 0.1 ? 'alert' : freeRatio < 0.2 ? 'notice' : 'ok'
  const message =
    level === 'ok' ? `${drive} 还剩 ${String(percent)}%` : level === 'notice' ? `${drive} 仅剩 ${String(percent)}%，该清一清了` : `${drive} 只剩 ${String(percent)}%，快满了`
  return { status: level === 'ok' ? 'ok' : 'problem', drive, freeBytes: free.freeBytes, totalBytes: free.totalBytes, freeRatio, level, message }
}

/** 距最新快照 ≤ 两个周期算新鲜。还没读过、读不出一律 `unknown`；年龄按现在算，不按读的时刻算。 */
function assessSnapshots(reading: SnapshotReading | null, toleranceMinutes: number, now: Date): SnapshotsItem {
  const noAge = { latestAt: null, ageMinutes: null, toleranceMinutes }
  if (reading === null) {
    return { status: 'unknown', readAt: null, ...noAge, message: '还没读过仓库（加载后第一分钟读一次，之后每轮备份结束读一次）' }
  }
  if (reading.latestAt === null) {
    return { status: 'unknown', readAt: reading.readAt, ...noAge, message: `判不了快照新鲜度：${reading.unreadable ?? ''}` }
  }
  const ageMinutes = Math.round((now.getTime() - new Date(reading.latestAt).getTime()) / 60_000)
  const fresh = ageMinutes <= toleranceMinutes
  return {
    status: fresh ? 'ok' : 'problem',
    readAt: reading.readAt,
    latestAt: reading.latestAt,
    ageMinutes,
    toleranceMinutes,
    message: fresh
      ? `最新快照 ${String(ageMinutes)} 分钟前`
      : `最新快照已经是 ${String(ageMinutes)} 分钟前的了（超过两个周期 ${String(toleranceMinutes)} 分钟）`,
  }
}

/** `restic snapshots --latest 1 --json` 的输出里取最新那条的 `time`。 */
export function parseLatestSnapshotTime(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const latest: unknown = parsed.at(-1)
    if (typeof latest !== 'object' || latest === null) return null
    const time = (latest as Record<string, unknown>).time
    return typeof time === 'string' && !Number.isNaN(new Date(time).getTime()) ? time : null
  } catch {
    return null
  }
}

/** `fs.statfs` 读磁盘余量：不启动子进程、不看系统语言。读不到回 `null`。 */
function readDiskFree(probePath: string): { freeBytes: number; totalBytes: number } | null {
  try {
    const stat = statfsSync(probePath)
    return { freeBytes: Number(stat.bavail) * Number(stat.bsize), totalBytes: Number(stat.blocks) * Number(stat.bsize) }
  } catch {
    return null
  }
}
