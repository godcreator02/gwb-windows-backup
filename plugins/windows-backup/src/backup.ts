import { localTimestamp } from './clock.js'
import type { BackupConfig } from './config.js'
import { resolveResticExe } from './config.js'
import type { BackupSecrets } from './credentials.js'
import { acquire, HEARTBEAT_MS, type HeldLock } from './lock.js'
import type { Logger } from './log.js'
import type { BackupPaths } from './paths.js'
import { BACKUP_TIMEOUT_MS, runProcess } from './process.js'
import type { RunProcess, RunResult } from './process.js'
import { ossRepoUrl, parentUnusable, parseProcessedSize, parseSnapshotId, pruneArgs, resticEnv, runRestic } from './restic.js'
import { readState, shouldRunPrune, writeState } from './state.js'
import { sendToast } from './toast.js'

/** 一次 `restic backup`（本地那次或 OSS 那次）的结果。 */
export type StageOutcome = {
  ok: boolean
  /** 这一次存进仓库的快照 ID——记进 state 给下一轮当父快照。解析不出是 `null`。 */
  snapshotId: string | null
  /** restic 报的处理量，如 `4.9 KiB`。 */
  size: string | null
  durationSeconds: number
}

export type Notification = { title: string; body: string }

/** 真跑完了一轮的那种结果。 */
export type CompletedBackupResult = {
  /** 整条链路的结论：本地成 + （OSS 关或 OSS 成）。 */
  ok: boolean
  skipped: null
  local: StageOutcome
  /** OSS 关着 / 本地就失败了都是 `null`。 */
  oss: StageOutcome | null
  notification: Notification
}

/** 没跑成的那种：别人占着锁。不写日志、不弹 toast、不动 `state.json`。 */
export type SkippedBackupResult = { ok: false; skipped: 'locked' }

export type FullBackupResult = CompletedBackupResult | SkippedBackupResult

export type BackupContext = {
  credentials: BackupSecrets
  paths: BackupPaths
  config: BackupConfig
  logger: Logger
  /** 启动子进程的函数，测试传假的。 */
  run?: RunProcess | undefined
  /** 报时，测试传固定时刻。 */
  now?: (() => Date) | undefined
  /** 占锁，回 `null` = 占不到。测试用它造「另一轮正在跑」。 */
  acquireLock?: ((file: string) => HeldLock | null) | undefined
}

/** 一轮里各段都要的那几样。 */
type Round = {
  credentials: BackupSecrets
  paths: BackupPaths
  config: BackupConfig
  logger: Logger
  run: RunProcess
  now: () => Date
  exe: string
}

/**
 * 全流程一次。子进程失败都写进日志与返回值，调用方拿 `ok` / `skipped` 判。
 * 起手先占数据目录里的 `backup.lock`，占不到直接回 `{ ok: false, skipped: 'locked' }`，一个字都不往日志里写。
 */
export async function runFullBackup(ctx: BackupContext): Promise<FullBackupResult> {
  const acquireLock = ctx.acquireLock ?? ((file: string) => acquire(file))
  const held = acquireLock(ctx.paths.lockFile)
  if (held === null) return { ok: false, skipped: 'locked' }
  const heartbeat = setInterval(() => held.renew(), HEARTBEAT_MS)
  try {
    return await runLocked({
      credentials: ctx.credentials,
      paths: ctx.paths,
      config: ctx.config,
      logger: ctx.logger,
      run: ctx.run ?? runProcess,
      now: ctx.now ?? (() => new Date()),
      exe: resolveResticExe(ctx.config.resticExe, ctx.paths.dir),
    })
  } finally {
    clearInterval(heartbeat)
    held.release()
  }
}

/** 锁在手之后的那一整条链路：本地备份 →（本地成了）每日 prune → OSS 备份与 OSS prune → 轮转日志 → 把结论写进 state.json → 通知。 */
async function runLocked(round: Round): Promise<CompletedBackupResult> {
  const { paths, config, logger } = round
  // 父快照与 prune 日期在开跑前取一次：这一轮会把自己的结果写回 state，边跑边读就读到本轮的
  const stateBeforeThisRun = readState(paths.stateFile)
  const pruneDue = shouldRunPrune(stateBeforeThisRun, round.now())

  logger.line('Backup started')
  const localEnv = resticEnv(config.gomaxprocs)
  const local = await backUp(round, config.localRepo, localEnv, stateBeforeThisRun.lastLocalSnapshot, 'Backup')
  // 成了就立刻记下快照 ID，后面几段失败也不影响下一轮用它当父快照
  if (local.ok && local.snapshotId !== null) writeState(paths.stateFile, { lastLocalSnapshot: local.snapshotId })

  let oss: StageOutcome | null = null
  if (local.ok) {
    if (pruneDue && (await prune(round, config.localRepo, localEnv, 'Prune'))) {
      writeState(paths.stateFile, { lastPrune: localTimestamp(round.now()) })
    }
    if (config.ossEnabled) oss = await backUpToOss(round, stateBeforeThisRun.lastOssSnapshot, pruneDue)
  }

  logger.rotate()

  const notification = buildNotification(local, oss, paths.logFile)
  const ok = local.ok && (oss === null || oss.ok)
  // 成败都记：只在成功时记，连着失败三天看起来会像「三天前刚备过」
  writeState(paths.stateFile, { lastRunAt: localTimestamp(round.now()), lastRunOk: ok, lastRunSummary: notification.body })

  if (config.toast) await sendToast(notification.title, notification.body, logger, round.run)

  return { ok, skipped: null, local, oss, notification }
}

/** OSS 那次：第二次独立的 `restic backup`，直接写 `s3:` 仓库；成了记下快照 ID，本轮该 prune 就对 OSS 仓也跑一次。 */
async function backUpToOss(round: Round, parentId: string | undefined, pruneDue: boolean): Promise<StageOutcome> {
  const { paths, config, logger } = round
  const repo = ossRepoUrl(config)
  const credentials = round.credentials.ossEnv
  if (!credentials.AWS_ACCESS_KEY_ID || !credentials.AWS_SECRET_ACCESS_KEY) {
    logger.line('OSS push FAILED: 本 home 的 OSS 凭据未配置')
    return { ok: false, snapshotId: null, size: null, durationSeconds: 0 }
  }
  logger.line(`OSS push started (${repo})`)
  const env = resticEnv(config.gomaxprocs, credentials)
  const pushed = await backUp(round, repo, env, parentId, 'OSS push')
  if (pushed.ok && pushed.snapshotId !== null) writeState(paths.stateFile, { lastOssSnapshot: pushed.snapshotId })
  if (pruneDue && pushed.ok) await prune(round, repo, env, 'OSS prune')
  return pushed
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

/** 一次 `restic backup` 的 argv：基线 `--exclude-file` + 追加的 `--exclude` + 可选 `--parent` + 源路径。 */
export function backupArgv(round: Pick<Round, 'paths' | 'config'>, parentId: string | undefined): string[] {
  return [
    'backup',
    `--exclude-file=${round.paths.defaultExcludeFile}`,
    ...excludeArgv(round.config.exclude),
    ...(parentId === undefined ? [] : ['--parent', parentId]),
    ...round.config.sources,
  ]
}

/**
 * 对一个仓库跑一次 `restic backup`，结束写一行 `<label> completed successfully` 或 `<label> FAILED with exit code N`。
 * restic 说父快照用不了（只认 `parentUnusable` 那两句原话）就丢开它重跑一次，两次输出都在凭据遮挡后进日志。
 */
async function backUp(round: Round, repo: string, env: NodeJS.ProcessEnv, parentId: string | undefined, label: string): Promise<StageOutcome> {
  const startedAtMs = round.now().getTime()
  let result = await backUpOnce(round, repo, env, parentId)
  if (result.code !== 0 && parentId !== undefined && result.parentUnusable) {
    round.logger.line(`parent snapshot ${parentId} 不可用，丢开父本重跑一轮（本轮没有基准，会重读全部文件）`)
    result = await backUpOnce(round, repo, env, undefined)
  }
  const ok = result.code === 0
  round.logger.line(ok ? `${label} completed successfully` : `${label} FAILED with exit code ${String(result.code)}`)
  return {
    ok,
    snapshotId: ok ? result.snapshotId : null,
    size: ok ? result.size : null,
    durationSeconds: (round.now().getTime() - startedAtMs) / 1000,
  }
}

async function backUpOnce(round: Round, repo: string, env: NodeJS.ProcessEnv, parentId: string | undefined): Promise<RunResult & { snapshotId: string | null; size: string | null; parentUnusable: boolean }> {
  const facts = { snapshotId: null as string | null, size: null as string | null, parentUnusable: false }
  const result = await runRestic(round.exe, repo, backupArgv(round, parentId), {
    password: round.credentials.password,
    env,
    timeoutMs: BACKUP_TIMEOUT_MS,
    run: round.run,
    inspectOutput: (stdout, stderr) => {
      facts.snapshotId = parseSnapshotId(stdout)
      facts.size = parseProcessedSize(stdout)
      facts.parentUnusable = parentUnusable(stdout, stderr)
    },
  })
  round.logger.raw(result.stdout)
  round.logger.raw(result.stderr)
  return { ...result, ...facts }
}

/**
 * 对某个仓库跑 forget+prune，回成没成。先 `restic unlock`（只删陈旧锁）：被打断的 backup 留下的锁会让要排他锁的 prune 失败。
 * unlock 的输出在凭据遮挡后进日志，成败交给紧接着的 prune 判。
 */
async function prune(round: Round, repo: string, env: NodeJS.ProcessEnv, label: string): Promise<boolean> {
  const { logger } = round
  const options = { password: round.credentials.password, env, run: round.run }
  logger.line(`${label} started`)
  const unlock = await runRestic(round.exe, repo, ['unlock'], options)
  logger.raw(unlock.stdout)
  logger.raw(unlock.stderr)
  const result = await runRestic(round.exe, repo, pruneArgs(round.config), { ...options, timeoutMs: BACKUP_TIMEOUT_MS })
  logger.raw(result.stdout)
  logger.raw(result.stderr)
  const ok = result.code === 0
  logger.line(ok ? `${label} completed successfully` : `${label} FAILED with exit code ${String(result.code)}`)
  return ok
}

/** 秒数格式化成 `M:SS`。 */
export function formatDuration(totalSeconds: number): string {
  const wholeSeconds = Math.max(0, Math.trunc(totalSeconds))
  return `${String(Math.trunc(wholeSeconds / 60))}:${String(wholeSeconds % 60).padStart(2, '0')}`
}

/**
 * 通知文案：本地失败 → FAILED；本地成 + OSS 关 / OSS 也成 → OK；本地成 + OSS 失败 → partial。
 * 失败那条把日志路径写进通知，收到通知的人下一步就是去看日志。
 */
export function buildNotification(local: StageOutcome, oss: StageOutcome | null, logFile: string): Notification {
  if (!local.ok) {
    return { title: 'Restic Backup FAILED', body: `Local backup exit code non-zero - see ${logFile}` }
  }
  const parts: string[] = []
  if (local.size !== null) parts.push(local.size)
  parts.push(`local ${formatDuration(local.durationSeconds)}`)
  if (oss !== null) parts.push(oss.ok ? `OSS ${formatDuration(oss.durationSeconds)}` : 'OSS FAILED')
  return {
    title: oss === null || oss.ok ? 'Restic Backup OK' : 'Restic Backup partial - OSS push FAILED',
    body: parts.join(' | '),
  }
}
