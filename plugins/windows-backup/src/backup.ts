import type { BackupConfig } from './config.js'
import { resolveSlotPath } from './config.js'
import { readOssEnv } from './credentials.js'
import { acquire, HEARTBEAT_MS, readLock, type HeldLock } from './lock.js'
import type { Logger } from './log.js'
import {
  BACKUP_OK,
  BACKUP_STARTED,
  completedLine,
  failedLine,
  OSS_PRUNE_LABEL,
  OSS_PUSH_OK,
  ossPushStartedLine,
  parentDroppedLine,
  parentUnusable,
  PRUNE_LABEL,
  startedLine,
} from './messages.js'
import type { BackupPaths } from './paths.js'
import { BACKUP_TIMEOUT_MS, runProcess } from './process.js'
import type { RunProcess, RunResult } from './process.js'
import { ossRepoUrl, parseProcessedSize, parseSnapshotId, pruneArgs, resticEnv, runRestic } from './restic.js'
import { localTimestamp, readState, shouldRunPrune, writeState } from './state.js'
import { sendToast } from './toast.js'

/** 单次本地备份的结果。 */
export type LocalOutcome = {
  ok: boolean
  snapshotId: string | null
  size: string | null
  durationSeconds: number
}

/** 单次 OSS 推送的结果。 */
export type OssOutcome = {
  ok: boolean
  repo: string
  durationSeconds: number
  /** 这一次推进 OSS 仓的快照 ID——记进 state 给下一轮当父快照。解析不出是 `null`。 */
  snapshotId: string | null
}

export type Notification = { title: string; body: string }

/** 真跑完了一轮的那种结果。 */
export type CompletedBackupResult = {
  /** 整条链路的结论：本地成 + （OSS 关或 OSS 成）。 */
  ok: boolean
  /** 跑完了就是 `null`——判「这次到底跑没跑」只看这一格。 */
  skipped: null
  local: LocalOutcome
  /** OSS 关着 / 本地就失败了都是 `null`。 */
  oss: OssOutcome | null
  /** 本轮是否轮到 prune。 */
  prunedToday: boolean
  notification: Notification
}

/** 没跑成的那种：别人占着锁。不写失败日志、不弹 toast、不动 `state.lastRun*`。 */
export type SkippedBackupResult = {
  ok: false
  skipped: 'locked'
  /** 占着锁那一轮是什么时候开始的；读不出来是 `null`。 */
  heldSince: string | null
}

export type FullBackupResult = CompletedBackupResult | SkippedBackupResult

export type BackupContext = {
  paths: BackupPaths
  config: BackupConfig
  logger: Logger
  /** 注入点：跑 restic 的那个函数。 */
  run?: RunProcess | undefined
  /** 注入点：报时。 */
  now?: (() => Date) | undefined
  /** 注入点：弹通知。配置里 `toast: false` 时不调它。 */
  notify?: ((title: string, body: string) => Promise<unknown>) | undefined
  /** 注入点：父 env。 */
  env?: NodeJS.ProcessEnv | undefined
  /** 注入点：占锁。回 `null` = 占不到。测试用它造「另一轮正在跑」。 */
  acquireLock?: ((file: string) => HeldLock | null) | undefined
}

/**
 * 配置齐不齐、能不能开跑。回一句说明 = 拒跑的理由，回 `null` = 可以跑。定时与 `windows-backup.run` 共用这一份判据；
 * 理由里的键名是设置插件里的 kebab-case 键。
 */
export function refuseReason(config: BackupConfig): string | null {
  if (config.sources.length === 0) {
    return '还没配备份白名单：用设置把本插件的 `sources` 填上（一行一项，如 D:/Notes）。'
  }
  if (config.repositories.local.repo.trim() === '') {
    return '还没配本地仓库：用设置把本插件的 `local-repo` 填上（如 D:/Backup/restic-repo）。'
  }
  const oss = config.repositories.oss
  if (oss.enabled && (oss.bucket.trim() === '' || oss.endpoint.trim() === '')) {
    return (
      'OSS 开着但还没配全：把本插件设置里的 `oss-bucket` 与 `oss-endpoint`（完整主机名 ' +
      'oss-cn-*.aliyuncs.com）填上，暂时不用 OSS 就把 `oss-enabled` 关掉。'
    )
  }
  return null
}

/**
 * 全流程一次。**不抛**：任何一段失败都写进日志与返回值，调用方拿 `ok` / `skipped` 判。
 * 起手先占数据目录里的 `backup.lock`，占不到直接回 `{ ok: false, skipped: 'locked' }`，一个字都不往日志里写。
 */
export async function runFullBackup(ctx: BackupContext): Promise<FullBackupResult> {
  const acquireLock = ctx.acquireLock ?? ((file: string) => acquire(file))
  const held = acquireLock(ctx.paths.lockFile)
  if (held === null) {
    return { ok: false, skipped: 'locked', heldSince: readLock(ctx.paths.lockFile)?.startedAt ?? null }
  }
  const heartbeat = setInterval(() => held.renew(), HEARTBEAT_MS)
  try {
    return await runLocked(ctx)
  } finally {
    clearInterval(heartbeat)
    held.release()
  }
}

/** 一轮里各段都要的那几样。 */
type StageInputs = {
  exe: string
  sources: string[]
  excludeFile: string
  excludeArgs: string[]
  passwordFile: string
  stateFile: string
  retention: BackupConfig['retention']
  gomaxprocs: number
  parentEnv: NodeJS.ProcessEnv
  logger: Logger
  run: RunProcess
  now: () => Date
}

/** 锁在手之后的那一整条链路：本地备份 →（本地成了）每日 prune → OSS 推送与 OSS prune → 轮转日志 → 记账 → 通知。 */
async function runLocked(ctx: BackupContext): Promise<CompletedBackupResult> {
  const { paths, config, logger } = ctx
  const stage = stageInputsOf(ctx)
  const ossEnabled = config.repositories.oss.enabled
  // 父快照在开跑前取一次：这一轮会把自己的新快照 ID 写回 state，边跑边读就读到本轮的结果
  const stateBeforeThisRun = readState(paths.stateFile)

  logger.line(BACKUP_STARTED)
  const local = await backUpLocallyAndRecordSnapshot(stage, config.repositories.local.repo, stateBeforeThisRun.lastLocalSnapshot)

  let oss: OssOutcome | null = null
  let prunedToday = false
  if (local.ok) {
    prunedToday = shouldRunPrune(readState(paths.stateFile), stage.now())
    if (prunedToday) await pruneLocalAndRecordTimestamp(stage, config.repositories.local.repo)
    if (ossEnabled) {
      oss = await pushToOssAndPrune(stage, config.repositories.oss, stateBeforeThisRun.lastOssSnapshot, prunedToday, readOssEnv(paths.ossCredentialsFile))
    }
  }

  logger.rotate(config.logging)

  const notification = buildNotification(local, oss, ossEnabled, paths.logFile)
  const ok = local.ok && (!ossEnabled || (oss?.ok ?? false))
  // 成败都记：只在成功时记，连着失败三天看起来会像「三天前刚备过」
  writeState(paths.stateFile, {
    lastRunAt: localTimestamp(stage.now()),
    lastRunOk: ok,
    lastRunSummary: notification.body,
  })

  if (config.toast) {
    const notify = ctx.notify ?? ((title: string, body: string) => sendToast(title, body, { logger, run: stage.run }))
    await notify(notification.title, notification.body)
  }

  return { ok, skipped: null, local, oss, prunedToday, notification }
}

function stageInputsOf(ctx: BackupContext): StageInputs {
  const { paths, config, logger } = ctx
  return {
    exe: resolveSlotPath(config.restic.exe, paths.dir),
    sources: config.sources,
    excludeFile: paths.defaultExcludeFile,
    excludeArgs: excludeArgv(config.exclude),
    passwordFile: paths.passwordFile,
    stateFile: paths.stateFile,
    retention: config.retention,
    gomaxprocs: config.restic.gomaxprocs,
    parentEnv: ctx.env ?? process.env,
    logger,
    run: ctx.run ?? runProcess,
    now: ctx.now ?? (() => new Date()),
  }
}

/** 本地备份；成了就立刻把快照 ID 写进 state，后面几段失败也不影响下一轮用它当父快照。 */
async function backUpLocallyAndRecordSnapshot(stage: StageInputs, repo: string, parentId: string | undefined): Promise<LocalOutcome> {
  const local = await doLocalBackup({ ...backupRunArgsOf(stage, resticEnv(stage.gomaxprocs, {}, stage.parentEnv)), repo, now: stage.now, parentId })
  if (local.ok && local.snapshotId !== null) writeState(stage.stateFile, { lastLocalSnapshot: local.snapshotId })
  return local
}

/** 本地 prune；只有真成了才记 `lastPrune`，失败了下一轮再试。 */
async function pruneLocalAndRecordTimestamp(stage: StageInputs, repo: string): Promise<void> {
  const pruned = await doPrune({ ...pruneRunArgsOf(stage, resticEnv(stage.gomaxprocs, {}, stage.parentEnv)), repo, label: PRUNE_LABEL })
  if (pruned) writeState(stage.stateFile, { lastPrune: localTimestamp(stage.now()) })
}

/** OSS 推送，成了记下快照 ID；本轮该 prune 且推送成功才对 OSS 仓跑 prune。 */
async function pushToOssAndPrune(
  stage: StageInputs,
  oss: BackupConfig['repositories']['oss'],
  parentId: string | undefined,
  prunedToday: boolean,
  ossCredentialsEnv: Record<string, string>,
): Promise<OssOutcome> {
  const ossEnv = resticEnv(stage.gomaxprocs, ossCredentialsEnv, stage.parentEnv)
  const pushed = await doOssPush({ ...backupRunArgsOf(stage, ossEnv), oss, now: stage.now, parentId })
  if (pushed.ok && pushed.snapshotId !== null) writeState(stage.stateFile, { lastOssSnapshot: pushed.snapshotId })
  if (prunedToday && pushed.ok) {
    await doPrune({ ...pruneRunArgsOf(stage, ossEnv), repo: pushed.repo, label: OSS_PRUNE_LABEL })
  }
  return pushed
}

function backupRunArgsOf(stage: StageInputs, env: NodeJS.ProcessEnv): BackupRunArgs {
  return {
    exe: stage.exe,
    sources: stage.sources,
    excludeFile: stage.excludeFile,
    excludeArgs: stage.excludeArgs,
    passwordFile: stage.passwordFile,
    env,
    logger: stage.logger,
    run: stage.run,
  }
}

function pruneRunArgsOf(stage: StageInputs, env: NodeJS.ProcessEnv): Omit<PruneArgs, 'repo' | 'label'> {
  return {
    exe: stage.exe,
    retention: stage.retention,
    passwordFile: stage.passwordFile,
    env,
    logger: stage.logger,
    run: stage.run,
  }
}

/** 设置键 `exclude` 的规则转成 restic 的 `--exclude` 参数对，追加在基线 `--exclude-file` 之上；`#` 注释行不进 argv。 */
export function excludeArgv(rules: readonly string[]): string[] {
  const argv: string[] = []
  for (const rule of rules) {
    const trimmed = rule.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    argv.push('--exclude', trimmed)
  }
  return argv
}

/** 跑一次 `restic backup` 要的参数。本地那次与 OSS 那次只差仓库地址与 env。 */
type BackupRunArgs = {
  exe: string
  sources: string[]
  /** 内置基线 exclude 文件（`--exclude-file`）。 */
  excludeFile: string
  /** 设置键 `exclude` 的追加规则（逐条 `--exclude`）。 */
  excludeArgs: string[]
  passwordFile: string
  env: NodeJS.ProcessEnv
  logger: Logger
  run: RunProcess
  /** 拿来当基准的快照 ID（`--parent`）；`undefined` = 交给 restic 自己挑。 */
  parentId?: string | undefined
}

/** 本地那次：仓库地址由调用方给（`repositories.local.repo`）。 */
type LocalBackupArgs = BackupRunArgs & { repo: string; now: () => Date }

/** 一次 `restic backup` 的 argv：基线 `--exclude-file` + 追加的 `--exclude` + 可选 `--parent` + 源路径。 */
export function backupArgv(
  args: Pick<BackupRunArgs, 'excludeFile' | 'excludeArgs' | 'parentId' | 'sources'>,
): string[] {
  return [
    'backup',
    `--exclude-file=${args.excludeFile}`,
    ...args.excludeArgs,
    ...(args.parentId === undefined ? [] : ['--parent', args.parentId]),
    ...args.sources,
  ]
}

/** 跑一次，原样启动进程——不判成败、不写契约行。 */
async function backupOnce(args: BackupRunArgs & { repo: string }, parentId: string | undefined): Promise<RunResult> {
  return runRestic(args.exe, args.repo, backupArgv({ ...args, parentId }), {
    passwordFile: args.passwordFile,
    env: args.env,
    timeoutMs: BACKUP_TIMEOUT_MS,
    run: args.run,
  })
}

/**
 * 跑一次，restic 说父快照用不了（只认 `parentUnusable` 那两句原话）就丢开它重跑一次；两次的原始输出都进日志。
 * 重跑前写的是普通说明行 `parentDroppedLine`，不是失败契约行。
 */
async function backupWithParentFallback(args: BackupRunArgs & { repo: string }): Promise<RunResult> {
  const first = await backupOnce(args, args.parentId)
  args.logger.raw(first.stdout)
  args.logger.raw(first.stderr)
  if (first.code === 0 || args.parentId === undefined || !parentUnusable(first.stdout, first.stderr)) {
    return first
  }
  args.logger.line(parentDroppedLine(args.parentId))
  const second = await backupOnce(args, undefined)
  args.logger.raw(second.stdout)
  args.logger.raw(second.stderr)
  return second
}

/** 单次本地备份。成功路径必须写 `BACKUP_OK` 契约行。 */
export async function doLocalBackup(args: LocalBackupArgs): Promise<LocalOutcome> {
  const startedAtMs = args.now().getTime()
  const result = await backupWithParentFallback(args)
  const ok = result.code === 0
  if (ok) args.logger.line(BACKUP_OK)
  else args.logger.line(failedLine('Backup', result.code))
  return {
    ok,
    snapshotId: ok ? parseSnapshotId(result.stdout) : null,
    size: ok ? parseProcessedSize(result.stdout) : null,
    durationSeconds: (args.now().getTime() - startedAtMs) / 1000,
  }
}

type PruneArgs = {
  exe: string
  repo: string
  retention: BackupConfig['retention']
  /** `Prune` 或 `OSS prune`——两组契约行只差这个标签。 */
  label: string
  passwordFile: string
  env: NodeJS.ProcessEnv
  logger: Logger
  run: RunProcess
}

/**
 * 对某个仓库跑 forget+prune。先 `restic unlock`（只删陈旧锁）：被打断的 backup 留下的锁会让要排他锁的 prune 失败。
 * unlock 的输出原样进日志，成败交给紧接着的 prune 判。
 */
export async function doPrune(args: PruneArgs): Promise<boolean> {
  args.logger.line(startedLine(args.label))
  const unlock = await runRestic(args.exe, args.repo, ['unlock'], {
    passwordFile: args.passwordFile,
    env: args.env,
    run: args.run,
  })
  args.logger.raw(unlock.stdout)
  args.logger.raw(unlock.stderr)
  const result = await runRestic(args.exe, args.repo, pruneArgs(args.retention), {
    passwordFile: args.passwordFile,
    env: args.env,
    timeoutMs: BACKUP_TIMEOUT_MS,
    run: args.run,
  })
  args.logger.raw(result.stdout)
  args.logger.raw(result.stderr)
  const ok = result.code === 0
  if (ok) args.logger.line(completedLine(args.label))
  else args.logger.line(failedLine(args.label, result.code))
  return ok
}

/** OSS 那次：仓库地址自己拼（`ossRepoUrl`），因为它同时要进日志那句话。 */
type OssPushArgs = BackupRunArgs & {
  oss: BackupConfig['repositories']['oss']
  now: () => Date
}

/** OSS 推送：第二次独立的 `restic backup`，直接写 `s3:` 仓库。成功路径必须写 `OSS_PUSH_OK` 契约行。 */
export async function doOssPush(args: OssPushArgs): Promise<OssOutcome> {
  const repo = ossRepoUrl(args.oss)
  args.logger.line(ossPushStartedLine(repo))
  const startedAtMs = args.now().getTime()
  const result = await backupWithParentFallback({ ...args, repo })
  const ok = result.code === 0
  if (ok) args.logger.line(OSS_PUSH_OK)
  else args.logger.line(failedLine('OSS push', result.code))
  return {
    ok,
    repo,
    durationSeconds: (args.now().getTime() - startedAtMs) / 1000,
    snapshotId: ok ? parseSnapshotId(result.stdout) : null,
  }
}

/** 秒数格式化成 `M:SS`。 */
export function formatDuration(totalSeconds: number): string {
  const wholeSeconds = Math.max(0, Math.trunc(totalSeconds))
  return `${Math.trunc(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, '0')}`
}

/**
 * 通知文案：本地失败 → FAILED；本地成 + OSS 关 / OSS 也成 → OK；本地成 + OSS 失败 → partial。
 * 失败那条把日志路径写进通知，收到通知的人下一步就是去看日志。
 */
export function buildNotification(
  local: LocalOutcome,
  oss: OssOutcome | null,
  ossEnabled: boolean,
  logFile: string,
): Notification {
  if (!local.ok) {
    return { title: 'Restic Backup FAILED', body: `Local backup exit code non-zero - see ${logFile}` }
  }
  const parts: string[] = []
  if (local.size) parts.push(local.size)
  parts.push(`local ${formatDuration(local.durationSeconds)}`)
  if (ossEnabled && oss !== null) {
    parts.push(oss.ok ? `OSS ${formatDuration(oss.durationSeconds)}` : 'OSS FAILED')
  }
  const allOk = !ossEnabled || oss === null || oss.ok
  return {
    title: allOk ? 'Restic Backup OK' : 'Restic Backup partial - OSS push FAILED',
    body: parts.join(' | '),
  }
}
