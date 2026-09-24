/**
 * gwb-windows-backup 的 node 侧（在工作台进程里运行）。**备份的主体在这里。**
 *
 * 从旧仓 god-windows-backup 重写（语义不变、代码重写），判据不变：**代码只做「没有 AI
 * 也要发生」的事**——定时备份、周期自检、状态查询；一次性操作（装 restic、配 Veeam、USB 离机
 * 副本）归将来的手册。node 侧做六件事：
 *
 * 1. **定时备份**——按设置的 `frequency-minutes` 启动周期定时器跑全流程备份。频率改了
 *    就停掉旧定时器、按新频率重建（下一轮生效）。**工作台没运行就不备份**，这是已知并接受的代价。
 * 2. **开机 / 重启补跑**——启动时看 `state.json` 的 `lastRunAt`，为空或已超过一个周期，
 *    30 秒后先补跑一次；不在加载时立即跑（加载期间所有插件都在启动，这时运行 restic 会让仓库 I/O
 *    拖慢启动）。
 * 3. **周期自检**——按 `health-check-interval-hours` 跑五项健康检查。
 * 4. **配置**——在设置插件里声明 17 个键（kebab-case），每次运行都现读，不缓存。
 * 5. **命令**——六条 `windows-backup.*` 命令登记在命令总线上（run / check / status /
 *    paths / restic / mark）。**没有 HTTP 路由**——状态查询走命令总线与事件，MCP
 *    插件会把总线上的命令自动暴露给 agent。
 * 6. **界面**——gwb-shell 的备份窗格，走**局部注入**：headless home（没装外壳）里
 *    备份照常运行，缺的只是界面。
 *
 * ── 照着写的人最容易出错的几条 ──────────────────────────────────────────────────
 *
 * - **顶层 `inject` 只列命令 / 设置 / 数据 / timer 四个服务**——备份离不开它们，缺哪个这个插件都没有
 *   存在的意义，cordis 的等待语义会让插件停在等待状态并在日志里写明。外壳**绝不**进顶层
 *   inject：列了却不在场，整个插件（连同备份本体）静默 pending。
 * - **两层并发保护，缺一不可**：闭包里的 `backing` 挡的是这一个进程里的重复触发；数据
 *   目录里的 `backup.lock`（`lock.ts`）挡的是跨进程的那轮。
 * - **定时器每触发一次就把「下次」往后推**——只在启动定时器时算一次 `nextRunAt`、跑完不推的话，状态里
 *   显示的就永远是一个已经过去的时刻（旧仓在沙箱里实测遇到过）。
 * - **所有 async 链自己 catch 并打日志**——「加载了但什么都没发生」是实机验证时遇到过的假成功，
 *   静默 reject 在日志里不留任何痕迹。
 *
 * 凭据纪律：**永不进设置、永不进日志**。仓库密码只以文件路径交给 restic 的
 * `--password-file`；OSS AccessKey 只在运行 OSS 那一步时解析进子进程 env。
 */

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isRecord } from './vocab.js'
import type { GwbContext } from '@godcreator/gwb-plugin-api'
// 只为激活 commands / settings / data / shell 四个插件与官方 timer 插件给 cordis
// Context 加的名字；全是 type import，构建产物里不留任何代码
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

/**
 * 模块被重新 import 的时刻。**必须写在入口模块的顶层**：这个值如实反映「运行中的代码
 * 是哪一版」——status 里带着它，没变就是新代码没加载上。
 */
const MODULE_LOADED_AT = new Date().toISOString()

/** 运行时名字 = cordis.yml 条目里的包名，与数据目录的归属（gwbData 按 fiber 定）对得上。 */
export const name = 'gwb-windows-backup'

/** 命令登记的 plugin 字段认完整包名（commands 0.4 起的规范）——跟运行时名字是两回事 */
const PKG = '@godcreator/gwb-windows-backup'

/**
 * 浏览器侧与样式表的地址，注册窗格时报给外壳。**内核不替插件解析地址**——没有 `gwb://`、
 * 没有 exports 解析，各插件自己报界面的 `file://` 地址。构建产物里这三个文件同在 `dist/` 下，
 * 从本模块的地址算。
 */
const CLIENT_URL = new URL('./client.js', import.meta.url).href
const STYLE_URL = new URL('./style.css', import.meta.url).href

/**
 * 插件级 `inject` 是**等待语义**——列了却不在场，整个插件停在等待状态（日志里写明在等谁）。
 * 所以只列真正必需的：命令总线（所有写操作都经它）、设置（配置的唯一正本）、数据（状态与凭据
 * 落盘）、timer（官方 @cordisjs/plugin-timer，没有它就用不了 `ctx.interval` / `ctx.timeout`；
 * home 的 cordis.yml 没这条条目时备份插件整个停在等待——宁可等待，不静默空转）。
 * 外壳走局部注入（见文末），不在场只是没有界面，备份本体照常运行。
 */
export const inject = ['gwbCommands', 'gwbSettings', 'gwbData', 'timer']

/** 设置插件里的键（kebab-case，设置插件只接受这种写法）→ 平铺配置的字段（camelCase，跟旧仓一致）。 */
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

/**
 * 拿到数据目录后多久跑第一次自检 / 补跑那一轮备份。
 *
 * 不在加载时立即跑：加载期间所有插件都在启动，这时运行一次 restic 会让备份仓库的 I/O 拖慢
 * 启动。30 秒足够让所有插件加载完、也足够短到「开机就补上」。
 */
const FIRST_DELAY_MS = 30_000

/**
 * 加载需要的最小宿主形状——按结构收窄，测试传入替身（与 `mount` 的 deps 注入点配套）。
 * 生产实现是 `GwbContext`（经五个插件的 `declare module` 加上了 gwbCommands 等名字）。
 */
export interface HostContext {
  /**
   * cordis 的 effect 要求 setup **返回一个 disposer**（`Disposable = () => any`，返回 void
   * 类型检查不过）——登记的东西都要能被注销，这里按这个要求收窄。
   */
  effect(setup: () => () => void): void
  inject<T extends Record<string, unknown>>(deps: readonly string[], callback: (scoped: HostContext & T) => void): void
  /** 官方 timer 插件加到 ctx 上的两个方法（服务名 `timer`，inject 列了才能用）。 */
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

/** 生产实现：跑全部五项，**不跳过快照**——快照新鲜度正是状态查询最想看的一项。 */
const realHealth: HealthRunner = (paths, config) => runHealthCheck(paths, config, { skipSnapshots: false })

/** 生产实现：整条备份链路。占锁在 `backup.ts` 里，这里只把结论收成三个字段。 */
const realBackup: BackupRunner = async (paths, config) => {
  const result = await runFullBackup({ paths, config, logger: createLogger(paths.logFile) })
  if (result.skipped === 'locked') return { ok: false, skipped: 'locked', summary: null }
  return { ok: result.ok, skipped: null, summary: result.notification.body }
}

/**
 * 从包根的 package.json 里读版本。本模块在 `dist/index.js`，包根在**上一层**——相对引用
 * 是 `'../package.json'`（`'./'` 会落到 dist/ 里去）。loader 可能带查询串 import 本模块
 * （绕过模块缓存的写法），`createRequire` 拿那种 URL 解析相对路径会抛错，先去掉 `?` 后面那段。
 */
function pluginVersion(): string {
  try {
    const clean = import.meta.url.split('?')[0] ?? import.meta.url
    const require = createRequire(clean)
    const manifest = require('../package.json') as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function apply(ctx: GwbContext): void {
  // 五个服务的名字都经 declare module 加在 Context 上，GwbContext 实际上就是 HostContext
  // 加上一大批用不到的成员；泛型自指的结构检查过不去，显式收窄一次（运行时零开销）
  mount(ctx as unknown as HostContext, { runHealth: realHealth, runBackup: realBackup })
}

/**
 * 全部加载动作。`apply` 只是它外面的一层，负责传入生产实现。
 *
 * 拆成两层的唯一理由是**测试**：`runHealthCheck` 与 `runFullBackup` 都会启动子进程，
 * 测试里必须换成替身。
 */
export function mount(ctx: HostContext, deps: MountDeps): void {
  const appliedAt = new Date().toISOString()
  const version = pluginVersion()
  const log = ctx.logger

  // ── 数据目录与目录内布局（gwbData 在顶层 inject 里，加载时它一定在）──────────────────
  const dataDir = ctx.gwbData.dir
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch (error) {
    // 建不出来不抛：命令照常可用，备份与自检运行时会自己报错——为它让整个加载失败不划算
    log.warn('数据目录建不出来：', messageOf(error))
  }
  const paths = layout(dataDir)

  /**
   * 每次现读的配置。设置插件没有变更通知，缓存一份就会「设置改了、跑的还是旧值」；
   * 代价是每轮多几次内存里的 get，不值一提。
   */
  const currentFlat = (): FlatConfig => {
    const raw: Record<string, unknown> = {}
    for (const { key, field } of SETTING_KEYS) raw[field] = ctx.gwbSettings.get(key)
    return pickFlat(raw)
  }
  const currentConfig = (): BackupConfig => flatToConfig(currentFlat())

  /**
   * 全部可变状态。**只存在这一次 mount 的闭包里**——重新加载会清零（上一轮结论没了，30 秒后
   * 重新跑一次自检），这是已知并接受的代价：结论本身是「此刻的观察」，不值得为它另存一份
   * 文件。真正要跨进程保留的那几项存在 `state.json`。
   */
  const state = {
    /** 正在跑一次自检——**并发保护**：跑着的时候再触发不重复跑。 */
    checking: false,
    lastReport: null as HealthReport | null,
    lastCheckedAt: null as string | null,
    nextCheckAt: null as string | null,
    /** 自检本身出错时的那句话（不是「备份有问题」，是「检查本身出错了」）。 */
    lastError: null as string | null,
    /** 当前自检定时器的间隔（小时）；没启动定时器时是 `null`。 */
    intervalHours: null as number | null,
    /** **第一层并发保护**：这一个进程里正在跑一轮备份。第二层是数据目录的 backup.lock。 */
    backing: false,
    /** 当前备份定时器的间隔（分钟）；没启动定时器时是 `null`。 */
    frequencyMinutes: null as number | null,
    nextRunAt: null as string | null,
  }

  // ── 定时器 ───────────────────────────────────────────────────────────────────

  /** 停掉自检定时器的函数。换间隔时先停再启动，不留两个。 */
  let stopCheckTimer: (() => void) | null = null
  /** 停掉备份定时器的函数。同上。 */
  let stopBackupTimer: (() => void) | null = null

  const startCheckTimer = (hours: number): void => {
    stopCheckTimer?.()
    const ms = intervalMsOf(hours)
    state.intervalHours = hours
    state.nextCheckAt = new Date(Date.now() + ms).toISOString()
    stopCheckTimer = ctx.interval(() => {
      // 每触发一次把「下次」往后推，状态里才不会一直显示一个已经过去的时刻
      state.nextCheckAt = new Date(Date.now() + ms).toISOString()
      void runCheck()
    }, ms)
  }

  /** 间隔没变就只把下次时刻往后推，变了才重建——重建是有代价的（当前这一轮的计时清零）。 */
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
      // 每触发一次就把「下一轮」往后推——只在启动定时器时算一次的话，跑过一轮后状态停在旧值
      state.nextRunAt = new Date(Date.now() + ms).toISOString()
      void runBackup('定时')
    }, ms)
  }

  /** 频率变了才重建——「设置里改了 `frequency-minutes`，下一轮生效」就在这里实现。 */
  const syncBackupTimer = (minutes: number): void => {
    if (stopBackupTimer === null) return
    if (state.frequencyMinutes === minutes) return
    log.info(`备份周期变更：${String(state.frequencyMinutes)} 分钟 → ${String(minutes)} 分钟，计时器重开`)
    startBackupTimer(minutes)
  }

  // ── 备份 ─────────────────────────────────────────────────────────────────────

  /**
   * 跑一轮备份。**绝不抛**——定时器与命令两条路径都调它，异常从这里抛出去会让周期定时停掉。
   *
   * 六种结局：`done`（跑成了）/ `failed`（这轮失败或没跑完——**state 已按本轮记账**，不会
   * 拿上一轮的成功冒充）/ `busy`（这个进程里已经有一轮在跑）/ `locked`（别的进程占着
   * 数据目录那把锁）/ `refused`（配置没填全）/ `not-ready`（数据目录还没就绪）。
   */
  const runBackup = async (reason: string): Promise<'done' | 'failed' | 'busy' | 'locked' | 'refused' | 'not-ready'> => {
    // 第一层并发保护：同一个进程里不叠第二轮。第二层（跨进程）是 backup.lock
    if (state.backing) return 'busy'
    const config = currentConfig()
    // 用现读的配置核对一次定时器：设置里改了频率，下一轮起就按新值运行
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
        // 「另一轮正在跑」不是故障：一行 info 说清就够，不 warn、不进健康检查的问题清单
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
      // state 里还留着上一轮的结论。不把这轮的失败记下去，命令读到的就是上一轮的
      // 「成功」——回执谎报。写不进（磁盘满等）也不吞：命令按 failed 回，不让旧值冒充
      try {
        writeState(paths.stateFile, { lastRunOk: false, lastRunSummary: `本轮没跑完：${message}` })
      } catch {
        log.warn('本轮失败想记进 state 也没记成——命令层将按本轮失败回执，不信 state')
      }
      return 'failed'
    } finally {
      state.backing = false
    }
  }

  // ── 自检 ─────────────────────────────────────────────────────────────────────

  /**
   * 跑一次自检。**绝不抛**——理由同上。
   *
   * 每轮**现读配置**：设置里改了值，这一轮就按新值跑、间隔变了定时器也跟着重建。
   */
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
      // 8 小时一次：正常一行 info，有问题用 warn 把问题清单打出来（日志分级按频率而不是按重要性）
      if (report.ok) {
        log.info('备份自检正常')
      } else {
        log.warn(`备份自检发现 ${String(report.problems.length)} 个问题：${report.problems.join('；')}`)
      }
    } catch (error) {
      // 「检查本身出错」跟「备份有问题」是两回事，分开记
      state.lastError = messageOf(error)
      log.warn('备份自检没跑完（下一轮照跑）：', state.lastError)
    } finally {
      state.checking = false
    }
    return 'done'
  }

  // ── 状态快照（status 命令的回包；窗格轮询的就是它）─────────────────────

  /** 备份部分的状态。`status` 的 `backup` 字段与 `run` 命令的回包都用它。 */
  const backupInfo = (): Record<string, unknown> => {
    const disk = readState(paths.stateFile)
    return {
      frequencyMinutes: state.frequencyMinutes,
      running: state.backing,
      /**
       * 这一轮是从什么时候开始的（`backup.lock` 的 `startedAt`，ISO）。没在跑就是 `null`。
       *
       * 加它是因为「跑着」这一个布尔答不了最常问的那个问题：**跑了多久了**。首次全量、
       * 白名单加了路径之后的那一轮，都是小时级的——只有 `running: true` 加一份要自己 tail
       * 的日志，人和 agent 都分不清是在干活还是卡死了。
       */
      runningSince: state.backing ? (readLock(paths.lockFile)?.startedAt ?? null) : null,
      lastRunAt: disk.lastRunAt ?? null,
      lastRunOk: disk.lastRunOk ?? null,
      lastRunSummary: disk.lastRunSummary ?? null,
      nextRunAt: state.nextRunAt,
    }
  }

  /**
   * 全量状态。
   *
   * `report` 是 `HealthReport | null`——**null 是「还没有结论」，不是「没问题」**，界面
   * 据此显示灰色指示灯。
   */
  const snapshot = (): Record<string, unknown> => ({
    plugin: name,
    version,
    moduleLoadedAt: MODULE_LOADED_AT,
    appliedAt,
    dataDir,
    intervalHours: state.intervalHours,
    checking: state.checking,
    lastCheckedAt: state.lastCheckedAt,
    nextCheckAt: state.nextCheckAt,
    lastError: state.lastError,
    report: state.lastReport,
    backup: backupInfo(),
  })

  // ── 设置声明（17 个键）───────────────────────────────────────────────────────

  ctx.effect(() => {
    const offs = SETTING_KEYS.map((item) =>
      ctx.gwbSettings.define({
        key: item.key,
        title: item.title,
        type: item.type,
        description: item.description,
        default: DEFAULT_FLAT[item.field],
      }),
    )
    return () => {
      for (const off of offs) off()
    }
  })

  // ── 命令（六条，每条一个 effect：某条登记时重名不该连累别的几条）──────────

  ctx.effect(() => {
    const off = ctx.gwbCommands.register(
      {
        name: 'windows-backup.run',
        description: '立刻跑一轮完整备份（和定时触发的那轮做同样的事）。占不到锁会如实说；配置没填全回拒跑理由',
        usage:
          '无参数。跑完回 { ok: <本轮成败>, data: { frequencyMinutes, running, runningSince, lastRunAt, lastRunOk, lastRunSummary, nextRunAt, summary } }；' +
          '本轮失败回 { ok: false, error, data: <同上> }；本进程已有一轮在跑、锁被别的进程占着、配置没填全回 { ok: false, error }',
        plugin: PKG,
      },
      async () => {
        const outcome = await runBackup('手动')
        if (outcome === 'busy') return { ok: false, error: '这一轮已经有备份在跑（本进程）' }
        if (outcome === 'locked') return { ok: false, error: '另一轮备份正在跑（数据目录的锁被占着），稍后再试' }
        if (outcome === 'not-ready') return { ok: false, error: '数据目录还没就绪' }
        if (outcome === 'refused') return { ok: false, error: refuseReason(currentConfig()) }
        const disk = readState(paths.stateFile)
        if (outcome === 'failed') {
          // 本轮失败：成败结论来自 outcome 本身，不信 state——state 写不进时里面还留着
          // 上一轮的成功，拿它顶替就是把上轮的 ok 冒充本轮的
          return { ok: false, error: '本轮备份失败', data: { ...backupInfo(), summary: disk.lastRunSummary ?? null } }
        }
        return { ok: disk.lastRunOk ?? false, data: { ...backupInfo(), summary: disk.lastRunSummary ?? null } }
      },
    )
    return off
  })

  ctx.effect(() => {
    const off = ctx.gwbCommands.register(
      {
        name: 'windows-backup.check',
        description: '立刻跑一次五项健康检查，回全量状态（窗格显示的就是这份）',
        usage: '无参数。检查跑完回 { ok: true, data: <与 windows-backup.status 的 data 同形> }；已有一次检查在跑时不重复跑，照样回当前状态',
        plugin: PKG,
      },
      async () => {
        // 立刻跑，不等下一个周期——人点了「立即检查」就该马上有反应。
        // 正在跑时不重复跑（runCheck 内部用 checking 挡住），回包里是当前结论
        await runCheck()
        return { ok: true, data: snapshot() }
      },
    )
    return off
  })

  ctx.effect(() => {
    const off = ctx.gwbCommands.register(
      {
        name: 'windows-backup.status',
        description: '回全量状态：上次备份、自检结论、定时器节奏。窗格轮询的就是它',
        usage:
          '无参数。回 { ok: true, data: { plugin, version, moduleLoadedAt, appliedAt, dataDir, intervalHours, checking, lastCheckedAt, nextCheckAt, lastError, ' +
          'report: { checkedAt, ok, problems: string[], items: { lastRun, log, disk, snapshots, periodic } } | null（null = 还没有结论，不是没问题）, ' +
          'backup: { frequencyMinutes, running, runningSince, lastRunAt, lastRunOk, lastRunSummary, nextRunAt } } }',
        plugin: PKG,
      },
      () => ({ ok: true, data: snapshot() }),
    )
    return off
  })

  ctx.effect(() => {
    const off = ctx.gwbCommands.register(
      {
        name: 'windows-backup.paths',
        description: '回数据目录的全部路径：state.json / backup.lock / credentials 目录 / 日志 / bin。凡是要看凭据在不在、tail 日志的，先调这条拿路径，别猜',
        usage: '无参数。回 { ok: true, data: { dataDir, stateFile, lockFile, credentialsDir, passwordFile, ossCredentialsFile, defaultExcludeFile, binDir, logFile } }',
        plugin: PKG,
      },
      () => ({
        ok: true,
        data: {
          dataDir,
          stateFile: paths.stateFile,
          lockFile: paths.lockFile,
          credentialsDir: paths.credentialsDir,
          passwordFile: paths.passwordFile,
          ossCredentialsFile: paths.ossCredentialsFile,
          defaultExcludeFile: paths.defaultExcludeFile,
          binDir: paths.binDir,
          logFile: paths.logFile,
        },
      }),
    )
    return off
  })

  ctx.effect(() => {
    const off = ctx.gwbCommands.register(
      {
        name: 'windows-backup.restic',
        description: '透传一条 restic 命令，自动补 --repo 与 --password-file。密钥永不出现在参数里',
        usage:
          '{ repo?: "local" | "oss"（不是 "oss" 都按 local）, args?: string[]（原样传给 restic，非字符串元素丢掉），如 { "repo": "local", "args": ["snapshots"] } }。' +
          '回 { ok: <退出码为 0>, data: { code, timedOut, stdout, stderr }, error?（退出码非 0 时为 stderr，stderr 为空则「退出码 N」）}',
        plugin: PKG,
      },
      async (args: unknown) => {
        const body = isRecord(args) ? args : {}
        const repo = body.repo === 'oss' ? 'oss' : 'local'
        const resticArgs = Array.isArray(body.args) ? body.args.filter((one): one is string => typeof one === 'string') : []
        const config = currentConfig()
        const exe = resolveSlotPath(config.restic.exe, paths.dir)
        const repoUrl = repo === 'oss' ? ossRepoUrl(config.repositories.oss) : config.repositories.local.repo
        // 只有 repo 为 oss 时才把 AccessKey 解析进子进程 env——本地仓库不带
        const ossEnv = repo === 'oss' ? readOssEnv(paths.ossCredentialsFile) : {}
        const env = resticEnv(config.restic.gomaxprocs, ossEnv)
        const result = await runRestic(exe, repoUrl, resticArgs, {
          passwordFile: paths.passwordFile,
          env,
          timeoutMs: BACKUP_TIMEOUT_MS,
          run: deps.run,
        })
        return {
          ok: result.code === 0,
          data: { code: result.code, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr },
          error: result.code === 0 ? undefined : (result.stderr.trim() || `退出码 ${result.code}`),
        }
      },
    )
    return off
  })

  ctx.effect(() => {
    const off = ctx.gwbCommands.register(
      {
        name: 'windows-backup.mark',
        description: '补记周期动作（USB 离机副本、排除规则审计、人工复核）的时间戳',
        usage:
          '{ what 必给："usb-copy" | "exclude-audit" | "review", at?: "YYYY-MM-DD"（缺省今天，本地日期）}。' +
          '回 { ok: true, data: { what, at, lastUsbCopy, lastExcludeAudit, lastReview } }；what 不认识回 { ok: false, error }',
        plugin: PKG,
      },
      (args: unknown) => {
        const body = isRecord(args) ? args : {}
        const what = body.what
        if (what !== 'usb-copy' && what !== 'exclude-audit' && what !== 'review') {
          return { ok: false, error: 'what 只认 usb-copy、exclude-audit 或 review' }
        }
        const at = typeof body.at === 'string' && body.at.trim() !== '' ? body.at.trim() : todayLocal()
        const patch = what === 'usb-copy' ? { lastUsbCopy: at } : what === 'exclude-audit' ? { lastExcludeAudit: at } : { lastReview: at }
        const merged = writeState(paths.stateFile, patch)
        return { ok: true, data: { what, at, lastUsbCopy: merged.lastUsbCopy ?? null, lastExcludeAudit: merged.lastExcludeAudit ?? null, lastReview: merged.lastReview ?? null } }
      },
    )
    return off
  })

  // ── 数据目录就绪：两个定时器 + 30 秒后的首次自检与补跑 ──────────────────────────

  const flat = currentFlat()
  startBackupTimer(flat.frequencyMinutes)

  // 30 秒后：先跑一次自检；上一轮备份太旧（或从没跑过）就顺带补跑一轮
  state.nextCheckAt = new Date(Date.now() + FIRST_DELAY_MS).toISOString()
  ctx.timeout(() => {
    void runCheck()
  }, FIRST_DELAY_MS)

  const lastRunAt = readState(paths.stateFile).lastRunAt
  if (shouldCatchUp(lastRunAt, flat.frequencyMinutes, new Date())) {
    ctx.timeout(() => {
      void runBackup('补跑')
    }, FIRST_DELAY_MS)
    log.info(`上次备份是 ${lastRunAt ?? '（从没跑过）'}，${String(FIRST_DELAY_MS / 1000)}s 后补跑一轮`)
  }

  // ── 界面（局部注入：外壳不在场只是没有界面，备份本体照常运行）────────────────────────

  ctx.inject<{ gwbShell: Pick<GwbShellApi, 'registerPane' | 'describeSelf'> }>(['gwbShell'], (scoped) => {
    scoped.effect(() => {
      const offPane = scoped.gwbShell.registerPane({
        id: 'main',
        title: '备份',
        icon: 'shield-check',
        client: CLIENT_URL,
        style: STYLE_URL,
      })
      const offSelf = scoped.gwbShell.describeSelf({ title: 'Windows 备份', icon: 'shield-check' })
      return () => {
        offSelf()
        offPane()
      }
    })
  })

  log.info(
    `gwb-windows-backup 已挂载 ${version}：每 ${String(flat.frequencyMinutes)} 分钟备份一轮，结论看 windows-backup.status`,
  )
}

/** 本地日期 `YYYY-MM-DD`（mark 命令的缺省值用）。 */
function todayLocal(): string {
  const now = new Date()
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}

/** 从错误对象取出可读的一句话。`useUnknownInCatchVariables` 下 catch 到的是 unknown，这里收窄。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
