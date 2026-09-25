/**
 * 健康检查 —— 备份是否正常的**权威判据**。定时器周期自检与 `windows-backup.check` 命令调的是
 * 同一个 `runHealthCheck`，窗格只负责显示它的结果。
 *
 * 输出是纯 JSON（`HealthReport`），不打印、不弹窗、不写日志——怎么呈现由调用方决定。
 *
 * 五项规则照旧实现（再往前是 cc 版 `docs/health-check.md`），四处有意改过判据的照抄：
 * **第一项整个换过**（问外部调度器要任务状态 → 读 `state.json` 的 `lastRun*`，定时器住
 * 在宿主里、没有外部账本可查）、日志尾（按轮判、不按末两行）、快照新鲜度（两个周期、
 * 不是写死 30 分钟）、磁盘（跟着配置里的仓库盘走、不写死 D 盘）。
 *
 * 所有会跑外部程序 / 读磁盘的地方都从 `opts` 拿注入点，测试不启动真 restic、不读真磁盘。
 */

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

/**
 * ① 上次备份——外部账本不存在，能回答「备份这件事还在不在正常运行」的唯一事实是
 * `state.json` 里那三格。
 */
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
  /** 日志尾里命中失败关键词的行。**只算翻篇之前还没成功过的那些**，见 `checkLog`。 */
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
  /** 该人工复核备份了（跑自检、看快照；窗格据此显示横幅）。 */
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
/** prune 每日一次；隔了这么多个日历日还没成功就报问题（容忍一天，同两个周期的口径）。 */
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
  const disk = checkDisk(config, options.diskFree ?? defaultDiskFree)
  const snapshots = options.skipSnapshots
    ? skippedSnapshots(config)
    : await checkSnapshots(paths, config, run, now)
  const periodic = checkPeriodic(state, config, now)

  const items = { lastRun, log, disk, snapshots, periodic }
  const problems = collectProblems(items)
  return { checkedAt: localTimestamp(now), ok: problems.length === 0, problems, items }
}

/**
 * ① 上次备份：跑过 + 上次成了 + 距上次成功不超过两个周期。
 *
 * 三支各说各的话：
 *
 * - 从没跑过：新机 / 刚配好，还没到第一轮；
 * - 上次失败：那一轮的小结原样写进消息，人一眼看见是哪一段失败了；
 * - 太久没成功：容忍两个周期（跟快照新鲜度同一个口径），一个周期的话备份跑了 3 分钟、
 *   自检又晚到 1 分钟就会误报。
 *
 * 备份本身没问题时再看 prune：prune 失败不影响 `lastRunOk`，它的失败行又会被同一轮后面的
 * OSS 推送成功行「翻篇」，日志那项看不见，只能靠 `state.lastPrune` 的新旧来判。
 */
function checkLastRun(state: BackupState, config: BackupConfig, now: Date): LastRunItem {
  const toleranceMinutes = config.schedule.frequencyMinutes * 2
  const lastRunAt = state.lastRunAt ?? null
  const lastRunOk = state.lastRunOk ?? null
  const lastRunSummary = state.lastRunSummary ?? null
  const ageMinutes = minutesSince(state.lastRunAt, now)
  const lastPruneAt = state.lastPrune ?? null
  const pruneAgeDays = daysSince(state.lastPrune, now)
  const base = { lastRunAt, lastRunOk, lastRunSummary, ageMinutes, toleranceMinutes, lastPruneAt, pruneAgeDays }

  if (lastRunAt === null || ageMinutes === null) {
    return { status: 'problem', ...base, message: '还没备份过——定时那轮还没轮到，或者宿主一直没起来' }
  }
  if (lastRunOk === false) {
    return {
      status: 'problem',
      ...base,
      message: `上一轮备份失败了（${lastRunAt}${lastRunSummary === null ? '' : `：${lastRunSummary}`}）`,
    }
  }
  if (ageMinutes > toleranceMinutes) {
    return {
      status: 'problem',
      ...base,
      message: `已经 ${ageMinutes} 分钟没成功备份了（超过两个周期 ${toleranceMinutes} 分钟）`,
    }
  }
  if (pruneAgeDays === null) {
    return { status: 'problem', ...base, message: `上次备份 ${ageMinutes} 分钟前成功，但 forget+prune 还没成功过` }
  }
  if (pruneAgeDays >= PRUNE_OVERDUE_DAYS) {
    return {
      status: 'problem',
      ...base,
      message: `上次备份 ${ageMinutes} 分钟前成功，但 forget+prune 已经 ${pruneAgeDays} 天没成功了（上次 ${lastPruneAt}）`,
    }
  }
  return { status: 'ok', ...base, message: `上次备份 ${ageMinutes} 分钟前成功` }
}

/**
 * ② 日志：最后一轮跑成没成 + 尾巴里有没有**还没翻篇**的失败关键词。
 *
 * 判的是「从最后一条 `Backup started` 往后算作一轮，看这一轮里有没有成功行」——restic
 * 自己的 stdout 就夹在两条成功行中间，轮到 prune 的那轮末尾还是 prune 的行，「末两行」
 * 式判定在真实日志里几乎永不成立。
 *
 * 尾窗口里的失败行**分成两拨**：晚于最近一次成功的是「当前的故障」，早于它的是上一轮
 * 甚至更早的遗留。为什么要分——2026-09-20 实测：一轮全绿之后健康检查仍是 problem，
 * 因为一小时前两次人为打断留下的 `Backup FAILED` 还压在尾 30 行里，要等下一轮把旧行挤出
 * 窗口才转绿。**翻篇的失败不是当前的故障**；反过来，失败了一夜、今早还没成功过的那种，
 * 最新一条失败就排在最后一次成功之后，照样报。
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
  const lastSuccessAt = lines.findLastIndex(
    (line) => line.includes(BACKUP_OK) || line.includes(OSS_PUSH_OK),
  )
  const tailStart = Math.max(0, lines.length - LOG_TAIL_LINES)
  const errorLines = lines
    .slice(tailStart)
    .filter((line, offset) => matchesFailure(line) && tailStart + offset > lastSuccessAt)

  const scan = lines.slice(-ROUND_SCAN_LINES)
  const startedAt = scan.findLastIndex((line) => line.includes(BACKUP_STARTED))
  const round = startedAt >= 0 ? scan.slice(startedAt) : scan
  const localOk = round.some((line) => line.includes(BACKUP_OK))
  const localFailed = round.some((line) => line.includes('Backup FAILED'))
  const ossOk = ossEnabled ? round.some((line) => line.includes(OSS_PUSH_OK)) : null

  if (startedAt >= 0 && !localOk && !localFailed) {
    return {
      status: 'unknown',
      exists: true,
      localOk: null,
      ossOk: null,
      errorLines,
      message: '上一轮备份还在跑，结论要等它写完',
    }
  }

  const bad: string[] = []
  if (!localOk) bad.push('最近一轮本地备份没有成功行')
  if (ossEnabled && ossOk === false) bad.push('最近一轮 OSS 推送没有成功行')
  if (errorLines.length > 0) {
    // 把时刻写进描述：读到这行的人（或 agent）下一步就是去日志里找那几行，别让人自己数
    bad.push(`日志尾有 ${errorLines.length} 行失败迹象（最新一条 ${lineStamp(errorLines[errorLines.length - 1] ?? '')}）`)
  }
  return {
    status: bad.length === 0 ? 'ok' : 'problem',
    exists: true,
    localOk,
    ossOk,
    errorLines,
    message: bad.length === 0 ? '最近一轮备份日志正常' : `备份日志：${bad.join('；')}`,
  }
}

/**
 * ③ 磁盘：**看 `repositories.local.repo` 所在的那个盘**，不写死 D 盘——高级用户把仓库放在
 * 别的盘上是允许的，写死就等于检查了个不相干的盘。
 */
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

/**
 * ④ 快照新鲜度：距最新快照 ≤ `frequencyMinutes × 2` 算新鲜。
 *
 * 写死「≤ 30 分钟」正好是一个调度周期——备份跑了 3 分钟、检查又晚到 1 分钟，就会误报。
 * 给两个周期的容忍，漏报的代价（晚一个周期发现）比天天误报小得多。
 *
 * restic 不在 / 仓库锁着 / 输出认不出，一律 `unknown` 不算失败。
 */
async function checkSnapshots(
  paths: BackupPaths,
  config: BackupConfig,
  run: RunProcess,
  now: Date,
): Promise<SnapshotsItem> {
  const toleranceMinutes = config.schedule.frequencyMinutes * 2
  const base: Omit<SnapshotsItem, 'status' | 'message'> = { latestAt: null, ageMinutes: null, toleranceMinutes }
  const exe = resolveSlotPath(config.restic.exe, paths.dir)
  const repo = config.repositories.local.repo.trim()
  if (exe === '' || !existsSync(exe)) {
    return { status: 'unknown', ...base, message: 'restic 还没装到位，判不了快照新鲜度' }
  }
  if (repo === '') {
    return { status: 'unknown', ...base, message: '还没配本地仓库路径，判不了快照新鲜度' }
  }

  const result = await run(
    exe,
    ['--repo', repo, '--password-file', paths.passwordFile, 'snapshots', '--latest', '1', '--json'],
    { timeoutMs: 120_000 },
  )
  if (result.code !== 0) {
    // 仓库锁着 / 密码文件不在 / 盘没插——都判不了，但都不等于备份坏了
    return { status: 'unknown', ...base, message: 'restic 读不到仓库（锁着或盘不在），判不了快照新鲜度' }
  }
  const latestAt = parseLatestSnapshotTime(result.stdout)
  if (latestAt === null) {
    return { status: 'unknown', ...base, message: '仓库里还没有快照，或输出格式认不出' }
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
  const due: string[] = []
  if (usbCopyDue) due.push(usbCopyDays === null ? '还没做过 USB 离机副本' : `USB 离机副本已经 ${usbCopyDays} 天没做了`)
  if (excludeAuditDue) {
    due.push(excludeAuditDays === null ? '还没扫过 exclude 有没有误伤' : `exclude 误伤扫描已经 ${excludeAuditDays} 天没做了`)
  }
  if (reviewDue) due.push(reviewDays === null ? '还没人工复核过备份' : `已经 ${reviewDays} 天没人工复核备份了`)
  return {
    status: due.length === 0 ? 'ok' : 'problem',
    usbCopyDays,
    excludeAuditDays,
    reviewDays,
    usbCopyDue,
    excludeAuditDue,
    reviewDue,
    message: due.length === 0 ? '周期性维护都在窗口内' : due.join('；'),
  }
}

/** 把五项里该说的话收成一张中文列表——不健康时直接给出这张表。 */
function collectProblems(items: HealthReport['items']): string[] {
  const problems: string[] = []
  if (items.lastRun.status === 'problem') problems.push(items.lastRun.message)
  if (items.log.status === 'problem') problems.push(items.log.message)
  if (items.disk.status === 'problem') problems.push(items.disk.message)
  if (items.snapshots.status === 'problem') problems.push(items.snapshots.message)
  if (items.periodic.status === 'problem') problems.push(items.periodic.message)
  return problems
}

/**
 * 从 `[2026-09-20 15:47:58] …` 这种日志行里取时刻，写进问题描述里用；认不出回空串。
 *
 * 只认 `logger.line` 写出来的方括号前缀——restic 自己的输出没有它，那种行取不出时刻，
 * 描述里就留个空，不影响判定。
 */
function lineStamp(line: string): string {
  return /^\[([^\]]+)\]/.exec(line)?.[1] ?? ''
}

/** `restic snapshots --latest 1 --json` 的输出里取最新那条的 `time`。 */
export function parseLatestSnapshotTime(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const last: unknown = parsed.at(-1)
    if (typeof last !== 'object' || last === null) return null
    const time = (last as Record<string, unknown>).time
    return typeof time === 'string' && !Number.isNaN(new Date(time).getTime()) ? time : null
  } catch {
    return null
  }
}

/** 默认的磁盘余量读法：`fs.statfs`，不起子进程、不看系统语言、不碰 WMI。 */
function defaultDiskFree(probePath: string): { freeBytes: number; totalBytes: number } | null {
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
