import { existsSync, readFileSync, statfsSync } from 'node:fs'
import path from 'node:path'
import type { BackupConfig } from './config.js'
import { resolveSlotPath } from './config.js'
import { BACKUP_OK, BACKUP_STARTED, matchesFailure, OSS_PUSH_OK } from './messages.js'
import type { BackupPaths } from './paths.js'
import { runProcess } from './process.js'
import type { RunProcess } from './process.js'
import type { BackupState } from './state.js'
import { daysSince, localTimestamp, minutesSince, readState } from './state.js'

/** 每项的结论。`unknown` = 判不了（缺组件 / 仓库锁着），**不算失败**。 */
export type CheckStatus = 'ok' | 'problem' | 'unknown' | 'skipped'

/** ① 上次备份：`state.json` 里 `lastRun*` 三格与 `lastPrune`。 */
export type LastRunItem = {
  status: CheckStatus
  /** 本地时间戳；从没跑过是 `null`。 */
  lastRunAt: string | null
  lastRunOk: boolean | null
  lastRunSummary: string | null
  /** 距上次备份多少分钟。 */
  ageMinutes: number | null
  /** 容忍上限 = `frequencyMinutes` × 2。 */
  toleranceMinutes: number
  /** 上次 forget+prune 成功的时间（`state.lastPrune` 原文）；从没成功过是 `null`。 */
  lastPruneAt: string | null
  /** 距上次 prune 成功几个日历日。 */
  pruneAgeDays: number | null
  message: string
}

export type LogItem = {
  status: CheckStatus
  exists: boolean
  /** 最后一轮里本地备份成没成。判不出是 `null`。 */
  localOk: boolean | null
  /** 最后一轮里 OSS 推送成没成；OSS 关着是 `null`。 */
  ossOk: boolean | null
  /** 日志尾里命中失败关键词、且晚于最近一次成功行的那些行。 */
  errorLines: string[]
  message: string
}

export type DiskItem = {
  status: CheckStatus
  /** 看的是哪个盘（跟着 `repositories.local.repo` 走）。 */
  drive: string | null
  freeBytes: number | null
  totalBytes: number | null
  /** 剩余比例，0–1。 */
  freeRatio: number | null
  /** `ok` / `notice`（<20%）/ `alert`（<10%）。 */
  level: 'ok' | 'notice' | 'alert' | 'unknown'
  message: string
}

export type SnapshotsItem = {
  status: CheckStatus
  /** 最新快照的时间（restic 报的原文）。 */
  latestAt: string | null
  /** 距最新快照多少分钟。 */
  ageMinutes: number | null
  /** 容忍上限 = `frequencyMinutes` × 2。 */
  toleranceMinutes: number
  message: string
}

export type PeriodicItem = {
  status: CheckStatus
  usbCopyDays: number | null
  excludeAuditDays: number | null
  reviewDays: number | null
  /** 该做 USB 离机副本了。 */
  usbCopyDue: boolean
  /** 该扫一遍 exclude 有没有误伤了。 */
  excludeAuditDue: boolean
  /** 该人工复核备份了（窗格据此显示横幅）。 */
  reviewDue: boolean
  message: string
}

export type HealthReport = {
  /** 本地时间戳 `YYYY-MM-DDTHH:MM:SS`。 */
  checkedAt: string
  /** 一个问题都没有才是 `true`。 */
  ok: boolean
  /** 中文、一条一句——直接念给用户听的那种。 */
  problems: string[]
  items: {
    lastRun: LastRunItem
    log: LogItem
    disk: DiskItem
    snapshots: SnapshotsItem
    periodic: PeriodicItem
  }
}

export type HealthOptions = {
  now?: Date | undefined
  /** 跳过快照那项（要启动 restic，慢）。 */
  skipSnapshots?: boolean | undefined
  /** 注入点：跑 restic 的那个函数（只有快照那一项要它）。 */
  run?: RunProcess | undefined
  /** 注入点：磁盘余量。给 `null` 表示读不到。 */
  diskFree?: ((probePath: string) => { freeBytes: number; totalBytes: number } | null) | undefined
  /** 注入点：状态；不给就从数据目录读。 */
  state?: BackupState | undefined
}

/** USB 离机副本的提醒阈值：≥ 7 天。 */
export const USB_COPY_DUE_DAYS = 7
/** exclude 误伤扫描的提醒阈值：≥ 30 天。 */
export const EXCLUDE_AUDIT_DUE_DAYS = 30
/** prune 每日一次；隔了这么多个日历日还没成功就报问题。 */
export const PRUNE_OVERDUE_DAYS = 2
/** 日志尾看多少行搜失败关键词。 */
export const LOG_TAIL_LINES = 30
/** 找「最后一轮」时往回翻多少行——一轮的完整输出（四段 restic）比 30 行长。 */
const ROUND_SCAN_LINES = 200

/** 跑一次完整健康检查。**不抛**：判不了的项记 `unknown`，不影响其余四项。 */
export async function runHealthCheck(
  paths: BackupPaths,
  config: BackupConfig,
  options: HealthOptions = {},
): Promise<HealthReport> {
  const now = options.now ?? new Date()
  const run = options.run ?? runProcess
  const state = options.state ?? readState(paths.stateFile)

  const lastRun = checkLastRun(state, config, now)
  const log = checkLog(paths, config)
  const disk = checkDisk(config, options.diskFree ?? readDiskFree)
  const snapshots = options.skipSnapshots
    ? skippedSnapshots(config)
    : await checkSnapshots(paths, config, run, now)
  const periodic = checkPeriodic(state, config, now)

  const items = { lastRun, log, disk, snapshots, periodic }
  const problems = collectProblems(items)
  return { checkedAt: localTimestamp(now), ok: problems.length === 0, problems, items }
}

/** ① 上次备份：跑过 + 上次成了 + 距上次成功不超过两个周期；备份没问题时再看 prune 有没有超期。 */
function checkLastRun(state: BackupState, config: BackupConfig, now: Date): LastRunItem {
  const toleranceMinutes = config.schedule.frequencyMinutes * 2
  const lastRunAt = state.lastRunAt ?? null
  const lastRunOk = state.lastRunOk ?? null
  const lastRunSummary = state.lastRunSummary ?? null
  const ageMinutes = minutesSince(state.lastRunAt, now)
  const lastPruneAt = state.lastPrune ?? null
  const pruneAgeDays = daysSince(state.lastPrune, now)
  const facts = { lastRunAt, lastRunOk, lastRunSummary, ageMinutes, toleranceMinutes, lastPruneAt, pruneAgeDays }

  if (lastRunAt === null || ageMinutes === null) {
    return { status: 'problem', ...facts, message: '还没备份过——定时那轮还没轮到，或者宿主一直没起来' }
  }
  if (lastRunOk === false) {
    return {
      status: 'problem',
      ...facts,
      message: `上一轮备份失败了（${lastRunAt}${lastRunSummary === null ? '' : `：${lastRunSummary}`}）`,
    }
  }
  if (ageMinutes > toleranceMinutes) {
    return {
      status: 'problem',
      ...facts,
      message: `已经 ${ageMinutes} 分钟没成功备份了（超过两个周期 ${toleranceMinutes} 分钟）`,
    }
  }
  if (pruneAgeDays === null) {
    return { status: 'problem', ...facts, message: `上次备份 ${ageMinutes} 分钟前成功，但 forget+prune 还没成功过` }
  }
  if (pruneAgeDays >= PRUNE_OVERDUE_DAYS) {
    return {
      status: 'problem',
      ...facts,
      message: `上次备份 ${ageMinutes} 分钟前成功，但 forget+prune 已经 ${pruneAgeDays} 天没成功了（上次 ${lastPruneAt}）`,
    }
  }
  return { status: 'ok', ...facts, message: `上次备份 ${ageMinutes} 分钟前成功` }
}

/**
 * ② 日志：从最后一条 `Backup started` 往后算作一轮，看这一轮有没有成功行；
 * 尾 30 行里只报晚于最近一次成功行的失败关键词，早于它的是已经翻篇的旧失败。
 */
function checkLog(paths: BackupPaths, config: BackupConfig): LogItem {
  const ossEnabled = config.repositories.oss.enabled
  if (!existsSync(paths.logFile)) {
    return {
      status: 'problem',
      exists: false,
      localOk: null,
      ossOk: null,
      errorLines: [],
      message: '还没产生备份日志——备份可能一次都没跑过',
    }
  }
  const lines = readFileSync(paths.logFile, 'utf8').split('\n').filter((line) => line !== '')
  const errorLines = unresolvedFailureLines(lines)
  const lastRound = lastRoundOf(lines)
  const localOk = lastRound.lines.some((line) => line.includes(BACKUP_OK))
  const localFailed = lastRound.lines.some((line) => line.includes('Backup FAILED'))
  const ossOk = ossEnabled ? lastRound.lines.some((line) => line.includes(OSS_PUSH_OK)) : null

  if (lastRound.startFound && !localOk && !localFailed) {
    return {
      status: 'unknown',
      exists: true,
      localOk: null,
      ossOk: null,
      errorLines,
      message: '上一轮备份还在跑，结论要等它写完',
    }
  }

  const problems: string[] = []
  if (!localOk) problems.push('最近一轮本地备份没有成功行')
  if (ossEnabled && ossOk === false) problems.push('最近一轮 OSS 推送没有成功行')
  if (errorLines.length > 0) {
    problems.push(`日志尾有 ${errorLines.length} 行失败迹象（最新一条 ${lineStamp(errorLines[errorLines.length - 1] ?? '')}）`)
  }
  return {
    status: problems.length === 0 ? 'ok' : 'problem',
    exists: true,
    localOk,
    ossOk,
    errorLines,
    message: problems.length === 0 ? '最近一轮备份日志正常' : `备份日志：${problems.join('；')}`,
  }
}

/** 尾 `LOG_TAIL_LINES` 行里命中失败关键词、又排在最近一次成功行之后的那些行。 */
function unresolvedFailureLines(lines: string[]): string[] {
  const lastSuccessIndex = lines.findLastIndex((line) => line.includes(BACKUP_OK) || line.includes(OSS_PUSH_OK))
  const tailStart = Math.max(0, lines.length - LOG_TAIL_LINES)
  return lines
    .slice(tailStart)
    .filter((line, offset) => matchesFailure(line) && tailStart + offset > lastSuccessIndex)
}

/** 往回翻 `ROUND_SCAN_LINES` 行找最后一条 `Backup started`，从它往后是最后一轮；找不到就用整个扫描窗口。 */
function lastRoundOf(lines: string[]): { lines: string[]; startFound: boolean } {
  const scanned = lines.slice(-ROUND_SCAN_LINES)
  const startIndex = scanned.findLastIndex((line) => line.includes(BACKUP_STARTED))
  return startIndex >= 0 ? { lines: scanned.slice(startIndex), startFound: true } : { lines: scanned, startFound: false }
}

/** ③ 磁盘：看 `repositories.local.repo` 所在的那个盘。 */
function checkDisk(
  config: BackupConfig,
  diskFree: (probePath: string) => { freeBytes: number; totalBytes: number } | null,
): DiskItem {
  const repo = config.repositories.local.repo.trim()
  if (repo === '') {
    return {
      status: 'unknown',
      drive: null,
      freeBytes: null,
      totalBytes: null,
      freeRatio: null,
      level: 'unknown',
      message: '还没配本地仓库路径，判不了磁盘余量',
    }
  }
  const root = path.parse(path.resolve(repo)).root
  const drive = root.replace(/[\\/]+$/, '') || root
  const free = diskFree(root)
  if (free === null || free.totalBytes <= 0) {
    return {
      status: 'unknown',
      drive,
      freeBytes: null,
      totalBytes: null,
      freeRatio: null,
      level: 'unknown',
      message: `读不到 ${drive} 的余量，判不了`,
    }
  }
  const freeRatio = free.freeBytes / free.totalBytes
  const percent = Math.round(freeRatio * 100)
  const level = freeRatio < 0.1 ? 'alert' : freeRatio < 0.2 ? 'notice' : 'ok'
  return {
    status: level === 'ok' ? 'ok' : 'problem',
    drive,
    freeBytes: free.freeBytes,
    totalBytes: free.totalBytes,
    freeRatio,
    level,
    message:
      level === 'ok'
        ? `${drive} 还剩 ${percent}%`
        : level === 'notice'
          ? `${drive} 仅剩 ${percent}%，该清一清了`
          : `${drive} 只剩 ${percent}%，快满了`,
  }
}

/** ④ 快照新鲜度：距最新快照 ≤ `frequencyMinutes × 2` 算新鲜。restic 不在 / 仓库锁着 / 输出认不出一律 `unknown`。 */
async function checkSnapshots(
  paths: BackupPaths,
  config: BackupConfig,
  run: RunProcess,
  now: Date,
): Promise<SnapshotsItem> {
  const toleranceMinutes = config.schedule.frequencyMinutes * 2
  const noReading: Omit<SnapshotsItem, 'status' | 'message'> = { latestAt: null, ageMinutes: null, toleranceMinutes }
  const exe = resolveSlotPath(config.restic.exe, paths.dir)
  const repo = config.repositories.local.repo.trim()
  if (exe === '' || !existsSync(exe)) {
    return { status: 'unknown', ...noReading, message: 'restic 还没装到位，判不了快照新鲜度' }
  }
  if (repo === '') {
    return { status: 'unknown', ...noReading, message: '还没配本地仓库路径，判不了快照新鲜度' }
  }

  const result = await run(
    exe,
    ['--repo', repo, '--password-file', paths.passwordFile, 'snapshots', '--latest', '1', '--json'],
    { timeoutMs: 120_000 },
  )
  if (result.code !== 0) {
    return { status: 'unknown', ...noReading, message: 'restic 读不到仓库（锁着或盘不在），判不了快照新鲜度' }
  }
  const latestAt = parseLatestSnapshotTime(result.stdout)
  if (latestAt === null) {
    return { status: 'unknown', ...noReading, message: '仓库里还没有快照，或输出格式认不出' }
  }
  const ageMinutes = Math.round((now.getTime() - new Date(latestAt).getTime()) / 60_000)
  const fresh = ageMinutes <= toleranceMinutes
  return {
    status: fresh ? 'ok' : 'problem',
    latestAt,
    ageMinutes,
    toleranceMinutes,
    message: fresh
      ? `最新快照 ${ageMinutes} 分钟前`
      : `最新快照已经是 ${ageMinutes} 分钟前的了（超过两个周期 ${toleranceMinutes} 分钟）`,
  }
}

function skippedSnapshots(config: BackupConfig): SnapshotsItem {
  return {
    status: 'skipped',
    latestAt: null,
    ageMinutes: null,
    toleranceMinutes: config.schedule.frequencyMinutes * 2,
    message: '按要求跳过了快照新鲜度这一项',
  }
}

/** ⑤ 周期提醒：USB 离机副本 ≥ 7 天、exclude 误伤扫描 ≥ 30 天、人工复核 ≥ 配置的间隔。 */
function checkPeriodic(state: BackupState, config: BackupConfig, now: Date): PeriodicItem {
  const usbCopyDays = daysSince(state.lastUsbCopy, now)
  const excludeAuditDays = daysSince(state.lastExcludeAudit, now)
  const reviewDays = daysSince(state.lastReview, now)
  const usbCopyDue = usbCopyDays === null || usbCopyDays >= USB_COPY_DUE_DAYS
  const excludeAuditDue = excludeAuditDays === null || excludeAuditDays >= EXCLUDE_AUDIT_DUE_DAYS
  const reviewDue = reviewDays === null || reviewDays >= config.reviewIntervalDays
  const dueReminders: string[] = []
  if (usbCopyDue) dueReminders.push(usbCopyDays === null ? '还没做过 USB 离机副本' : `USB 离机副本已经 ${usbCopyDays} 天没做了`)
  if (excludeAuditDue) {
    dueReminders.push(excludeAuditDays === null ? '还没扫过 exclude 有没有误伤' : `exclude 误伤扫描已经 ${excludeAuditDays} 天没做了`)
  }
  if (reviewDue) dueReminders.push(reviewDays === null ? '还没人工复核过备份' : `已经 ${reviewDays} 天没人工复核备份了`)
  return {
    status: dueReminders.length === 0 ? 'ok' : 'problem',
    usbCopyDays,
    excludeAuditDays,
    reviewDays,
    usbCopyDue,
    excludeAuditDue,
    reviewDue,
    message: dueReminders.length === 0 ? '周期性维护都在窗口内' : dueReminders.join('；'),
  }
}

/** 五项里 `problem` 的那些，按顺序收成一张中文列表。 */
function collectProblems(items: HealthReport['items']): string[] {
  return [items.lastRun, items.log, items.disk, items.snapshots, items.periodic]
    .filter((item) => item.status === 'problem')
    .map((item) => item.message)
}

/** 从 `logger.line` 写的 `[2026-09-20 15:47:58] …` 行里取时刻；restic 自己的输出行没有这个前缀，回空串。 */
function lineStamp(line: string): string {
  return /^\[([^\]]+)\]/.exec(line)?.[1] ?? ''
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
    return {
      freeBytes: Number(stat.bavail) * Number(stat.bsize),
      totalBytes: Number(stat.blocks) * Number(stat.bsize),
    }
  } catch {
    return null
  }
}
