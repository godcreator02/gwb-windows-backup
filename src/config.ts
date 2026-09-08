/**
 * 配置——设置项那张平铺表，加一条通往程序内运行形状的桥。
 *
 * - **平铺形状 `FlatConfig`**：15 个键，键名与语义照老仓 god-windows-backup 一字不差
 *   （camelCase）。`sources` 在这一头是**分号分隔的一个串**（`D:/Notes;D:/Projects`），
 *   单值文本框装数组最自然的写法。这一头的键**不等于** gwb-settings 里的键——设置件
 *   只收 kebab-case，宿主层 `src/index.ts` 里有一张对照表负责换名。
 * - **嵌套形状 `BackupConfig`**：程序内部真正在用的那份（`sources` 在这一头是数组）。
 *
 * 老仓还有第三样东西——把配置写成数据区里 `config.json` 快照，那是给宿主无关的 CLI 门
 * 读的；那条门新线这轮没搬，快照也就不存在了（见 README 的「不做」）。
 *
 * **缺字段吃默认、类型不对吃默认**：设置件没有校验钩子，谁都能往键里写东西，读这一头
 * 就是全仓唯一的守门员。频率 / 自检间隔另有一条「非正数退回默认」——写 0 进去等于让
 * 定时器每 0 毫秒疯转，退回默认比照收安全。
 */

import os from 'node:os'
import path from 'node:path'

// ── 平铺形状（设置那张表）──────────────────────────────────────────────────────

/** 15 个键的全集。**顺序即设置界面里的显示顺序**。 */
export type FlatConfig = {
  /** 备份白名单，**分号分隔**；空则拒跑。 */
  sources: string
  /** 本地仓库路径；空则拒跑。 */
  localRepo: string
  ossEnabled: boolean
  ossBucket: string
  /** 完整主机名 `oss-cn-*.aliyuncs.com`。 */
  ossEndpoint: string
  ossRepoPath: string
  /** 定时备份周期（分钟）。 */
  frequencyMinutes: number
  keepWithin: string
  keepWithinDaily: string
  keepWeekly: number
  keepMonthly: number
  /** 周期自检间隔（小时）。 */
  healthCheckIntervalHours: number
  /** 备份结束弹 Windows 通知。 */
  toast: boolean
  /** restic 可执行文件；相对路径按数据目录解析，绝对路径原样。 */
  resticExe: string
  gomaxprocs: number
}

/**
 * 平铺默认值。留空的那几个（`sources` / `localRepo` / `ossBucket` / `ossEndpoint`）是
 * 「逐字段问用户」的字段，塞一个像模像样的假默认只会让人以为配好了。`ossEnabled`
 * 默认关：新机只配了本地仓库就跑备份，默认开着的话每一轮都会多一次注定失败的 OSS
 * 推送、通知报 partial——用户还没配 OSS，那不是故障。
 */
export const DEFAULT_FLAT: FlatConfig = {
  sources: '',
  localRepo: '',
  ossEnabled: false,
  ossBucket: '',
  ossEndpoint: '',
  ossRepoPath: 'restic-prod',
  frequencyMinutes: 30,
  keepWithin: '72h',
  keepWithinDaily: '14d',
  keepWeekly: 8,
  keepMonthly: 12,
  healthCheckIntervalHours: 8,
  toast: true,
  resticExe: 'bin/restic.exe',
  gomaxprocs: 1,
}

// ── 嵌套形状（程序内部）────────────────────────────────────────────────────────

export type ResticSection = {
  /** restic 可执行文件；相对路径按数据目录解析，绝对路径原样。 */
  exe: string
  gomaxprocs: number
}

export type OssSection = {
  enabled: boolean
  bucket: string
  repoPath: string
  endpoint: string
}

export type RetentionSection = {
  keepWithin: string
  keepWithinDaily: string
  keepWeekly: number
  keepMonthly: number
}

export type BackupConfig = {
  restic: ResticSection
  /** 备份白名单，逐条由用户口述——默认空，备份会因此拒跑。 */
  sources: string[]
  repositories: {
    local: { repo: string }
    oss: OssSection
  }
  /** 定时备份周期（分钟）。 */
  schedule: { frequencyMinutes: number }
  retention: RetentionSection
  /**
   * 日志轮转。**不在设置表上**——它不是用户该操心的旋钮，改它的人是在改代码不是在改
   * 配置。留在这份形状里是因为日志轮转要吃它。
   */
  logging: { rotateWhenBytes: number; keepLastLines: number }
  /** 周期自检间隔（小时）。 */
  healthCheckIntervalHours: number
  /** 备份结束弹不弹 Windows 通知。 */
  toast: boolean
}

/** 日志轮转的固定值（不上设置表，见 `BackupConfig.logging` 的注释）。 */
const DEFAULT_LOGGING = { rotateWhenBytes: 10_485_760, keepLastLines: 1000 }

// ── 两头之间的桥 ──────────────────────────────────────────────────────────────

/**
 * 把来路不明的一份值收成平铺配置。缺的、类型不对的一律吃默认。
 *
 * 调用处：宿主层从设置件读回的那 15 个值。
 */
export function pickFlat(value: unknown): FlatConfig {
  const raw = isPlainObject(value) ? value : {}
  const d = DEFAULT_FLAT
  return {
    sources: str(raw.sources, d.sources),
    localRepo: str(raw.localRepo, d.localRepo),
    ossEnabled: bool(raw.ossEnabled, d.ossEnabled),
    ossBucket: str(raw.ossBucket, d.ossBucket),
    ossEndpoint: str(raw.ossEndpoint, d.ossEndpoint),
    ossRepoPath: str(raw.ossRepoPath, d.ossRepoPath),
    frequencyMinutes: positive(num(raw.frequencyMinutes, d.frequencyMinutes), d.frequencyMinutes),
    keepWithin: str(raw.keepWithin, d.keepWithin),
    keepWithinDaily: str(raw.keepWithinDaily, d.keepWithinDaily),
    keepWeekly: positive(num(raw.keepWeekly, d.keepWeekly), d.keepWeekly),
    keepMonthly: positive(num(raw.keepMonthly, d.keepMonthly), d.keepMonthly),
    healthCheckIntervalHours: positive(
      num(raw.healthCheckIntervalHours, d.healthCheckIntervalHours),
      d.healthCheckIntervalHours,
    ),
    toast: bool(raw.toast, d.toast),
    resticExe: str(raw.resticExe, d.resticExe),
    gomaxprocs: positive(num(raw.gomaxprocs, d.gomaxprocs), d.gomaxprocs),
  }
}

/**
 * 分号串切成路径数组：**去空白、去空项**。
 *
 * `"D:/Notes; ;D:/Projects "` → `["D:/Notes", "D:/Projects"]`。用户多打一个分号是常态，
 * 切出来的空项要是原样进 `restic backup` 的 argv，restic 会去备份「当前目录」。
 */
export function splitSources(value: string): string[] {
  return value
    .split(';')
    .map((one) => one.trim())
    .filter((one) => one !== '')
}

/** 平铺表 → 程序内部那份嵌套形状。 */
export function flatToConfig(flat: unknown): BackupConfig {
  const f = pickFlat(flat)
  return {
    restic: { exe: f.resticExe, gomaxprocs: f.gomaxprocs },
    sources: splitSources(f.sources),
    repositories: {
      local: { repo: f.localRepo },
      oss: {
        enabled: f.ossEnabled,
        bucket: f.ossBucket,
        repoPath: f.ossRepoPath,
        endpoint: f.ossEndpoint,
      },
    },
    schedule: { frequencyMinutes: f.frequencyMinutes },
    retention: {
      keepWithin: f.keepWithin,
      keepWithinDaily: f.keepWithinDaily,
      keepWeekly: f.keepWeekly,
      keepMonthly: f.keepMonthly,
    },
    logging: { ...DEFAULT_LOGGING },
    healthCheckIntervalHours: f.healthCheckIntervalHours,
    toast: f.toast,
  }
}

/**
 * 路径类字段按数据目录解析：绝对路径原样、`~/` 展成家目录、其余按数据目录拼。
 *
 * `~/` 那一支是给从老线搬过来的旧配置留的——那些值里写的就是 `~/...`，直接当相对
 * 路径拼进数据目录会得到一条谁都不认识的路径。
 */
export function resolveSlotPath(value: string, slot: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(os.homedir(), trimmed.slice(2))
  }
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed)
  return path.resolve(slot, trimmed)
}

// ── 小工具 ────────────────────────────────────────────────────────────────────

/** 非正数退回默认——防「每 0 毫秒响一次的计时器」与「保留 0 份快照」那种配置。 */
function positive(value: number, fallback: number): number {
  return value > 0 ? value : fallback
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}
