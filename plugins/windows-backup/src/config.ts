import path from 'node:path'

/** 程序里用的配置：一个设置键一个字段，字段名是设置键的 camelCase。 */
export type BackupConfig = {
  /** 备份白名单，一行一项；空则拒跑。 */
  sources: string[]
  /** 追加的排除规则，追加在内置基线（包内 `config/restic-exclude.txt`）之上；`#` 开头的行是注释。 */
  exclude: string[]
  /** 本地仓库路径；空则拒跑。 */
  localRepo: string
  ossEnabled: boolean
  ossBucket: string
  /** 完整主机名 `oss-cn-*.aliyuncs.com`。 */
  ossEndpoint: string
  ossRepoPath: string
  frequencyMinutes: number
  keepWithin: string
  keepWithinDaily: string
  keepWeekly: number
  keepMonthly: number
  toast: boolean
  /** restic 可执行文件；相对路径按数据目录解析，绝对路径原样。 */
  resticExe: string
  gomaxprocs: number
  reviewIntervalDays: number
}

/** 数字项的取值范围。 */
type NumberRange = { min: number; integer: boolean }

type SettingCommon = { key: string; field: keyof BackupConfig; title: string; description: string; default: unknown }

/** 设置插件里的一项。设置插件不校验写进来的值，`readConfig` 按 `type`、`range`、`required` 把关。 */
export type SettingSpec = SettingCommon &
  (
    | { type: 'number'; range: NumberRange }
    /** `required`：字符串项不许是空串。 */
    | { type: 'string'; required?: boolean }
    | { type: 'boolean' }
    | { type: 'string-list' }
  )

/** 全部设置项。**顺序即设置界面里的显示顺序**。`sources` / `localRepo` / `ossBucket` / `ossEndpoint` 故意留空，`ossEnabled` 默认关。 */
export const SETTINGS: readonly SettingSpec[] = [
  { key: 'sources', field: 'sources', type: 'string-list', default: [], title: '备份白名单', description: '一行一项（如 D:/Notes）。空则不备份' },
  {
    key: 'exclude',
    field: 'exclude',
    type: 'string-list',
    default: [],
    title: '追加排除规则',
    description: '一行一条 restic 模式，追加在内置基线（通用垃圾：node_modules、dist、*.tmp、thumbs.db 等）之上、不是整替；# 开头的行是注释',
  },
  { key: 'local-repo', field: 'localRepo', type: 'string', default: '', title: '本地仓库', description: '本地 restic 仓库路径（如 D:/Backup/restic-repo）。留空则不备份' },
  { key: 'oss-enabled', field: 'ossEnabled', type: 'boolean', default: false, title: 'OSS 异地副本', description: '开启阿里云 OSS 异地副本。开着但 bucket / endpoint 没填会拒跑' },
  { key: 'oss-bucket', field: 'ossBucket', type: 'string', default: '', title: 'OSS bucket', description: 'OSS bucket 名字' },
  { key: 'oss-endpoint', field: 'ossEndpoint', type: 'string', default: '', title: 'OSS endpoint', description: '完整主机名（如 oss-cn-beijing.aliyuncs.com），不是地域代号' },
  { key: 'oss-repo-path', field: 'ossRepoPath', type: 'string', default: 'restic-prod', required: true, title: 'OSS 仓库路径', description: 'OSS 里的仓库路径（bucket 下那一层目录名）' },
  {
    key: 'frequency-minutes',
    field: 'frequencyMinutes',
    type: 'number',
    default: 30,
    range: { min: 1, integer: false },
    title: '备份周期（分钟）',
    description: '距上一轮结束满这么多分钟就跑下一轮（至少 1）；改了下一分钟起生效',
  },
  { key: 'keep-within', field: 'keepWithin', type: 'string', default: '72h', required: true, title: '保留窗口', description: 'restic forget 的 --keep-within（如 72h）' },
  { key: 'keep-within-daily', field: 'keepWithinDaily', type: 'string', default: '14d', required: true, title: '保留窗口（按日）', description: 'restic forget 的 --keep-within-daily（如 14d）' },
  { key: 'keep-weekly', field: 'keepWeekly', type: 'number', default: 8, range: { min: 0, integer: true }, title: '保留周快照数', description: 'restic forget 的 --keep-weekly：留几个周快照（整数，可以是 0）' },
  { key: 'keep-monthly', field: 'keepMonthly', type: 'number', default: 12, range: { min: 0, integer: true }, title: '保留月快照数', description: 'restic forget 的 --keep-monthly：留几个月快照（整数，可以是 0）' },
  { key: 'toast', field: 'toast', type: 'boolean', default: true, title: '结束通知', description: '每轮备份结束弹一条 Windows 通知' },
  {
    key: 'restic-exe',
    field: 'resticExe',
    type: 'string',
    default: 'bin/restic.exe',
    required: true,
    title: 'restic 位置',
    description: 'restic.exe 的位置：相对路径按数据目录解析（默认 bin/restic.exe），绝对路径原样用',
  },
  { key: 'gomaxprocs', field: 'gomaxprocs', type: 'number', default: 1, range: { min: 1, integer: true }, title: 'restic 并行度', description: 'restic 的 GOMAXPROCS（正整数）：调大更快也更吃 CPU' },
  {
    key: 'review-interval-days',
    field: 'reviewIntervalDays',
    type: 'number',
    default: 7,
    range: { min: 1, integer: false },
    title: '复核提醒（天）',
    description: '多久没人工复核备份就在窗格显示横幅（跑 check、看快照）；复核完调 mark review 记下日期',
  },
]

/**
 * 按设置键现读一份配置。值不合法就抛错，一次列出全部不合法的键与它们现在的值，不替它换成默认值。
 * `readSetting` 是设置插件的 `get`：没设过的项回声明时给的默认值。
 */
export function readConfig(readSetting: (key: string) => unknown): BackupConfig {
  const fields: Record<string, unknown> = {}
  const problems: string[] = []
  for (const spec of SETTINGS) {
    const raw = readSetting(spec.key)
    const problem = problemOf(spec, raw)
    if (problem === null) fields[spec.field] = spec.type === 'string-list' ? trimmedNonEmptyLines(raw as string[]) : raw
    else problems.push(`\`${spec.key}\` ${problem}，现在是 ${JSON.stringify(raw)}`)
  }
  if (problems.length > 0) throw new Error(`设置有误：${problems.join('；')}`)
  return fields as BackupConfig
}

/** 配置齐不齐、能不能开跑。回一句说明 = 拒跑的理由，回 `null` = 可以跑。理由里的键名是设置键。 */
export function refuseReason(config: BackupConfig): string | null {
  if (config.sources.length === 0) {
    return '还没配备份白名单：用设置把本插件的 `sources` 填上（一行一项，如 D:/Notes）。'
  }
  if (config.localRepo.trim() === '') {
    return '还没配本地仓库：用设置把本插件的 `local-repo` 填上（如 D:/Backup/restic-repo）。'
  }
  if (config.ossEnabled && !ossConfigured(config)) {
    return (
      'OSS 开着但还没配全：把本插件设置里的 `oss-bucket` 与 `oss-endpoint`（完整主机名 ' +
      'oss-cn-*.aliyuncs.com）填上，暂时不用 OSS 就把 `oss-enabled` 关掉。'
    )
  }
  return null
}

/** OSS 的 bucket 与 endpoint 都填了。 */
export function ossConfigured(config: Pick<BackupConfig, 'ossBucket' | 'ossEndpoint'>): boolean {
  return config.ossBucket.trim() !== '' && config.ossEndpoint.trim() !== ''
}

/** restic.exe 的绝对路径：绝对路径原样，相对路径按数据目录拼。 */
export function resolveResticExe(resticExe: string, dataDir: string): string {
  return path.resolve(dataDir, resticExe.trim())
}

/** 这一项的值哪里不对；没问题回 `null`。 */
function problemOf(spec: SettingSpec, raw: unknown): string | null {
  switch (spec.type) {
    case 'string':
      if (typeof raw !== 'string') return '要是字符串'
      return spec.required === true && raw.trim() === '' ? '不能是空的' : null
    case 'boolean':
      return typeof raw === 'boolean' ? null : '要是 true 或 false'
    case 'string-list':
      return Array.isArray(raw) && raw.every((one) => typeof one === 'string') ? null : '要是字符串数组（一行一项）'
    case 'number':
      return numberProblem(raw, spec.range)
  }
}

function numberProblem(raw: unknown, range: NumberRange): string | null {
  const shape = range.integer ? '整数' : '数'
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return `要是${shape}`
  if (range.integer && !Number.isInteger(raw)) return '要是整数'
  return raw < range.min ? `要是不小于 ${String(range.min)} 的${shape}` : null
}

/** 界面逐行编辑的列表：每行去掉首尾空白，空行去掉。 */
function trimmedNonEmptyLines(lines: readonly string[]): string[] {
  return lines.map((one) => one.trim()).filter((one) => one !== '')
}
