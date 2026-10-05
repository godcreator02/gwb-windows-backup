import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isRecord } from './vocab.js'
import type { GwbContext } from '@godcreator/gwb-kernel-desktop'
// 空的类型 import 只为让这几个包的 `declare module 'cordis'` 生效，ctx 上才有 timer 与各服务的类型
import type {} from '@cordisjs/plugin-timer'
import type { GwbCommands } from '@godcreator/gwb-commands'
import type { GwbDataApi } from '@godcreator/gwb-data'
import type { GwbSettingsApi } from '@godcreator/gwb-settings'
import type { GwbShellApi } from '@godcreator/gwb-shell'
import { runFullBackup } from './backup.js'
import { localDate } from './clock.js'
import type { BackupConfig } from './config.js'
import { ossConfigured, readConfig, refuseReason, resolveResticExe, SETTINGS } from './config.js'
import { BackupCredentials, type BackupSecrets } from './credentials.js'
import type { DiskFree, SnapshotReading } from './health.js'
import { assessHealth, dueReminders, readLatestSnapshot } from './health.js'
import { activeLock } from './lock.js'
import { createLogger } from './log.js'
import { homeRecoveryFiles, layout } from './paths.js'
import type { BackupPaths } from './paths.js'
import { BACKUP_TIMEOUT_MS } from './process.js'
import type { RunProcess } from './process.js'
import { ossRepoUrl, resticEnv, runRestic } from './restic.js'
import { backupIsDue, nextRunAt, readState, writeState } from './state.js'

/** 模块被重新 import 的时刻，必须在入口模块顶层取：status 里带着它，没变就是新代码没加载上。 */
const MODULE_LOADED_AT = new Date().toISOString()

/** 运行时名字 = cordis.yml 条目里的包名，与数据目录的归属对得上。 */
export const name = 'gwb-windows-backup'

/** 命令登记的 plugin 字段写完整包名，跟运行时名字是两回事。 */
const PKG = '@godcreator/gwb-windows-backup'

/** 浏览器侧与样式表的地址，注册窗格时报给外壳。构建产物里它们与本模块同在 `dist/` 下。 */
const CLIENT_URL = new URL('./client.js', import.meta.url).href
const STYLE_URL = new URL('./style.css', import.meta.url).href

/** 顶层注入是等待语义：缺哪个整个插件停在等待。外壳不在这里，走 `mount` 末尾的局部注入。 */
export const inject = ['gwbCommands', 'gwbSettings', 'gwbData', 'timer']

/** 定时那一跳的间隔：每跳现读设置，问「该跑下一轮了吗」。第一跳在加载一分钟后，那时别的插件都起完了。 */
const TICK_MS = 60_000

/** 加载需要的最小宿主形状。生产实现是 `GwbContext`，测试传入替身。 */
export interface HostContext {
  /** cordis 的 effect 要求 setup 返回一个注销函数。 */
  effect(setup: () => () => void): void
  inject<T extends Record<string, unknown>>(deps: readonly string[], callback: (scoped: HostContext & T) => void): void
  /** 官方 timer 插件加到 ctx 上的方法（服务名 `timer`）。 */
  interval(callback: () => void, ms: number): () => void
  logger: {
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
  }
  gwbCommands: Pick<GwbCommands, 'register'>
  gwbSettings: Pick<GwbSettingsApi, 'define' | 'get' | 'set'>
  gwbData: Pick<GwbDataApi, 'dir'>
}

/** 跑一轮备份的函数。生产实现是 `runFullBackup`（会启动好几个 restic 子进程），测试传入替身。 */
export type BackupRunner = (paths: BackupPaths, config: BackupConfig, credentials: BackupSecrets) => Promise<{ ok: boolean; skipped: 'locked' | null }>

/** 加载时可换掉的两样：跑一轮备份、启动子进程（读快照与透传命令用）。测试用它把真 restic 换成替身。 */
export type MountDeps = {
  runBackup: BackupRunner
  run?: RunProcess | undefined
  /** 读磁盘余量；不给就用 `fs.statfs`。 */
  diskFree?: DiskFree | undefined
}

/** 生产实现：整条备份链路，结论收成两个字段。 */
const realBackup: BackupRunner = async (paths, config, credentials) => {
  const result = await runFullBackup({ paths, config, credentials, logger: createLogger(paths.logFile) })
  return { ok: result.ok, skipped: result.skipped }
}

/**
 * 从插件包根的 package.json 读版本。本模块在 `dist/index.js`，包根在上一层（`'../package.json'`）。
 * loader 可能带查询串 import 本模块，`createRequire` 拿那种 URL 解析相对路径会抛错，先去掉 `?` 后面那段。
 */
function pluginVersion(): string {
  const require = createRequire(import.meta.url.split('?')[0] ?? import.meta.url)
  return (require('../package.json') as { version: string }).version
}

export function apply(ctx: GwbContext): void {
  // GwbContext 带着 HostContext 要的全部成员，但泛型自指的结构检查过不去，显式收窄一次
  mount(ctx as unknown as HostContext, { runBackup: realBackup })
}

/** 一轮备份的四种结局。`failed` 时 state 已写进本轮的失败，不会拿上一轮的成功当本轮结论。 */
type RoundOutcome = { kind: 'done' } | { kind: 'failed' } | { kind: 'locked' } | { kind: 'refused'; reason: string }

/** `mount` 里各部分共用的运行时：跑备份、读快照、给命令回的状态。 */
interface BackupRuntime {
  credentials: BackupCredentials
  paths: BackupPaths
  /** 现读设置；值不合法就抛错。 */
  currentConfig(): BackupConfig
  runBackup(reason: string): Promise<RoundOutcome>
  refreshSnapshotReading(config: BackupConfig): Promise<void>
  tick(): void
  backupInfo(): Record<string, unknown>
  snapshot(): Record<string, unknown>
}

/** 全部加载动作。`apply` 只负责传入生产实现，拆成两层是为了测试换掉会启动子进程的那几样。 */
export function mount(ctx: HostContext, deps: MountDeps): void {
  mkdirSync(ctx.gwbData.dir, { recursive: true })
  const version = pluginVersion()
  const runtime = createBackupRuntime(ctx, deps, layout(ctx.gwbData.dir), version)

  declareSettings(ctx)
  registerCommands(ctx, deps, runtime)
  ctx.effect(() => ctx.interval(() => runtime.tick(), TICK_MS))
  registerPaneWhenShellIsPresent(ctx)

  ctx.logger.info(`gwb-windows-backup 已挂载 ${version}：每分钟看一次该不该跑下一轮，结论看 windows-backup.status`)
}

function createBackupRuntime(ctx: HostContext, deps: MountDeps, paths: BackupPaths, version: string): BackupRuntime {
  const credentials = new BackupCredentials(ctx.gwbSettings, paths)
  ctx.effect(() => () => credentials.dispose())
  void credentials.initialize().catch(() => ctx.logger.warn('备份凭据迁移未完成；旧文件保留，运行命令会返回原因'))
  const log = ctx.logger
  const currentConfig = (): BackupConfig => readConfig((key) => ctx.gwbSettings.get(key))

  // 只在这一次 mount 的闭包里：重新加载就清零，要跨进程保留的在 state.json
  let snapshotReading: SnapshotReading | null = null
  /** 上一次写进日志的拒跑理由：每分钟一跳，同一句理由只写一次。 */
  let lastLoggedRefusal: string | null = null

  const logRefusalOnce = (reason: string): void => {
    if (reason === lastLoggedRefusal) return
    lastLoggedRefusal = reason
    log.info(`不跑定时备份：${reason}`)
  }

  const refreshSnapshotReading = async (config: BackupConfig): Promise<void> => {
    try {
      snapshotReading = await readLatestSnapshot(paths, config, deps.run, new Date(), await credentials.read(false))
    } catch {
      snapshotReading = { readAt: new Date().toISOString(), latestAt: null, unreadable: '本 home 凭据未配置或迁移未完成' }
    }
  }

  const refreshSnapshotReadingInBackground = (config: BackupConfig): void => {
    refreshSnapshotReading(config).catch((error: unknown) => log.warn('读仓库快照没读完：', messageOf(error)))
  }

  /** 跑一轮备份。**绝不抛**：定时与命令两条路径都调它。同一时间只能有一轮，由 `runFullBackup` 占的 `backup.lock` 保证。 */
  const runBackup = async (reason: string): Promise<RoundOutcome> => {
    let config: BackupConfig
    try {
      config = currentConfig()
    } catch (error) {
      return { kind: 'refused', reason: messageOf(error) }
    }
    const refused = refuseReason(config)
    if (refused !== null) return { kind: 'refused', reason: refused }

    lastLoggedRefusal = null
    log.info(`${reason}备份开始`)
    try {
      let secrets = await credentials.read(false)
      if (config.ossEnabled) {
        try { secrets = await credentials.read(true) } catch { log.warn('本 home 的 OSS 凭据不可用；本地备份继续，OSS 阶段会记为失败') }
      }
      const result = await deps.runBackup(paths, config, secrets)
      if (result.skipped === 'locked') {
        log.info(`${reason}备份跳过：另一轮正在跑（数据目录的 backup.lock 被占着）`)
        return { kind: 'locked' }
      }
      const summary = readState(paths.stateFile).lastRunSummary ?? '（没有小结）'
      if (result.ok) log.info(`${reason}备份完成：${summary}`)
      else log.warn(`${reason}备份失败：${summary}——日志在 ${paths.logFile}`)
      return result.ok ? { kind: 'done' } : { kind: 'failed' }
    } catch (error) {
      const message = messageOf(error)
      log.warn(`${reason}备份没跑完（下一轮照跑）：`, message)
      recordUnfinishedRun(paths.stateFile, message, log)
      return { kind: 'failed' }
    } finally {
      refreshSnapshotReadingInBackground(config)
    }
  }

  /** 每分钟一跳：正在跑就不管；到期了就跑一轮；没到期而且还没读过仓库，就读一次。 */
  const tick = (): void => {
    if (activeLock(paths.lockFile) !== null) return
    let config: BackupConfig
    try {
      config = currentConfig()
    } catch (error) {
      logRefusalOnce(messageOf(error))
      return
    }
    if (backupIsDue(readState(paths.stateFile).lastRunAt, config.frequencyMinutes, new Date())) {
      void runBackup('定时').then((outcome) => {
        if (outcome.kind === 'refused') logRefusalOnce(outcome.reason)
      })
      return
    }
    if (snapshotReading === null) refreshSnapshotReadingInBackground(config)
  }

  /** 备份部分的状态。`status` 的 `backup` 字段与 `run` 命令的回执都用它。设置读不出时周期与下次时间是 `null`。 */
  const backupInfo = (): Record<string, unknown> => {
    const disk = readState(paths.stateFile)
    const lock = activeLock(paths.lockFile)
    let frequencyMinutes: number | null = null
    try {
      frequencyMinutes = currentConfig().frequencyMinutes
    } catch {
      // 设置读不出的原因由 status 的 refuseReason 报，这里只是没有周期可算
    }
    return {
      frequencyMinutes,
      running: lock !== null,
      /** 这一轮是从什么时候开始的（`backup.lock` 的 `startedAt`，ISO）；没在跑是 `null`。 */
      runningSince: lock?.startedAt ?? null,
      lastRunAt: disk.lastRunAt ?? null,
      lastRunOk: disk.lastRunOk ?? null,
      lastRunSummary: disk.lastRunSummary ?? null,
      nextRunAt: frequencyMinutes === null ? null : nextRunAt(disk.lastRunAt, frequencyMinutes, new Date()),
    }
  }

  /** 全量状态，每次现算。`health` 为 `null` 是设置读不出、判不了，不是「没问题」。 */
  const snapshot = (): Record<string, unknown> => {
    const now = new Date()
    const state = readState(paths.stateFile)
    let config: BackupConfig | null = null
    let refusal: string | null
    try {
      config = currentConfig()
      refusal = refuseReason(config)
    } catch (error) {
      refusal = messageOf(error)
    }
    return {
      version,
      moduleLoadedAt: MODULE_LOADED_AT,
      dataDir: paths.dir,
      refuseReason: refusal,
      backup: backupInfo(),
      health: config === null ? null : assessHealth({ state, config, snapshots: snapshotReading, now, diskFree: deps.diskFree }),
      reminders: config === null ? [] : dueReminders(state, config, now),
    }
  }

  return { paths, credentials, currentConfig, runBackup, refreshSnapshotReading, tick, backupInfo, snapshot }
}

/**
 * 本轮抛错时把失败记进 state：不记的话 state 里还留着上一轮的结论，命令读到的就是上一轮的成功。
 * 写不进（磁盘满等）只记日志，命令层照样按本轮失败回执，不读 state。
 */
function recordUnfinishedRun(stateFile: string, message: string, log: HostContext['logger']): void {
  try {
    writeState(stateFile, { lastRunOk: false, lastRunSummary: `本轮没跑完：${message}` })
  } catch (error) {
    log.warn('本轮失败想记进 state 也没记成——命令层将按本轮失败回执，不信 state：', messageOf(error))
  }
}

function declareSettings(ctx: HostContext): void {
  ctx.effect(() => {
    const undefineAll = SETTINGS.map((spec) =>
      ctx.gwbSettings.define({ key: spec.key, title: spec.title, type: spec.type, description: spec.description, default: spec.default }),
    )
    return () => {
      for (const undefine of undefineAll) undefine()
    }
  })
}

/** 六条命令，每条一个 effect：某条登记时名字冲突不连累别的几条。 */
function registerCommands(ctx: HostContext, deps: MountDeps, runtime: BackupRuntime): void {
  ctx.effect(() => ctx.gwbCommands.register(
    {
      name: 'windows-backup.run',
      description: '立刻跑一轮完整备份（和定时触发的那轮做同样的事），等它跑完才回执。另一轮正在跑会如实说；设置没填全或不合法回拒跑理由',
      usage:
        '无参数。跑成回 { ok: true, data: { frequencyMinutes, running, runningSince, lastRunAt, lastRunOk, lastRunSummary, nextRunAt } }；' +
        '本轮失败回 { ok: false, error, data: <同上> }；另一轮正在跑、设置没填全或不合法回 { ok: false, error }',
      effect: 'external',
      plugin: PKG,
    },
    () => runCommandReply(runtime),
  ))

  ctx.effect(() => ctx.gwbCommands.register(
    {
      name: 'windows-backup.check',
      description: '立刻读一次本地仓库的最新快照（启动一次 restic），回全量状态（窗格显示的就是这份）',
      usage: '无参数。回 { ok: true, data: <与 windows-backup.status 的 data 同形> }；设置读不出时不读仓库，照样回当前状态',
      effect: 'read',
      plugin: PKG,
    },
    async () => {
      let config: BackupConfig | null = null
      try {
        config = runtime.currentConfig()
      } catch {
        // 设置不合法：不读仓库，status 里的 refuseReason 会说明哪一项不对
      }
      if (config !== null) await runtime.refreshSnapshotReading(config)
      return { ok: true, data: runtime.snapshot() }
    },
  ))

  ctx.effect(() => ctx.gwbCommands.register(
    {
      name: 'windows-backup.status',
      description: '回全量状态：上次备份、三项健康结论、到期的人工维护、拒跑理由。每次现算，窗格轮询的就是它',
      usage:
        '无参数。回 { ok: true, data: { version, moduleLoadedAt, dataDir, refuseReason: string | null（null = 设置齐全、可以跑）, ' +
        'backup: { frequencyMinutes, running, runningSince, lastRunAt, lastRunOk, lastRunSummary, nextRunAt }, ' +
        'health: { ok, problems: string[], items: { lastRun, disk, snapshots } } | null（null = 设置不合法、判不了）, ' +
        'reminders: [{ what: "usb-copy" | "exclude-audit" | "review", days: number | null, message }]（只列到期的） } }',
      effect: 'read',
      plugin: PKG,
    },
    () => ({ ok: true, data: runtime.snapshot() }),
  ))

  ctx.effect(() => ctx.gwbCommands.register(
    {
      name: 'windows-backup.paths',
      description: '回数据目录、日志和旧恢复材料的路径；当前凭据状态用 credentials.status 查询',
      usage: '无参数。回 { ok: true, data: { dataDir, stateFile, lockFile, legacyRecoveryDir, legacyPasswordFile, legacyOssCredentialsFile, credentialKeys, homeRecoveryFiles, defaultExcludeFile, binDir, logFile } }；旧文件仅供独立恢复，运行时不回退读取；homeRecoveryFiles 是白名单配置指引（仅添加实际存在的文件）。',
      effect: 'read',
      plugin: PKG,
    },
    () => ({ ok: true, data: pathsReply(runtime.paths) }),
  ))

  ctx.effect(() => ctx.gwbCommands.register(
    {
      name: 'windows-backup.restic',
      description: '透传一条 restic 命令，自动补 --repo 并注入当前 home 的凭据。密钥不出现在参数里',
      usage:
        '{ repo?: "local" | "oss"（缺省 local）, args?: string[]（原样传给 restic），如 { "repo": "local", "args": ["snapshots"] } }。' +
        '回 { ok: <退出码为 0>, data: { code, timedOut, stdout, stderr }, error?（退出码非 0 时为 stderr，stderr 为空则「退出码 N」）}；' +
        'repo 或 args 形状不对、设置不合法、OSS 没配全或凭据文件不对回 { ok: false, error }',
      effect: 'external',
      plugin: PKG,
    },
    (args: unknown) => resticPassThroughReply(args, runtime, deps.run),
  ))

  ctx.effect(() => ctx.gwbCommands.register(
    {
      name: 'windows-backup.mark',
      description: '补记人工维护（USB 离机副本、排除规则审计、人工复核）的日期，到期提醒随之消失',
      usage:
        '{ what 必给："usb-copy" | "exclude-audit" | "review", at?: "YYYY-MM-DD"（缺省今天，本地日期）}。' +
        '回 { ok: true, data: { what, at, lastUsbCopy, lastExcludeAudit, lastReview } }；what 或 at 不对回 { ok: false, error }',
      effect: 'write',
      plugin: PKG,
    },
    (args: unknown) => markReply(args, runtime.paths.stateFile),
  ))
}

/** `windows-backup.run` 的回执。本轮成败只看这一轮的结局，不读 state 里可能是上一轮的 `lastRunOk` 来顶替失败。 */
async function runCommandReply(runtime: BackupRuntime): Promise<Record<string, unknown>> {
  const outcome = await runtime.runBackup('手动')
  switch (outcome.kind) {
    case 'refused':
      return { ok: false, error: outcome.reason }
    case 'locked':
      return { ok: false, error: '另一轮备份正在跑（数据目录的 backup.lock 被占着），稍后再试' }
    case 'failed':
      return { ok: false, error: '本轮备份失败', data: runtime.backupInfo() }
    case 'done':
      return { ok: true, data: runtime.backupInfo() }
  }
}

function pathsReply(paths: BackupPaths): Record<string, unknown> {
  return {
    dataDir: paths.dir,
    stateFile: paths.stateFile,
    lockFile: paths.lockFile,
    legacyRecoveryDir: paths.credentialsDir,
    legacyPasswordFile: paths.passwordFile,
    legacyOssCredentialsFile: paths.ossCredentialsFile,
    credentialKeys: ['restic-password', 'oss-credentials'],
    homeRecoveryFiles: homeRecoveryFiles(paths.dir),
    defaultExcludeFile: paths.defaultExcludeFile,
    binDir: paths.binDir,
    logFile: paths.logFile,
  }
}

/** `windows-backup.restic` 的回执。只有 `repo` 为 `oss` 时才把 AccessKey 解析进子进程 env。 */
async function resticPassThroughReply(args: unknown, runtime: BackupRuntime, run: RunProcess | undefined): Promise<Record<string, unknown>> {
  const body = args === undefined ? {} : args
  if (!isRecord(body)) return { ok: false, error: '参数要是对象：{ repo?, args? }' }
  const repo = body.repo ?? 'local'
  if (repo !== 'local' && repo !== 'oss') return { ok: false, error: 'repo 只认 "local" 或 "oss"' }
  const resticArgs = body.args ?? []
  if (!Array.isArray(resticArgs) || !resticArgs.every((one) => typeof one === 'string')) {
    return { ok: false, error: 'args 要是字符串数组' }
  }

  let config: BackupConfig
  let credentials: BackupSecrets
  try {
    config = runtime.currentConfig()
    if (repo === 'oss') {
      if (!ossConfigured(config)) return { ok: false, error: 'OSS 还没配全：设置里的 `oss-bucket` 与 `oss-endpoint` 要先填上' }
    }
    credentials = await runtime.credentials.read(repo === 'oss')
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
  const paths = runtime.paths
  const result = await runRestic(resolveResticExe(config.resticExe, paths.dir), repo === 'oss' ? ossRepoUrl(config) : config.localRepo, resticArgs as string[], {
    password: credentials.password,
    env: resticEnv(config.gomaxprocs, credentials.ossEnv),
    timeoutMs: BACKUP_TIMEOUT_MS,
    run,
  })
  return {
    ok: result.code === 0,
    data: { code: result.code, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr },
    error: result.code === 0 ? undefined : result.stderr.trim() || `退出码 ${String(result.code)}`,
  }
}

const MARK_FIELDS = { 'usb-copy': 'lastUsbCopy', 'exclude-audit': 'lastExcludeAudit', review: 'lastReview' } as const

function markReply(args: unknown, stateFile: string): Record<string, unknown> {
  if (!isRecord(args)) return { ok: false, error: '参数要是对象：{ what, at? }' }
  const what = args.what
  if (what !== 'usb-copy' && what !== 'exclude-audit' && what !== 'review') {
    return { ok: false, error: 'what 只认 usb-copy、exclude-audit 或 review' }
  }
  const at = args.at ?? localDate()
  if (typeof at !== 'string' || !isCalendarDate(at)) return { ok: false, error: 'at 要是 YYYY-MM-DD 格式的日期' }
  const merged = writeState(stateFile, { [MARK_FIELDS[what]]: at })
  return { ok: true, data: { what, at, lastUsbCopy: merged.lastUsbCopy ?? null, lastExcludeAudit: merged.lastExcludeAudit ?? null, lastReview: merged.lastReview ?? null } }
}

/** `YYYY-MM-DD` 并且是日历上存在的一天。 */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

/** 局部注入：外壳不在场只是没有窗格，备份照常运行。 */
function registerPaneWhenShellIsPresent(ctx: HostContext): void {
  ctx.inject<{ gwbShell: Pick<GwbShellApi, 'registerPane' | 'describeSelf'> }>(['gwbShell'], (scoped) => {
    scoped.effect(() => {
      const unregisterPane = scoped.gwbShell.registerPane({
        id: 'main',
        title: '备份',
        icon: 'shield-check',
        client: CLIENT_URL,
        style: STYLE_URL,
      })
      const undescribeSelf = scoped.gwbShell.describeSelf({ title: 'Windows 备份', icon: 'shield-check' })
      return () => {
        undescribeSelf()
        unregisterPane()
      }
    })
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
