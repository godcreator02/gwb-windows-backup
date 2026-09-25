/**
 * 全流程备份 = 占锁 → backup → forget+prune（每日一次） → OSS push → OSS prune → 日志轮转
 * → 记 `state.lastRun*` → 可选 toast。
 *
 * 这是定时器每 `frequencyMinutes` 分钟调的那条主体，也是本件唯一「会改动仓库」的路径。
 * 两条触发路（定时那轮 / `windows-backup.run` 命令）**都从这一个函数进**，所以锁开在
 * 这里而不是各调用方各来一把。链路上的顺序与条件逐条照老仓搬：
 *
 * - 本地备份失败就**不往下走**——本地都没成，OSS 推的是同一批源，多半也是同样的失败；
 * - prune 每日一次，且**只有 prune 真成功才记时间戳**，失败的话下一轮还会再试；
 * - OSS prune 跟本地 prune 同节奏（本轮决定要 prune）**且 OSS 推送成功**才跑——往一个刚推
 *   失败的仓库上跑 forget，等于拿不完整的快照集去算保留策略。
 *
 * **OSS push 是第二次独立的 `restic backup`，直接打 `s3:` 仓**——不是从本地仓拷快照，
 * 本地仓与 OSS 仓各自一条独立快照链。凭据只经子进程 env 进、绝不上命令行。
 *
 * 全流程只从 `ctx` 拿依赖（跑进程的、报时的、弹通知的都在 `ctx` 里），测试整条链路不用起
 * 一个真进程。
 */

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
  /** 这一次推进 OSS 仓的快照 ID——记进 state 给下一轮当父本。解析不出是 `null`。 */
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

/**
 * 没跑成的那种：别人占着锁。
 *
 * **不写失败日志、不弹 toast、不动 `state.lastRun*`**——「另一轮正在跑」不是故障，
 * 把它记成一次失败会让健康检查跟着误报。
 */
export type SkippedBackupResult = {
  ok: false
  skipped: 'locked'
  /** 占着锁那一轮是什么时候起的；读不出来是 `null`。 */
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
  /** 注入点：弹通知；给个空函数就是「这轮不通知」。配置里 `toast: false` 时压根不调它。 */
  notify?: ((title: string, body: string) => Promise<unknown>) | undefined
  /** 注入点：父 env。 */
  env?: NodeJS.ProcessEnv | undefined
  /** 注入点：占锁。回 `null` = 占不到。测试用它造「另一轮正在跑」。 */
  acquireLock?: ((file: string) => HeldLock | null) | undefined
}

/**
 * 配置齐不齐、能不能开跑。回一句人话 = 拒跑的理由，回 `null` = 可以跑。
 *
 * 两条路（定时、`windows-backup.run` 命令）共用这一份判据——各写各的迟早有一头忘了改，
 * 而症状是「某条路悄悄跑了一次注定失败的备份」。理由里指的键名是新线设置件里的
 * kebab-case 键（`settings.set` 用它们）。
 */
export function refuseReason(config: BackupConfig): string | null {
  if (config.sources.length === 0) {
    return '还没配备份白名单：用设置把本件的 `sources` 填上（一行一项，如 D:/Notes）。'
  }
  if (config.repositories.local.repo.trim() === '') {
    return '还没配本地仓库：用设置把本件的 `local-repo` 填上（如 D:/Backup/restic-repo）。'
  }
  const oss = config.repositories.oss
  if (oss.enabled && (oss.bucket.trim() === '' || oss.endpoint.trim() === '')) {
    // 开着 OSS 却没配全，每一轮都会多一次注定失败的推送、通知报 partial——当场拒跑更省事
    return (
      'OSS 开着但还没配全：把本件设置里的 `oss-bucket` 与 `oss-endpoint`（完整主机名 ' +
      'oss-cn-*.aliyuncs.com）填上，暂时不用 OSS 就把 `oss-enabled` 关掉。'
    )
  }
  return null
}

/**
 * 全流程一次。**不抛**：任何一段失败都落进日志与返回值，调用方拿 `ok` / `skipped` 判。
 *
 * 起手先占数据目录里的 `backup.lock`：占不到说明另一轮（可能是别的进程）正在跑，当场回
 * `{ ok: false, skipped: 'locked' }`，一个字都不往日志里写。跑完 `finally` 释放。
 */
export async function runFullBackup(ctx: BackupContext): Promise<FullBackupResult> {
  const acquireLock = ctx.acquireLock ?? ((file: string) => acquire(file))
  const held = acquireLock(ctx.paths.lockFile)
  if (held === null) {
    return { ok: false, skipped: 'locked', heldSince: readLockStartedAt(ctx.paths.lockFile) }
  }
  // 心跳：一轮可以合法地串四个六小时上限的子步骤，陈旧判定只认「心跳停了」、不认
  // 「这轮跑了多久」——不跳的话干得久的活任务会被下一轮当死锁抢走
  const beat = setInterval(() => held.renew(), HEARTBEAT_MS)
  try {
    return await runLocked(ctx)
  } finally {
    clearInterval(beat)
    held.release()
  }
}

/** 锁在手之后的那一整条链路。 */
async function runLocked(ctx: BackupContext): Promise<CompletedBackupResult> {
  const { paths, config, logger } = ctx
  const now = ctx.now ?? (() => new Date())
  const run = ctx.run ?? runProcess
  const exe = resolveSlotPath(config.restic.exe, paths.dir)
  const localRepo = config.repositories.local.repo
  const ossEnabled = config.repositories.oss.enabled
  const excludeFile = paths.defaultExcludeFile
  const excludeArgs = excludeArgv(config.exclude)
  const baseEnv = resticEnv(config.restic.gomaxprocs, {}, ctx.env ?? process.env)
  // 父本在开跑前取一次：这一轮跑着的时候 state 会被我们自己的写回改掉，边跑边读会读到
  // 刚写进去的新 ID——那是「本轮的结果」，不是「本轮该用的父本」
  const before = readState(paths.stateFile)

  logger.line(BACKUP_STARTED)
  const local = await doLocalBackup({
    exe,
    repo: localRepo,
    sources: config.sources,
    excludeFile,
    excludeArgs,
    passwordFile: paths.passwordFile,
    env: baseEnv,
    logger,
    run,
    now,
    parentId: before.lastLocalSnapshot,
  })
  // 本地一成当场把 ID 落盘：后面还有 prune / OSS 两段，哪一段把这一轮弄失败都不该让下一轮
  // 赔上一次全量重读
  if (local.ok && local.snapshotId !== null) {
    writeState(paths.stateFile, { lastLocalSnapshot: local.snapshotId })
  }

  let oss: OssOutcome | null = null
  let prunedToday = false

  if (local.ok) {
    const state = readState(paths.stateFile)
    prunedToday = shouldRunPrune(state, now())
    if (prunedToday) {
      const ok = await doPrune({
        exe,
        repo: localRepo,
        retention: config.retention,
        label: PRUNE_LABEL,
        passwordFile: paths.passwordFile,
        env: baseEnv,
        logger,
        run,
      })
      // 只有真成了才记时间戳——失败就让下一轮再试，别把「今天已经 prune 过」的旗子插错
      if (ok) writeState(paths.stateFile, { lastPrune: localTimestamp(now()) })
    }

    if (ossEnabled) {
      const ossEnv = resticEnv(
        config.restic.gomaxprocs,
        readOssEnv(paths.ossCredentialsFile),
        ctx.env ?? process.env,
      )
      oss = await doOssPush({
        exe,
        oss: config.repositories.oss,
        sources: config.sources,
        excludeFile,
        excludeArgs,
        passwordFile: paths.passwordFile,
        env: ossEnv,
        logger,
        run,
        now,
        parentId: before.lastOssSnapshot,
      })
      if (oss.ok && oss.snapshotId !== null) {
        writeState(paths.stateFile, { lastOssSnapshot: oss.snapshotId })
      }
      if (prunedToday && oss.ok) {
        await doPrune({
          exe,
          repo: oss.repo,
          retention: config.retention,
          label: OSS_PRUNE_LABEL,
          passwordFile: paths.passwordFile,
          env: ossEnv,
          logger,
          run,
        })
      }
    }
  }

  logger.rotate(config.logging)

  const notification = buildNotification(local, oss, ossEnabled, paths.logFile)
  const ok = local.ok && (!ossEnabled || (oss?.ok ?? false))

  // 「这台机器上次备份是什么时候、成没成」——健康检查的「上次备份」那一项、开机补跑的
  // 判定、窗格里那行时间，读的都是这三格。**成败都记**：只在成功时记的话，连着失败
  // 三天看起来会像「三天前刚备过」。
  writeState(paths.stateFile, {
    lastRunAt: localTimestamp(now()),
    lastRunOk: ok,
    lastRunSummary: notification.body,
  })

  // toast 是配置里那一格说了算：跑在没人看屏幕的机器上时，每半小时弹一次通知是纯噪音
  if (config.toast) {
    const notify = ctx.notify ?? ((title: string, body: string) => sendToast(title, body, { logger, run }))
    await notify(notification.title, notification.body)
  }

  return { ok, skipped: null, local, oss, prunedToday, notification }
}

/** 占锁失败时回一句「那一轮是什么时候起的」，纯粹为了把话说清楚；读不出来就 `null`。 */
function readLockStartedAt(file: string): string | null {
  return readLock(file)?.startedAt ?? null
}

/**
 * 设置键 `exclude` 的规则转成 restic 的 `--exclude` 参数对。**合并模型**：基线
 * （`--exclude-file`，包内通用垃圾清单）总在生效，这里只追加；`#` 注释行不进 argv。
 */
export function excludeArgv(rules: readonly string[]): string[] {
  const out: string[] = []
  for (const rule of rules) {
    const trimmed = rule.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    out.push('--exclude', trimmed)
  }
  return out
}

/**
 * 跑一趟 `restic backup` 要的全部参数。本地那趟与 OSS 那趟只差仓库地址与 env（OSS 多带
 * 三键 AccessKey），于是两趟共用同一套 argv 拼法与同一条父本回退。
 */
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
  /**
   * 拿来当基准的快照 ID（`--parent`）；`undefined` = 交给 restic 按 `--group-by` 自己挑。
   *
   * 为什么显式给：restic 默认按 `host,paths` 分组挑父快照，**白名单里加了路径就是新组、
   * 挑不着父本**，整份数据重读一遍。给一份父本，新路径当新文件读、老路径照旧吃比对。
   */
  parentId?: string | undefined
}

/** 本地那趟：仓库地址由调用方给（`repositories.local.repo`）。 */
type LocalBackupArgs = BackupRunArgs & { repo: string; now: () => Date }

/**
 * 一趟的 argv。`--parent` 排在源路径之前——restic 的参数与位置参数分开收，插哪儿都认，
 * 排在这儿是为了让日志里「参数在前、源在后」的样子稳定。
 */
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

/** 一趟，原样起进程——不判成败、不写契约行。 */
async function backupOnce(
  args: BackupRunArgs & { repo: string },
  parentId: string | undefined,
): Promise<RunResult> {
  return runRestic(args.exe, args.repo, backupArgv({ ...args, parentId }), {
    passwordFile: args.passwordFile,
    env: args.env,
    timeoutMs: BACKUP_TIMEOUT_MS,
    run: args.run,
  })
}

/**
 * 跑一趟，**父本用不了就丢开它自己重跑一次**；两趟的原始输出都进日志。
 *
 * 为什么要这一跳：父本 ID 记在 `state.json` 里，正常情况下最近一份快照永远在保留窗口内；
 * 但仓库被重建、或者 state 从更早的备份里恢复回来时，那个 ID 在仓库里已经没了——restic
 * 当场硬失败（实测 0.18.1：stderr `no matching ID found for prefix "<id>"`、退出码 1、
 * stdout 空，见 `messages.ts` 的 `parentUnusable`）。**让整轮备份败在一个「只为了提速」的
 * 参数上，比不要这个提速更糟**，所以撞上就重跑一次。
 *
 * 两处刻意的分寸：**只认 restic 那两句原话**（别的失败一个都不重试，照旧按失败收）；
 * **这一跳写的是普通说明行**（`parentDroppedLine`），不是 `Backup FAILED` 契约行——不然
 * 一次正常的自我修复会被健康检查的日志尾判定记成故障。
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

/**
 * 单次本地备份。
 *
 * 成功路径**必须**落 `Backup completed successfully`——验收步骤与健康检查的日志尾判定
 * 都靠 grep 这一串字。
 */
export async function doLocalBackup(args: LocalBackupArgs): Promise<LocalOutcome> {
  const startedAt = args.now().getTime()
  const result = await backupWithParentFallback(args)
  const ok = result.code === 0
  if (ok) args.logger.line(BACKUP_OK)
  else args.logger.line(failedLine('Backup', result.code))
  return {
    ok,
    snapshotId: ok ? parseSnapshotId(result.stdout) : null,
    size: ok ? parseProcessedSize(result.stdout) : null,
    durationSeconds: (args.now().getTime() - startedAt) / 1000,
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
 * 对某个仓库跑 forget+prune。
 *
 * 先 `restic unlock`：它只删陈旧锁（持有进程已不在，或半小时没续期）。被打断的 backup 留下
 * 的非排他锁不挡后续 backup，却让要排他锁的 prune 每天退出码 11（2026-09-25 实测连败两天）。
 * unlock 自己的输出照原样进日志，成败交给紧接着的 prune 判。
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

/** OSS 那趟：仓库地址自己拼（`ossRepoUrl`），因为它同时要进日志那句话。 */
type OssPushArgs = BackupRunArgs & {
  oss: BackupConfig['repositories']['oss']
  now: () => Date
}

/** OSS 推送。成功路径必须落 `OSS push completed successfully`——同本地备份那条契约。 */
export async function doOssPush(args: OssPushArgs): Promise<OssOutcome> {
  const repo = ossRepoUrl(args.oss)
  args.logger.line(ossPushStartedLine(repo))
  const startedAt = args.now().getTime()
  const result = await backupWithParentFallback({ ...args, repo })
  const ok = result.code === 0
  if (ok) args.logger.line(OSS_PUSH_OK)
  else args.logger.line(failedLine('OSS push', result.code))
  return {
    ok,
    repo,
    durationSeconds: (args.now().getTime() - startedAt) / 1000,
    snapshotId: ok ? parseSnapshotId(result.stdout) : null,
  }
}

/** 秒数格式化成 `M:SS`。 */
export function formatDuration(totalSeconds: number): string {
  const whole = Math.max(0, Math.trunc(totalSeconds))
  return `${Math.trunc(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * 通知文案：本地失败 → FAILED；本地成 + OSS 关 / OSS 也成 → OK；本地成 + OSS 失败 → partial。
 *
 * 失败那条把日志路径念出来——收到通知的人下一步就是去看日志，路径写在通知里省一次问。
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
