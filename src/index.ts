/**
 * gwb-windows-backup —— 宿主里的那半。**备份的主体就住在这里。**
 *
 * 自老仓 god-windows-backup 重做（语义照搬、代码重写），判据不变：**代码只装「没 AI
 * 也在」的事**——定时备份、周期自检、观察面；一次性操作（装 restic、配 Veeam、USB 离机
 * 副本）归将来的手册。这一半干六件事：
 *
 * 1. **定时备份**——按设置的 `frequency-minutes` 起周期定时器跑全流程备份。频率改了
 *    就停旧的重开（下一轮生效）。**宿主不在就不备份**，是知情认下的代价。
 * 2. **开机 / 重启补跑**——起来时看 `state.json` 的 `lastRunAt`，为空或已超过一个周期，
 *    30 秒后先补跑一次；不在挂载当场跑（挂载期整棵树都在起，起 restic 等于拿仓库 I/O
 *    堵启动）。
 * 3. **周期自检**——按 `health-check-interval-hours` 跑五项健康检查。
 * 4. **配置面**——在设置件里声明 15 个键（kebab-case），每次跑现读现用、绝不缓存。
 * 5. **命令面**——六条 `windows-backup.*` 命令挂在命令总线上（run / check / status /
 *    paths / restic / mark）。**没有 HTTP 路由**——新线的观察面走命令总线与事件，MCP
 *    件会把总线自动开给 agent。
 * 6. **界面占位**——gwb-shell 的备份窗格，走**局部注入**：headless home（没装外壳）里
 *    备份照跑，缺的只是看得见的那层皮。
 *
 * ── 抄的人最容易踩错的几条 ──────────────────────────────────────────────────
 *
 * - **顶层 `inject` 只列命令 / 设置 / 数据三件**——那是备份的命根，缺哪个这个件都没有
 *   存在的意义，cordis 的等待语义会把它明明白白挂起。外壳**绝不**进顶层
 *   inject：列了却缺席，整个件（连同备份本体）静默 pending。
 * - **两层并发保护，缺一不可**：闭包里的 `backing` 挡的是这一个进程里的重复触发；数据
 *   目录里的 `backup.lock`（`lock.ts`）挡的是跨进程的那轮。
 * - **每响一次就把「下次」往后推**——起计时器时算一次 `nextRunAt`、跑完不推，状态里
 *   显示的就永远是一个已经过去的时刻（老仓沙箱实测撞过）。
 * - **所有 async 链自己 catch 并打日志**——「挂上了但什么都没发生」是实机验证四种假成
 *   之二，静默 reject 在日志里一根毛都不剩。
 *
 * 凭据纪律：**永不进设置、永不进日志**。仓库密码只以文件路径交给 restic 的
 * `--password-file`；OSS AccessKey 只在跑 OSS 那一趟解析进子进程 env。
 */

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isRecord } from '@godcreator/gwb-plugin-api'
import type { GwbContext } from '@godcreator/gwb-plugin-api'
// 只为激活 commands / settings / data / shell 四个件与官方 timer 件给 cordis
// Context 加的名字；全是 type import，产物里一个字节都不剩
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
import { layout } from './paths.js'
import type { BackupPaths } from './paths.js'
import { BACKUP_TIMEOUT_MS } from './process.js'
import type { RunProcess } from './process.js'
import { ossRepoUrl, resticEnv, runRestic } from './restic.js'
import { readState, writeState } from './state.js'
import { backupIntervalMsOf, intervalMsOf, shouldCatchUp } from './timers.js'

/**
 * 模块被重新 import 的时刻。**必须挂在入口模块的顶层**：这个值如实反映「运行中的代码
 * 是哪一版」——status 里带着它，没变就是没换上。
 */
const MODULE_LOADED_AT = new Date().toISOString()

/** 运行时名字 = cordis.yml 条目里的包名，与数据目录的归属（gwbData 按 fiber 定）对得上。 */
export const name = 'gwb-windows-backup'

/** 命令登记的 plugin 字段认完整包名（commands 0.4 起的规范）——跟运行时名字是两回事 */
const PKG = '@godcreator/gwb-windows-backup'

/**
 * 浏览器半与样式表的地址，注册窗格时报给外壳。**内核不再替件取货**——没有 `gwb://`、
 * 没有 exports 解析，谁的界面谁自报 `file://` 地址。产物里 `dist/` 下三个文件是邻居，
 * 从本模块算。
 */
const CLIENT_URL = new URL('./client.js', import.meta.url).href
const STYLE_URL = new URL('./style.css', import.meta.url).href

/**
 * 整插件级 `inject` 是**等待语义**——列了却缺席，整个插件挂起等它（日志里明说在等谁）。
 * 所以只列真正必需的：命令总线（写面全在它上面）、设置（配置 SSOT）、数据（状态与凭据
 * 落盘）、timer（官方 @cordisjs/plugin-timer，`ctx.interval` / `ctx.timeout` 的访问闸；
 * home 的 cordis.yml 没这条条目时备份件整个挂起——宁挂起不静默空转）。
 * 外壳走局部注入（见文末），缺席只是没有界面，备份本体照跑。
 */
export const inject = ['gwbCommands', 'gwbSettings', 'gwbData', 'timer']

/** 设置件里的键（kebab-case，设置件只收这个形状）→ 平铺配置的字段（camelCase，跟老仓一致）。 */
const SETTING_KEYS: ReadonlyArray<{
  key: string
  field: keyof FlatConfig
  title: string
  type: 'string' | 'number' | 'boolean'
  description: string
}> = [
  { key: 'sources', field: 'sources', type: 'string', title: '备份白名单', description: '分号分隔（如 D:/Notes;D:/Projects）。留空则不备份' },
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
]

/**
 * 数据目录到手多久跑第一次自检 / 补跑那一轮备份。
 *
 * 不在挂载当场跑：挂载期整棵树都在起，这时候起一次 restic 等于拿备份仓库的 I/O 去堵
 * 启动。30 秒足够让树挂完、也足够短到「开机就补上」。
 */
const FIRST_DELAY_MS = 30_000

/**
 * 挂载需要的最小宿主形状——结构化收窄，测试递假的进来（`mount` 的 deps 注入点配套）。
 * 真身是 `GwbContext`（经五个件的 `declare module` 加上了 gwbCommands 等名字）。
 */
export interface HostContext {
  /**
   * cordis 的 effect 要求 setup **回一个 disposer**（`Disposable = () => any`，回 void 直接
   * 类型不过）——挂上去的东西都要能被收走，这儿照那个口径收窄。
   */
  effect(setup: () => () => void): void
  inject<T extends Record<string, unknown>>(deps: readonly string[], callback: (scoped: HostContext & T) => void): void
  /** 官方 timer 件混进 ctx 的那两个（服务名 `timer`，inject 列了才许碰）。 */
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

/** 跑一次自检的那个函数。真身是 `health.ts` 的 `runHealthCheck`（快照那项会起一次 restic）。 */
export type HealthRunner = (paths: BackupPaths, config: BackupConfig) => Promise<HealthReport>

/** 跑一轮备份的那个函数。真身会起好几个 restic 子进程，测试递假的。 */
export type BackupRunner = (
  paths: BackupPaths,
  config: BackupConfig,
) => Promise<{ ok: boolean; skipped: 'locked' | null; summary: string | null }>

/** 挂载的可注入面。测试用它把真 restic 换成假的。 */
export type MountDeps = {
  runHealth: HealthRunner
  runBackup: BackupRunner
  /** 透传命令用的那个跑进程函数；默认真起。 */
  run?: RunProcess | undefined
  /** 报时（测试拨钟）。 */
  now?: (() => Date) | undefined
}

/** 真身：跑全部五项，**不跳过快照**——快照新鲜度正是这条观察面最想看的一格。 */
const realHealth: HealthRunner = (paths, config) => runHealthCheck(paths, config, { skipSnapshots: false })

/** 真身：整条备份链路。占锁在 `backup.ts` 里，这里只把结论收成三格。 */
const realBackup: BackupRunner = async (paths, config) => {
  const result = await runFullBackup({ paths, config, logger: createLogger(paths.logFile) })
  if (result.skipped === 'locked') return { ok: false, skipped: 'locked', summary: null }
  return { ok: result.ok, skipped: null, summary: result.notification.body }
}

/**
 * 包根的 package.json 里读版本。本模块住 `dist/index.js`，包根在**上一层**——相对引用
 * 是 `'../package.json'`（`'./'` 会落到 dist/ 里去）。loader 可能带查询串 import 本模块
 * （缓存击穿的写法），`createRequire` 拿那种 URL 解析相对路径会炸，先剥掉 `?` 后面那段。
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
  // 五个服务的名字都经 declare module 挂在 Context 上，GwbContext 实际上就是 HostContext
  // 加一大截用不着的面；泛型自指的结构检查过不去，显式收窄一次（运行时零开销）
  mount(ctx as unknown as HostContext, { runHealth: realHealth, runBackup: realBackup })
}

/**
 * 全部挂载动作。`apply` 只是它的一层壳，负责把真身递进来。
 *
 * 拆成两层的唯一理由是**测试**：`runHealthCheck` 与 `runFullBackup` 都会起子进程，
 * 测试里必须换成假的。
 */
export function mount(ctx: HostContext, deps: MountDeps): void {
  const appliedAt = new Date().toISOString()
  const version = pluginVersion()
  const log = ctx.logger

  // ── 数据目录与格内布局（gwbData 是硬 inject，挂上时它必在）──────────────────
  const dataDir = ctx.gwbData.dir
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch (error) {
    // 建不出来不抛：命令面照常，跑备份那两头会自己报——为它把挂载整个弄坏不划算
    log.warn('数据目录建不出来：', messageOf(error))
  }
  const paths = layout(dataDir)

  /**
   * 每次现读的配置。设置件没有变更通知，缓存一份就会「设置改了、跑的还是旧值」；
   * 代价是每轮多几次内存里的 get，不值一提。
   */
  const currentFlat = (): FlatConfig => {
    const raw: Record<string, unknown> = {}
    for (const { key, field } of SETTING_KEYS) raw[field] = ctx.gwbSettings.get(key)
    return pickFlat(raw)
  }
  const currentConfig = (): BackupConfig => flatToConfig(currentFlat())

  /**
   * 全部可变状态。**只活在这一次 mount 的闭包里**——重挂会清零（上一轮结论没了，30 秒后
   * 重新跑一次自检），这是知情认下的代价：结论本身是「此刻的观察」，不值得为它开一份
   * 落盘账。真正要跨进程活着的那几格住 `state.json`。
   */
  const state = {
    /** 正在跑一次自检——**并发保护**：跑着的时候再触发不叠第二次。 */
    checking: false,
    lastReport: null as HealthReport | null,
    lastCheckedAt: null as string | null,
    nextCheckAt: null as string | null,
    /** 自检本身出错时的那句话（不是「备份有问题」，是「检查这件事崩了」）。 */
    lastError: null as string | null,
    /** 当前自检计时器按几小时在转；没起计时器是 `null`。 */
    intervalHours: null as number | null,
    /** **第一层并发保护**：这一个进程里正在跑一轮备份。第二层是数据目录的 backup.lock。 */
    backing: false,
    /** 当前备份计时器按几分钟在转；没起计时器是 `null`。 */
    frequencyMinutes: null as number | null,
    nextRunAt: null as string | null,
  }

  // ── 计时器 ───────────────────────────────────────────────────────────────────

  /** 自检那根的停法。换间隔时先停再起，不留双份。 */
  let stopCheckTimer: (() => void) | null = null
  /** 备份那根的停法。同上。 */
  let stopBackupTimer: (() => void) | null = null

  const startCheckTimer = (hours: number): void => {
    stopCheckTimer?.()
    const ms = intervalMsOf(hours)
    state.intervalHours = hours
    state.nextCheckAt = new Date(Date.now() + ms).toISOString()
    stopCheckTimer = ctx.interval(() => {
      // 每响一次把「下次」往后推，状态里才不会一直显示一个已经过去的时刻
      state.nextCheckAt = new Date(Date.now() + ms).toISOString()
      void runCheck()
    }, ms)
  }

  /** 间隔没变就只把下次时刻往后推，变了才重开——重开是有代价的（当前这一轮的计时清零）。 */
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
      // 每响一次就把「下一轮」往后推——只在起计时器时算一次的话，跑过一轮后状态回旧值
      state.nextRunAt = new Date(Date.now() + ms).toISOString()
      void runBackup('定时')
    }, ms)
  }

  /** 频率变了才重开——这就是「设置里改了 `frequency-minutes`，下一轮生效」挂着的地方。 */
  const syncBackupTimer = (minutes: number): void => {
    if (stopBackupTimer === null) return
    if (state.frequencyMinutes === minutes) return
    log.info(`备份周期变更：${String(state.frequencyMinutes)} 分钟 → ${String(minutes)} 分钟，计时器重开`)
    startBackupTimer(minutes)
  }

  // ── 备份 ─────────────────────────────────────────────────────────────────────

  /**
   * 跑一轮备份。**绝不抛**——它挂在计时器与命令两条路径上，从这儿冒出去会把周期弄死。
   *
   * 五种结局：`done`（跑完了，成没成看 `state.json`）/ `busy`（这个进程里已经有一轮在
   * 跑）/ `locked`（别的进程占着数据目录那把锁）/ `refused`（配置没填全）/ `not-ready`
   * （数据目录还没就绪）。
   */
  const runBackup = async (reason: string): Promise<'done' | 'busy' | 'locked' | 'refused' | 'not-ready'> => {
    // 第一层并发保护：同一个进程里不叠第二轮。第二层（跨进程）是 backup.lock
    if (state.backing) return 'busy'
    const config = currentConfig()
    // 现读的配置顺手对一次表：设置里改了频率，下一轮起就按新值转
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
      if (result.ok) log.info(`${reason}备份完成：${result.summary ?? '（没有小结）'}`)
      else log.warn(`${reason}备份失败：${result.summary ?? '（没有小结）'}——日志在 ${paths.logFile}`)
      return 'done'
    } catch (error) {
      log.warn(`${reason}备份没跑完（下一轮照跑）：`, messageOf(error))
      return 'done'
    } finally {
      state.backing = false
    }
  }

  // ── 自检 ─────────────────────────────────────────────────────────────────────

  /**
   * 跑一次自检。**绝不抛**——理由同上。
   *
   * 每轮**现读配置**：设置里改了值，这一轮就按新值跑、间隔也跟着重开。
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
      // 8 小时一次的里程碑：正常一行 info，有问题 warn 把清单念出来（分级看频率不看重要性）
      if (report.ok) {
        log.info('备份自检正常')
      } else {
        log.warn(`备份自检发现 ${String(report.problems.length)} 个问题：${report.problems.join('；')}`)
      }
    } catch (error) {
      // 「检查这件事崩了」跟「备份有问题」是两回事，分开记
      state.lastError = messageOf(error)
      log.warn('备份自检没跑完（下一轮照跑）：', state.lastError)
    } finally {
      state.checking = false
    }
    return 'done'
  }

  // ── 状态快照（status 命令的回包；窗格轮的就是它）─────────────────────

  /** 备份那一段的状态。`status` 的 `backup` 格与 `run` 命令的回包都用它。 */
  const backupInfo = (): Record<string, unknown> => {
    const disk = readState(paths.stateFile)
    return {
      frequencyMinutes: state.frequencyMinutes,
      running: state.backing,
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
   * 那头据此画灰灯。
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

  // ── 设置声明（15 个键）───────────────────────────────────────────────────────

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

  // ── 命令面（六条，一条一个 effect：某条注册撞名不该把别的几条也带走）──────────

  ctx.effect(() => {
    const off = ctx.gwbCommands.register(
      { name: 'windows-backup.run', description: '立刻跑一轮完整备份（= 定时那轮干的事）。占不到锁会如实说；配置没填全回拒跑理由', plugin: PKG },
      async () => {
        const outcome = await runBackup('手动')
        if (outcome === 'busy') return { ok: false, error: '这一轮已经有备份在跑（本进程）' }
        if (outcome === 'locked') return { ok: false, error: '另一轮备份正在跑（数据目录的锁被占着），稍后再试' }
        if (outcome === 'not-ready') return { ok: false, error: '数据目录还没就绪' }
        if (outcome === 'refused') return { ok: false, error: refuseReason(currentConfig()) }
        const disk = readState(paths.stateFile)
        return { ok: disk.lastRunOk ?? false, data: { ...backupInfo(), summary: disk.lastRunSummary ?? null } }
      },
    )
    return off
  })

  ctx.effect(() => {
    const off = ctx.gwbCommands.register(
      { name: 'windows-backup.check', description: '立刻跑一次五项健康检查，回全量状态（挂件看到的就是这份）', plugin: PKG },
      async () => {
        // 立刻跑，不等下一个周期——人点了「立即检查」就该马上有反应。
        // 正在跑时不叠第二次（runCheck 内部的 checking 挡着），结论照旧在回包里
        await runCheck()
        return { ok: true, data: snapshot() }
      },
    )
    return off
  })

  ctx.effect(() => {
    const off = ctx.gwbCommands.register(
      { name: 'windows-backup.status', description: '回全量状态：上次备份、自检结论、定时器节奏。窗格轮的就是它', plugin: PKG },
      () => ({ ok: true, data: snapshot() }),
    )
    return off
  })

  ctx.effect(() => {
    const off = ctx.gwbCommands.register(
      {
        name: 'windows-backup.paths',
        description: '回数据目录的全部路径：state.json / backup.lock / credentials 目录 / 日志 / bin。凡是要看凭据在不在、tail 日志的，先调这条拿路径，别猜',
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
          userExcludeFile: paths.userExcludeFile,
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
        description:
          '透传一条 restic 命令，自动补 --repo 与 --password-file：{ "repo": "local|oss", "args": ["snapshots"] }。' +
          'repo 缺省 local；args 原样递给 restic。密钥永不出现在参数里',
        plugin: PKG,
      },
      async (args: unknown) => {
        const body = isRecord(args) ? args : {}
        const repo = body.repo === 'oss' ? 'oss' : 'local'
        const resticArgs = Array.isArray(body.args) ? body.args.filter((one): one is string => typeof one === 'string') : []
        const config = currentConfig()
        const exe = resolveSlotPath(config.restic.exe, paths.dir)
        const repoUrl = repo === 'oss' ? ossRepoUrl(config.repositories.oss) : config.repositories.local.repo
        // OSS 那一趟才把 AccessKey 解析进子进程 env——本地那趟不带
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
        description: '补记周期动作的时间戳：{ "what": "usb-copy" | "exclude-audit", "at": "YYYY-MM-DD" }。at 缺省今天',
        plugin: PKG,
      },
      (args: unknown) => {
        const body = isRecord(args) ? args : {}
        const what = body.what
        if (what !== 'usb-copy' && what !== 'exclude-audit') {
          return { ok: false, error: 'what 只认 usb-copy 或 exclude-audit' }
        }
        const at = typeof body.at === 'string' && body.at.trim() !== '' ? body.at.trim() : todayLocal()
        const patch = what === 'usb-copy' ? { lastUsbCopy: at } : { lastExcludeAudit: at }
        const merged = writeState(paths.stateFile, patch)
        return { ok: true, data: { what, at, lastUsbCopy: merged.lastUsbCopy ?? null, lastExcludeAudit: merged.lastExcludeAudit ?? null } }
      },
    )
    return off
  })

  // ── 数据目录就绪：两根计时器 + 30 秒后的首检与补跑 ──────────────────────────

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

  // ── 界面占位（局部注入：缺席只是没有皮，备份本体照跑）────────────────────────

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

/** 错误对象取一句人话。`useUnknownInCatchVariables` 下 catch 到的是 unknown，这里收窄。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
