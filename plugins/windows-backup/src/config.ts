import os from 'node:os'
import path from 'node:path'

/**
 * 设置那一头的平铺形状，17 个键（camelCase；设置插件里的 kebab-case 键名由 `src/index.ts` 的对照表换过来）。
 * **顺序即设置界面里的显示顺序**。
 */
export type FlatConfig = {
  /** 备份白名单，一行一项；空则拒跑。分号分隔的一整串也认。 */
  sources: string[]
  /** 追加的排除规则（一行一条，追加在内置基线之上）；`#` 开头的行是注释。 */
  exclude: string[]
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
  /** 人工复核提醒间隔（天）：到期窗格挂横幅，`mark review` 销账。 */
  reviewIntervalDays: number
}

/** 平铺默认值。`sources` / `localRepo` / `ossBucket` / `ossEndpoint` 故意留空，`ossEnabled` 默认关。 */
export const DEFAULT_FLAT: FlatConfig = {
  sources: [],
  exclude: [],
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
  reviewIntervalDays: 7,
}

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

/** 程序内部用的嵌套形状。 */
export type BackupConfig = {
  restic: ResticSection
  sources: string[]
  /** 追加的排除规则——**合并**在内置基线（包内 `config/restic-exclude.txt`）之上，不是整替。 */
  exclude: string[]
  repositories: {
    local: { repo: string }
    oss: OssSection
  }
  schedule: { frequencyMinutes: number }
  retention: RetentionSection
  /** 日志轮转，固定值，不在设置表上。 */
  logging: { rotateWhenBytes: number; keepLastLines: number }
  healthCheckIntervalHours: number
  toast: boolean
  reviewIntervalDays: number
}

const DEFAULT_LOGGING = { rotateWhenBytes: 10_485_760, keepLastLines: 1000 }

/** 把来路不明的一份值收成平铺配置。缺的、类型不对的、该是正数却不是的，一律用默认值。 */
export function pickFlat(value: unknown): FlatConfig {
  const fields = isPlainObject(value) ? value : {}
  const defaults = DEFAULT_FLAT
  return {
    sources: toSourceList(fields.sources),
    exclude: toExcludeList(fields.exclude),
    localRepo: stringOr(fields.localRepo, defaults.localRepo),
    ossEnabled: booleanOr(fields.ossEnabled, defaults.ossEnabled),
    ossBucket: stringOr(fields.ossBucket, defaults.ossBucket),
    ossEndpoint: stringOr(fields.ossEndpoint, defaults.ossEndpoint),
    ossRepoPath: stringOr(fields.ossRepoPath, defaults.ossRepoPath),
    frequencyMinutes: positiveNumberOr(fields.frequencyMinutes, defaults.frequencyMinutes),
    keepWithin: stringOr(fields.keepWithin, defaults.keepWithin),
    keepWithinDaily: stringOr(fields.keepWithinDaily, defaults.keepWithinDaily),
    keepWeekly: positiveNumberOr(fields.keepWeekly, defaults.keepWeekly),
    keepMonthly: positiveNumberOr(fields.keepMonthly, defaults.keepMonthly),
    healthCheckIntervalHours: positiveNumberOr(fields.healthCheckIntervalHours, defaults.healthCheckIntervalHours),
    toast: booleanOr(fields.toast, defaults.toast),
    resticExe: stringOr(fields.resticExe, defaults.resticExe),
    gomaxprocs: positiveNumberOr(fields.gomaxprocs, defaults.gomaxprocs),
    reviewIntervalDays: positiveNumberOr(fields.reviewIntervalDays, defaults.reviewIntervalDays),
  }
}

/** 分号串切成路径数组：**去空白、去空项**。`"D:/Notes; ;D:/Projects "` → `["D:/Notes", "D:/Projects"]`。 */
export function splitSources(value: string): string[] {
  return value
    .split(';')
    .map((one) => one.trim())
    .filter((one) => one !== '')
}

/** 收 sources：数组逐条收字符串（trim、去空）；分号串走 `splitSources`。 */
export function toSourceList(value: unknown): string[] {
  return trimmedNonEmptyLines(value)
}

/** 收 exclude：同 `toSourceList`。`#` 开头的注释行留着，进 argv 时由 `excludeArgv` 滤掉。 */
export function toExcludeList(value: unknown): string[] {
  return trimmedNonEmptyLines(value)
}

function trimmedNonEmptyLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((one): one is string => typeof one === 'string')
      .map((one) => one.trim())
      .filter((one) => one !== '')
  }
  if (typeof value === 'string') return splitSources(value)
  return []
}

/** 平铺表 → 程序内部那份嵌套形状。 */
export function flatToConfig(flat: unknown): BackupConfig {
  const picked = pickFlat(flat)
  return {
    restic: { exe: picked.resticExe, gomaxprocs: picked.gomaxprocs },
    sources: picked.sources,
    exclude: picked.exclude,
    repositories: {
      local: { repo: picked.localRepo },
      oss: {
        enabled: picked.ossEnabled,
        bucket: picked.ossBucket,
        repoPath: picked.ossRepoPath,
        endpoint: picked.ossEndpoint,
      },
    },
    schedule: { frequencyMinutes: picked.frequencyMinutes },
    retention: {
      keepWithin: picked.keepWithin,
      keepWithinDaily: picked.keepWithinDaily,
      keepWeekly: picked.keepWeekly,
      keepMonthly: picked.keepMonthly,
    },
    logging: { ...DEFAULT_LOGGING },
    healthCheckIntervalHours: picked.healthCheckIntervalHours,
    toast: picked.toast,
    reviewIntervalDays: picked.reviewIntervalDays,
  }
}

/** 路径类字段按数据目录解析：绝对路径原样、`~` / `~/` 展成家目录、其余按数据目录拼。 */
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function positiveNumberOr(value: unknown, fallback: number): number {
  const number = finiteNumberOr(value, fallback)
  return number > 0 ? number : fallback
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}
