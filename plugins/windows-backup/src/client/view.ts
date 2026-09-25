/**
 * `windows-backup.status` 回执（`{ ok, data, error }`）收窄成窗格要用的形状。
 * 形状的正本是 node 侧 `src/index.ts` 的 `snapshot()`，这里只收用得上的字段。
 */

export type ItemStatus = 'ok' | 'problem' | 'unknown' | 'skipped'

export interface ReportItemView {
  status: ItemStatus
  message: string
}

export interface ReportView {
  checkedAt: string
  ok: boolean
  problems: string[]
  items: {
    lastRun: ReportItemView
    log: ReportItemView
    disk: ReportItemView
    snapshots: ReportItemView
    periodic: ReportItemView & { reviewDue: boolean }
  }
}

export interface StatusView {
  version: string
  moduleLoadedAt: string
  dataDir: string | null
  intervalHours: number | null
  checking: boolean
  lastCheckedAt: string | null
  nextCheckAt: string | null
  lastError: string | null
  report: ReportView | null
  /** 该人工复核备份了（周期项的 reviewDue）——窗格据此挂横幅。 */
  reviewDue: boolean
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
  if (status === 'ok' || status === 'problem' || status === 'unknown' || status === 'skipped') {
    return { status, message }
  }
  return { status: 'unknown', message }
}

function readReport(value: unknown): ReportView | null {
  if (!isRecord(value)) return null
  const items = isRecord(value.items) ? value.items : {}
  return {
    checkedAt: stringOrNull(value.checkedAt) ?? '',
    ok: value.ok === true,
    problems: Array.isArray(value.problems) ? value.problems.filter((problem): problem is string => typeof problem === 'string') : [],
    items: {
      lastRun: readItem(items.lastRun),
      log: readItem(items.log),
      disk: readItem(items.disk),
      snapshots: readItem(items.snapshots),
      periodic: { ...readItem(items.periodic), reviewDue: isRecord(items.periodic) ? items.periodic.reviewDue === true : false },
    },
  }
}

/** `host.call('windows-backup.status')` 的回执 → 展示形状；回执不是成功态回 undefined。 */
export function readStatus(value: unknown): StatusView | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined
  const data = isRecord(value.data) ? value.data : {}
  const backup = isRecord(data.backup) ? data.backup : {}
  const report = data.report === null ? null : readReport(data.report)
  return {
    version: stringOrNull(data.version) ?? '?',
    moduleLoadedAt: stringOrNull(data.moduleLoadedAt) ?? '',
    dataDir: stringOrNull(data.dataDir),
    intervalHours: finiteNumberOrNull(data.intervalHours),
    checking: booleanOrNull(data.checking) ?? false,
    lastCheckedAt: stringOrNull(data.lastCheckedAt),
    nextCheckAt: stringOrNull(data.nextCheckAt),
    lastError: stringOrNull(data.lastError),
    report,
    reviewDue: report?.items.periodic.reviewDue ?? false,
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

/** 状态灯：`report` 为 `null` 是还没有结论（灰），不是「没问题」。 */
export function toneOf(status: StatusView): { tone: 'ok' | 'warn' | 'muted'; label: string } {
  const report = status.report
  if (report === null) return { tone: 'muted', label: '还没检查过' }
  if (report.ok) return { tone: 'ok', label: '一切正常' }
  return { tone: 'warn', label: `${report.problems.length} 项问题` }
}

/** 五项各自的条目名（展示顺序同 node 侧的报告）。 */
export const ITEM_LABELS: ReadonlyArray<{ key: keyof ReportView['items']; label: string }> = [
  { key: 'lastRun', label: '上次备份' },
  { key: 'log', label: '备份日志' },
  { key: 'disk', label: '磁盘余量' },
  { key: 'snapshots', label: '快照新鲜度' },
  { key: 'periodic', label: '周期维护' },
]

/** 本地时间串 / ISO 串里的 `HH:MM`；认不出回 '—'。 */
export function clockOf(value: string | null): string {
  if (value === null) return '—'
  const match = /T(\d{2}:\d{2})/.exec(value)
  return match?.[1] ?? '—'
}
