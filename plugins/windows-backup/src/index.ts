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
import { refuseReason, runFullBackup } from './backup.js'
import type { BackupConfig, FlatConfig } from './config.js'
import { DEFAULT_FLAT, flatToConfig, pickFlat, resolveSlotPath } from './config.js'
import { readOssEnv } from './credentials.js'
import type { HealthReport } from './health.js'
import { runHealthCheck } from './health.js'
import { createLogger } from './log.js'
import { readLock } from './lock.js'
import { layout } from './paths.js'
import type { BackupPaths } from './paths.js'
import { BACKUP_TIMEOUT_MS } from './process.js'
import type { RunProcess } from './process.js'
import { ossRepoUrl, resticEnv, runRestic } from './restic.js'
import { readState, writeState } from './state.js'
import { backupIntervalMsOf, intervalMsOf, shouldCatchUp } from './timers.js'

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

/** 设置插件里的键（kebab-case）→ 平铺配置的字段（camelCase）。 */
const SETTING_KEYS: ReadonlyArray<{
  key: string
  field: keyof FlatConfig
  title: string
  type: 'string' | 'number' | 'boolean' | 'string-list'
  description: string
}> = [
  { key: 'sources', field: 'sources', type: 'string-list', title: '备份白名单', description: '一行一项（如 D:/Notes）。空则不备份' },
  { key: 'exclude', field: 'exclude', type: 'string-list', title: '追加排除规则', description: '一行一条 restic 模式，追加在内置基线（通用垃圾：node_modules、dist、*.tmp、thumbs.db 等）之上、不是整替；# 开头的行是注释' },
  { key: 'local-repo', field: 'localRepo', type: 'string', title: '本地仓库', description: '本地 restic 仓库路径（如 D:/Backup/restic-repo）。留空则不备份' },
  { key: 'oss-enabled', field: 'ossEnabled', type: 'boolean', title: 'OSS 异地副本', description: '开启阿里云 OSS 异地副本。开着但 bucket / endpoint 没填会拒跑' },
  { key: 'oss-bucket', field: 'ossBucket', type: 'string', title: 'OSS bucket', description: 'OSS bucket 名字' },
  { key: 'oss-endpoint', field: 'ossEndpoint', type: 'string', title: 'OSS endpoint', description: '完整主机名（如 oss-cn-beijing.aliyuncs.com），不是地域代号' },
  { key: 'oss-repo-path', field: 'ossRepoPath', type: 'string', title: 'OSS 仓库路径', description: 'OSS 里的仓库路径（bucket 下那一层目录名）' },
  { key: 'frequency-minutes', field: 'frequencyMinutes', type: 'number', title: '备份周期（分钟）', description: '定时备份周期，单位分钟（至少 1）' },
  { key: 'keep-within', field: 'keepWithin', type: 'string', title: '保留窗口', description: 'restic forget 的 --keep-within（如 72h）' },
  { key: 'keep-within-daily', field: 'keepWithinDaily', type: 'string', title: '保留窗口（按日）', description: 'restic forget 的 --keep-within-daily（如 14d）' },
  { key: 'keep-weekly', field: 'keepWeekly', type: 'number', title: '保留周快照数', description: 'restic forget 的 --keep-weekly：留几个周快照' },
  { key: 'keep-monthly', field: 'keepMonthly', type: 'number', title: '保留月快照数', description: 'restic forget 的 --keep-monthly：留几个月快照' },
  { key: 'health-check-interval-hours', field: 'healthCheckIntervalHours', type: 'number', title: '自检间隔（小时）', description: '周期自检间隔，单位小时（要大于 0）' },
  { key: 'toast', field: 'toast', type: 'boolean', title: '结束通知', description: '每轮备份结束弹一条 Windows 通知' },
  { key: 'restic-exe', field: 'resticExe', type: 'string', title: 'restic 位置', description: 'restic.exe 的位置：相对路径按数据目录解析（默认 bin/restic.exe），绝对路径原样用' },
  { key: 'gomaxprocs', field: 'gomaxprocs', type: 'number', title: 'restic 并行度', description: 'restic 的 GOMAXPROCS：调大更快也更吃 CPU' },
  { key: 'review-interval-days', field: 'reviewIntervalDays', type: 'number', title: '复核提醒（天）', description: '多久没人工复核备份就在窗格挂横幅（跑 check、看快照）；复核完 mark review 销账' },
]

/** 加载后多久跑第一次自检与补跑：不在加载时当场跑，那时所有插件都在启动。 */
const FIRST_DELAY_MS = 30_000

/** 加载需要的最小宿主形状。生产实现是 `GwbContext`，测试传入替身。 */
export interface HostContext {
  /** cordis 的 effect 要求 setup 返回一个注销函数。 */
  effect(setup: () => () => void): void
  inject<T extends Record<string, unknown>>(deps: readonly string[], callback: (scoped: HostContext & T) => void): void
  /** 官方 timer 插件加到 ctx 上的两个方法（服务名 `timer`）。 */
  interval(callback: () => void, ms: number): () => void
  timeout(callback: () => void, ms: number): void
  logger: {
    debug(...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
  }
  gwbCommands: Pick<GwbCommands, 'register'>
  gwbSettings: Pick<GwbSettingsApi, 'define' | 'get'>
  gwbData: Pick<GwbDataApi, 'dir'>
}

/** 跑一次自检的函数。生产实现是 `health.ts` 的 `runHealthCheck`（快照那项会启动一次 restic）。 */
export type HealthRunner = (paths: BackupPaths, config: BackupConfig) => Promise<HealthReport>

/** 跑一轮备份的函数。生产实现会启动好几个 restic 子进程，测试传入替身。 */
export type BackupRunner = (
  paths: BackupPaths,
  config: BackupConfig,
) => Promise<{ ok: boolean; skipped: 'locked' | null; summary: string | null }>

/** 加载时可注入的依赖。测试用它把真 restic 换成替身。 */
export type MountDeps = {
  runHealth: HealthRunner
  runBackup: BackupRunner
  /** 透传命令用的启动进程函数；不给就真启动子进程。 */
  run?: RunProcess | undefined
  /** 取当前时间（测试里可替换）。 */
  now?: (() => Date) | undefined
}

/** 生产实现：跑全部五项，不跳过快照那项。 */
const realHealth: HealthRunner = (paths, config) => runHealthCheck(paths, config, { skipSnapshots: false })

/** 生产实现：整条备份链路，结论收成三个字段。 */
const realBackup: BackupRunner = async (paths, config) => {
  const result = await runFullBackup({ paths, config, logger: createLogger(paths.logFile) })
  if (result.skipped === 'locked') return { ok: false, skipped: 'locked', summary: null }
  return { ok: result.ok, skipped: null, summary: result.notification.body }
}

/**
 * 从插件包根的 package.json 读版本。本模块在 `dist/index.js`，包根在上一层（`'../package.json'`）。
 * loader 可能带查询串 import 本模块，`createRequire` 拿那种 URL 解析相对路径会抛错，先去掉 `?` 后面那段。
 */
function pluginVersion(): string {
  try {
    const moduleUrlWithoutQuery = import.meta.url.split('?')[0] ?? import.meta.url
    const require = createRequire(moduleUrlWithoutQuery)
    const manifest = require('../package.json') as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function apply(ctx: GwbContext): void {
  // GwbContext 带着 HostContext 要的全部成员，但泛型自指的结构检查过不去，显式收窄一次
  mount(ctx as unknown as HostContext, { runHealth: realHealth, runBackup: realBackup })
}

/** 一轮备份的六种结局。`failed` 时 state 已按本轮记账，不会拿上一轮的成功冒充。 */
type BackupOutcome = 'done' | 'failed' | 'busy' | 'locked' | 'refused' | 'not-ready'

/** `mount` 里各部分共用的运行时：可变状态、两个定时器、跑备份与跑自检、给命令回的状态。 */
interface BackupRuntime {
  paths: BackupPaths
  version: string
  currentFlat(): FlatConfig
  currentConfig(): BackupConfig
  runBackup(reason: string): Promise<BackupOutcome>
  runCheck(): Promise<'done' | 'busy' | 'not-ready'>
  backupInfo(): Record<string, unknown>
  snapshot(): Record<string, unknown>
  startBackupTimer(minutes: number): void
  markFirstCheckAt(iso: string): void
}

/** 全部加载动作。`apply` 只负责传入生产实现，拆成两层是为了测试换掉会启动子进程的两个 runner。 */
export function mount(ctx: HostContext, deps: MountDeps): void {
  const log = ctx.logger
  const dataDir = ctx.gwbData.dir
  ensureDataDir(dataDir, log)
  const runtime = createBackupRuntime(ctx, deps, layout(dataDir))

  declareSettings(ctx)
  registerCommands(ctx, deps, runtime)

  const flat = runtime.currentFlat()
  runtime.startBackupTimer(flat.frequencyMinutes)
  scheduleFirstCheckAndCatchUp(ctx, runtime, flat.frequencyMinutes)
  registerPaneWhenShellIsPresent(ctx)

  log.info(
    `gwb-windows-backup 已挂载 ${runtime.version}：每 ${String(flat.frequencyMinutes)} 分钟备份一轮，结论看 windows-backup.status`,
  )
}

/** 建不出数据目录不抛：命令照常可用，备份与自检运行时自己会报错。 */
function ensureDataDir(dataDir: string, log: HostContext['logger']): void {
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch (error) {
    log.warn('数据目录建不出来：', messageOf(error))
  }
}

/** 设置每次现读、不缓存：设置插件没有变更通知。 */
function readFlatFromSettings(settings: HostContext['gwbSettings']): FlatConfig {
  const fields: Record<string, unknown> = {}
  for (const { key, field } of SETTING_KEYS) fields[field] = settings.get(key)
  return pickFlat(fields)
}

function createBackupRuntime(ctx: HostContext, deps: MountDeps, paths: BackupPaths): BackupRuntime {
  const log = ctx.logger
  const appliedAt = new Date().toISOString()
  const version = pluginVersion()
  const currentFlat = (): FlatConfig => readFlatFromSettings(ctx.gwbSettings)
  const currentConfig = (): BackupConfig => flatToConfig(currentFlat())

  // 可变状态只在这一次 mount 的闭包里：重新加载就清零，要跨进程保留的在 state.json
  const state = {
    /** 正在跑一次自检：跑着的时候再触发不重复跑。 */
    checking: false,
    lastReport: null as HealthReport | null,
    lastCheckedAt: null as string | null,
    nextCheckAt: null as string | null,
    /** 自检本身出错时的那句话（不是「备份有问题」，是「检查本身出错了」）。 */
    lastError: null as string | null,
    /** 当前自检定时器的间隔（小时）；没启动定时器时是 `null`。 */
    intervalHours: null as number | null,
    /** 第一层并发保护：这一个进程里正在跑一轮备份。第二层是数据目录的 backup.lock。 */
    backing: false,
    /** 当前备份定时器的间隔（分钟）；没启动定时器时是 `null`。 */
    frequencyMinutes: null as number | null,
    nextRunAt: null as string | null,
  }

  let stopCheckTimer: (() => void) | null = null
  let stopBackupTimer: (() => void) | null = null

  const startCheckTimer = (hours: number): void => {
    stopCheckTimer?.()
    const ms = intervalMsOf(hours)
    state.intervalHours = hours
    state.nextCheckAt = new Date(Date.now() + ms).toISOString()
    stopCheckTimer = ctx.interval(() => {
      // 每次触发都把「下次」往后推，否则状态里一直是一个已经过去的时刻
      state.nextCheckAt = new Date(Date.now() + ms).toISOString()
      void runCheck()
    }, ms)
  }

  /** 间隔没变只把下次时刻往后推，变了才重建（重建会让当前这一轮的计时清零）。 */
  const syncCheckTimer = (hours: number): void => {
    if (stopCheckTimer !== null && state.intervalHours === hours) {
      state.nextCheckAt = new Date(Date.now() + intervalMsOf(hours)).toISOString()
      return
    }
    if (stopCheckTimer !== null) {
      log.info(`自检间隔变更：${String(state.intervalHours)}h → ${String(hours)}h，计时器重开`)
    }
    startCheckTimer(hours)
  }

  const startBackupTimer = (minutes: number): void => {
    stopBackupTimer?.()
    const ms = backupIntervalMsOf(minutes)
    state.frequencyMinutes = minutes
    state.nextRunAt = new Date(Date.now() + ms).toISOString()
    stopBackupTimer = ctx.interval(() => {
      // 每次触发都把「下一轮」往后推，否则跑过一轮后状态停在旧值
      state.nextRunAt = new Date(Date.now() + ms).toISOString()
      void runBackup('定时')
    }, ms)
  }

  /** 频率变了才重建：设置里改的 `frequency-minutes` 从下一轮起生效。 */
  const syncBackupTimer = (minutes: number): void => {
    if (stopBackupTimer === null) return
    if (state.frequencyMinutes === minutes) return
    log.info(`备份周期变更：${String(state.frequencyMinutes)} 分钟 → ${String(minutes)} 分钟，计时器重开`)
    startBackupTimer(minutes)
  }

  /** 跑一轮备份。**绝不抛**：定时器与命令两条路径都调它，抛出去周期定时就停了。 */
  const runBackup = async (reason: string): Promise<BackupOutcome> => {
    if (state.backing) return 'busy'
    const config = currentConfig()
    syncBackupTimer(config.schedule.frequencyMinutes)
    const refused = refuseReason(config)
    if (refused !== null) {
      log.info(`跳过${reason}备份：${refused}`)
      return 'refused'
    }

    state.backing = true
    log.info(`${reason}备份开始（每 ${String(config.schedule.frequencyMinutes)} 分钟一轮）`)
    try {
      const result = await deps.runBackup(paths, config)
      if (result.skipped === 'locked') {
        log.info(`${reason}备份跳过：数据目录的 backup.lock 被占着，另一轮正在跑`)
        return 'locked'
      }
      if (result.ok) {
        log.info(`${reason}备份完成：${result.summary ?? '（没有小结）'}`)
        return 'done'
      }
      log.warn(`${reason}备份失败：${result.summary ?? '（没有小结）'}——日志在 ${paths.logFile}`)
      return 'failed'
    } catch (error) {
      const message = messageOf(error)
      log.warn(`${reason}备份没跑完（下一轮照跑）：`, message)
      recordUnfinishedRun(paths.stateFile, message, log)
      return 'failed'
    } finally {
      state.backing = false
    }
  }

  /** 跑一次自检。**绝不抛**。每次现读配置，间隔变了定时器跟着重建。 */
  const runCheck = async (): Promise<'done' | 'busy' | 'not-ready'> => {
    if (state.checking) return 'busy'
    state.checking = true
    try {
      const config = currentConfig()
      syncCheckTimer(config.healthCheckIntervalHours)
      const report = await deps.runHealth(paths, config)
      state.lastReport = report
      state.lastCheckedAt = new Date().toISOString()
      state.lastError = null
      if (report.ok) {
        log.info('备份自检正常')
      } else {
        log.warn(`备份自检发现 ${String(report.problems.length)} 个问题：${report.problems.join('；')}`)
      }
    } catch (error) {
      state.lastError = messageOf(error)
      log.warn('备份自检没跑完（下一轮照跑）：', state.lastError)
    } finally {
      state.checking = false
    }
    return 'done'
  }

  /** 备份部分的状态。`status` 的 `backup` 字段与 `run` 命令的回执都用它。 */
  const backupInfo = (): Record<string, unknown> => {
    const disk = readState(paths.stateFile)
    return {
      frequencyMinutes: state.frequencyMinutes,
      running: state.backing,
      /** 这一轮是从什么时候开始的（`backup.lock` 的 `startedAt`，ISO）；没在跑是 `null`。 */
      runningSince: state.backing ? (readLock(paths.lockFile)?.startedAt ?? null) : null,
      lastRunAt: disk.lastRunAt ?? null,
      lastRunOk: disk.lastRunOk ?? null,
      lastRunSummary: disk.lastRunSummary ?? null,
      nextRunAt: state.nextRunAt,
    }
  }

  /** 全量状态。`report` 为 `null` 是「还没有结论」，不是「没问题」。 */
  const snapshot = (): Record<string, unknown> => ({
    plugin: name,
    version,
    moduleLoadedAt: MODULE_LOADED_AT,
    appliedAt,
    dataDir: paths.dir,
    intervalHours: state.intervalHours,
    checking: state.checking,
    lastCheckedAt: state.lastCheckedAt,
    nextCheckAt: state.nextCheckAt,
    lastError: state.lastError,
    report: state.lastReport,
    backup: backupInfo(),
  })

  return {
    paths,
    version,
    currentFlat,
    currentConfig,
    runBackup,
    runCheck,
    backupInfo,
    snapshot,
    startBackupTimer,
    markFirstCheckAt: (iso) => {
      state.nextCheckAt = iso
    },
  }
}

/**
 * 本轮抛错时把失败记进 state：不记的话 state 里还留着上一轮的结论，命令读到的就是上一轮的成功。
 * 写不进（磁盘满等）只记日志，命令层照样按本轮失败回执，不读 state。
 */
function recordUnfinishedRun(stateFile: string, message: string, log: HostContext['logger']): void {
  try {
    writeState(stateFile, { lastRunOk: false, lastRunSummary: `本轮没跑完：${message}` })
  } catch {
    log.warn('本轮失败想记进 state 也没记成——命令层将按本轮失败回执，不信 state')
  }
}

function declareSettings(ctx: HostContext): void {
  ctx.effect(() => {
    const undefineAll = SETTING_KEYS.map((item) =>
      ctx.gwbSettings.define({
        key: item.key,
        title: item.title,
        type: item.type,
        description: item.description,
        default: DEFAULT_FLAT[item.field],
      }),
    )
    return () => {
      for (const undefine of undefineAll) undefine()
    }
  })
}

/** 六条命令，每条一个 effect：某条登记时撞名不连累别的几条。 */
function registerCommands(ctx: HostContext, deps: MountDeps, runtime: BackupRuntime): void {
  ctx.effect(() => ctx.gwbCommands.register(
    {
      name: 'windows-backup.run',
      description: '立刻跑一轮完整备份（和定时触发的那轮做同样的事）。占不到锁会如实说；配置没填全回拒跑理由',
      usage:
        '无参数。跑完回 { ok: <本轮成败>, data: { frequencyMinutes, running, runningSince, lastRunAt, lastRunOk, lastRunSummary, nextRunAt, summary } }；' +
        '本轮失败回 { ok: false, error, data: <同上> }；本进程已有一轮在跑、锁被别的进程占着、配置没填全回 { ok: false, error }',
      plugin: PKG,
    },
    () => runCommandReply(runtime),
  ))

  ctx.effect(() => ctx.gwbCommands.register(
    {
      name: 'windows-backup.check',
      description: '立刻跑一次五项健康检查，回全量状态（窗格显示的就是这份）',
      usage: '无参数。检查跑完回 { ok: true, data: <与 windows-backup.status 的 data 同形> }；已有一次检查在跑时不重复跑，照样回当前状态',
      plugin: PKG,
    },
    async () => {
      await runtime.runCheck()
      return { ok: true, data: runtime.snapshot() }
    },
  ))

  ctx.effect(() => ctx.gwbCommands.register(
    {
      name: 'windows-backup.status',
      description: '回全量状态：上次备份、自检结论、定时器节奏。窗格轮询的就是它',
      usage:
        '无参数。回 { ok: true, data: { plugin, version, moduleLoadedAt, appliedAt, dataDir, intervalHours, checking, lastCheckedAt, nextCheckAt, lastError, ' +
        'report: { checkedAt, ok, problems: string[], items: { lastRun, log, disk, snapshots, periodic } } | null（null = 还没有结论，不是没问题）, ' +
        'backup: { frequencyMinutes, running, runningSince, lastRunAt, lastRunOk, lastRunSummary, nextRunAt } } }',
      plugin: PKG,
    },
    () => ({ ok: true, data: runtime.snapshot() }),
  ))

  ctx.effect(() => ctx.gwbCommands.register(
    {
      name: 'windows-backup.paths',
      description: '回数据目录的全部路径：state.json / backup.lock / credentials 目录 / 日志 / bin。凡是要看凭据在不在、tail 日志的，先调这条拿路径，别猜',
      usage: '无参数。回 { ok: true, data: { dataDir, stateFile, lockFile, credentialsDir, passwordFile, ossCredentialsFile, defaultExcludeFile, binDir, logFile } }',
      plugin: PKG,
    },
    () => ({ ok: true, data: pathsReply(runtime.paths) }),
  ))

  ctx.effect(() => ctx.gwbCommands.register(
    {
      name: 'windows-backup.restic',
      description: '透传一条 restic 命令，自动补 --repo 与 --password-file。密钥永不出现在参数里',
      usage:
        '{ repo?: "local" | "oss"（不是 "oss" 都按 local）, args?: string[]（原样传给 restic，非字符串元素丢掉），如 { "repo": "local", "args": ["snapshots"] } }。' +
        '回 { ok: <退出码为 0>, data: { code, timedOut, stdout, stderr }, error?（退出码非 0 时为 stderr，stderr 为空则「退出码 N」）}',
      plugin: PKG,
    },
    (args: unknown) => resticPassThroughReply(args, runtime, deps.run),
  ))

  ctx.effect(() => ctx.gwbCommands.register(
    {
      name: 'windows-backup.mark',
      description: '补记周期动作（USB 离机副本、排除规则审计、人工复核）的时间戳',
      usage:
        '{ what 必给："usb-copy" | "exclude-audit" | "review", at?: "YYYY-MM-DD"（缺省今天，本地日期）}。' +
        '回 { ok: true, data: { what, at, lastUsbCopy, lastExcludeAudit, lastReview } }；what 不认识回 { ok: false, error }',
      plugin: PKG,
    },
    (args: unknown) => markReply(args, runtime.paths.stateFile),
  ))
}

/** `windows-backup.run` 的回执。本轮成败只看这一轮的结局，不读 state 里可能是上一轮的 `lastRunOk` 来顶替失败。 */
async function runCommandReply(runtime: BackupRuntime): Promise<Record<string, unknown>> {
  const outcome = await runtime.runBackup('手动')
  if (outcome === 'busy') return { ok: false, error: '这一轮已经有备份在跑（本进程）' }
  if (outcome === 'locked') return { ok: false, error: '另一轮备份正在跑（数据目录的锁被占着），稍后再试' }
  if (outcome === 'not-ready') return { ok: false, error: '数据目录还没就绪' }
  if (outcome === 'refused') return { ok: false, error: refuseReason(runtime.currentConfig()) }
  const disk = readState(runtime.paths.stateFile)
  const data = { ...runtime.backupInfo(), summary: disk.lastRunSummary ?? null }
  if (outcome === 'failed') return { ok: false, error: '本轮备份失败', data }
  return { ok: disk.lastRunOk ?? false, data }
}

function pathsReply(paths: BackupPaths): Record<string, string> {
  return {
    dataDir: paths.dir,
    stateFile: paths.stateFile,
    lockFile: paths.lockFile,
    credentialsDir: paths.credentialsDir,
    passwordFile: paths.passwordFile,
    ossCredentialsFile: paths.ossCredentialsFile,
    defaultExcludeFile: paths.defaultExcludeFile,
    binDir: paths.binDir,
    logFile: paths.logFile,
  }
}

/** `windows-backup.restic` 的回执。只有 `repo` 为 `oss` 时才把 AccessKey 解析进子进程 env。 */
async function resticPassThroughReply(args: unknown, runtime: BackupRuntime, run: RunProcess | undefined): Promise<Record<string, unknown>> {
  const body = isRecord(args) ? args : {}
  const repo = body.repo === 'oss' ? 'oss' : 'local'
  const resticArgs = Array.isArray(body.args) ? body.args.filter((one): one is string => typeof one === 'string') : []
  const config = runtime.currentConfig()
  const paths = runtime.paths
  const exe = resolveSlotPath(config.restic.exe, paths.dir)
  const repoUrl = repo === 'oss' ? ossRepoUrl(config.repositories.oss) : config.repositories.local.repo
  const ossEnv = repo === 'oss' ? readOssEnv(paths.ossCredentialsFile) : {}
  const result = await runRestic(exe, repoUrl, resticArgs, {
    passwordFile: paths.passwordFile,
    env: resticEnv(config.restic.gomaxprocs, ossEnv),
    timeoutMs: BACKUP_TIMEOUT_MS,
    run,
  })
  return {
    ok: result.code === 0,
    data: { code: result.code, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr },
    error: result.code === 0 ? undefined : (result.stderr.trim() || `退出码 ${result.code}`),
  }
}

function markReply(args: unknown, stateFile: string): Record<string, unknown> {
  const body = isRecord(args) ? args : {}
  const what = body.what
  if (what !== 'usb-copy' && what !== 'exclude-audit' && what !== 'review') {
    return { ok: false, error: 'what 只认 usb-copy、exclude-audit 或 review' }
  }
  const at = typeof body.at === 'string' && body.at.trim() !== '' ? body.at.trim() : todayLocal()
  const patch = what === 'usb-copy' ? { lastUsbCopy: at } : what === 'exclude-audit' ? { lastExcludeAudit: at } : { lastReview: at }
  const merged = writeState(stateFile, patch)
  return { ok: true, data: { what, at, lastUsbCopy: merged.lastUsbCopy ?? null, lastExcludeAudit: merged.lastExcludeAudit ?? null, lastReview: merged.lastReview ?? null } }
}

/** 加载 30 秒后先跑一次自检；上一轮备份离现在已满一个周期（或从没跑过）就顺带补跑一轮。 */
function scheduleFirstCheckAndCatchUp(ctx: HostContext, runtime: BackupRuntime, frequencyMinutes: number): void {
  runtime.markFirstCheckAt(new Date(Date.now() + FIRST_DELAY_MS).toISOString())
  ctx.timeout(() => {
    void runtime.runCheck()
  }, FIRST_DELAY_MS)

  const lastRunAt = readState(runtime.paths.stateFile).lastRunAt
  if (shouldCatchUp(lastRunAt, frequencyMinutes, new Date())) {
    ctx.timeout(() => {
      void runtime.runBackup('补跑')
    }, FIRST_DELAY_MS)
    ctx.logger.info(`上次备份是 ${lastRunAt ?? '（从没跑过）'}，${String(FIRST_DELAY_MS / 1000)}s 后补跑一轮`)
  }
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

/** 本地日期 `YYYY-MM-DD`（mark 命令的缺省值用）。 */
function todayLocal(): string {
  const now = new Date()
  const twoDigits = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
