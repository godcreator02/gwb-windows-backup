/**
 * `windows-backup.status` 回执（`{ ok, data, error }`）收窄成窗格要用的形状。
 * 形状的正本是 node 侧 `src/index.ts` 的 `snapshot()`，这里只收用得上的字段。
 */

export type ItemStatus = 'ok' | 'problem' | 'unknown'

export interface ReportItemView {
  status: ItemStatus
  message: string
}

export interface HealthView {
  ok: boolean
  problems: string[]
  items: {
    lastRun: ReportItemView
    disk: ReportItemView
    snapshots: ReportItemView
  }
}

export interface ReminderView {
  what: string
  message: string
}

export interface StatusView {
  version: string
  dataDir: string | null
  /** 为什么不跑备份（设置没填全或不合法）；`null` = 可以跑。 */
  refuseReason: string | null
  /** `null` = 设置不合法、判不了。 */
  health: HealthView | null
  reminders: ReminderView[]
  backup: {
    frequencyMinutes: number | null
    running: boolean
    lastRunAt: string | null
    lastRunOk: boolean | null
    lastRunSummary: string | null
    nextRunAt: string | null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const finiteNumberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const booleanOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

function readItem(value: unknown): ReportItemView {
  if (!isRecord(value)) return { status: 'unknown', message: '' }
  const status = value.status
  const message = typeof value.message === 'string' ? value.message : ''
  return { status: status === 'ok' || status === 'problem' ? status : 'unknown', message }
}

function readHealth(value: unknown): HealthView | null {
  if (!isRecord(value)) return null
  const items = isRecord(value.items) ? value.items : {}
  return {
    ok: value.ok === true,
    problems: Array.isArray(value.problems) ? value.problems.filter((problem): problem is string => typeof problem === 'string') : [],
    items: { lastRun: readItem(items.lastRun), disk: readItem(items.disk), snapshots: readItem(items.snapshots) },
  }
}

function readReminders(value: unknown): ReminderView[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((one) => ({ what: stringOrNull(one.what) ?? '', message: stringOrNull(one.message) ?? '' }))
}

/** `host.call('windows-backup.status')` 的回执 → 展示形状；回执不是成功态回 undefined。 */
export function readStatus(value: unknown): StatusView | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined
  const data = isRecord(value.data) ? value.data : {}
  const backup = isRecord(data.backup) ? data.backup : {}
  return {
    version: stringOrNull(data.version) ?? '?',
    dataDir: stringOrNull(data.dataDir),
    refuseReason: stringOrNull(data.refuseReason),
    health: readHealth(data.health),
    reminders: readReminders(data.reminders),
    backup: {
      frequencyMinutes: finiteNumberOrNull(backup.frequencyMinutes),
      running: booleanOrNull(backup.running) ?? false,
      lastRunAt: stringOrNull(backup.lastRunAt),
      lastRunOk: booleanOrNull(backup.lastRunOk),
      lastRunSummary: stringOrNull(backup.lastRunSummary),
      nextRunAt: stringOrNull(backup.nextRunAt),
    },
  }
}

/** 状态灯：拒跑与健康问题都是黄灯；判不了（设置不合法）也是黄灯，因为备份此刻停着。 */
export function toneOf(status: StatusView): { tone: 'ok' | 'warn'; label: string } {
  if (status.refuseReason !== null) return { tone: 'warn', label: '备份停着' }
  if (status.health === null) return { tone: 'warn', label: '判不了' }
  if (status.health.ok) return { tone: 'ok', label: '一切正常' }
  return { tone: 'warn', label: `${String(status.health.problems.length)} 项问题` }
}

/** 三项各自的条目名（展示顺序同 node 侧的报告）。 */
export const ITEM_LABELS: ReadonlyArray<{ key: keyof HealthView['items']; label: string }> = [
  { key: 'lastRun', label: '上次备份' },
  { key: 'disk', label: '磁盘余量' },
  { key: 'snapshots', label: '快照新鲜度' },
]

/** 本地时间串里的 `HH:MM`；认不出回 '—'。 */
export function clockOf(value: string | null): string {
  if (value === null) return '—'
  const match = /T(\d{2}:\d{2})/.exec(value)
  return match?.[1] ?? '—'
}
