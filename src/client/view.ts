/**
 * `windows-backup.status` 回包的收窄与展示口径——窗格与状态格共用。
 *
 * 命令总线回的是整份 `GwbResult`（`{ ok, data, error }`），这儿拆包收窄；形状的正本在
 * node 半 `src/index.ts` 的 `snapshot()`，这一头只按「用得上」收窄，不照抄全量字段。
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
    periodic: ReportItemView
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

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

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
    checkedAt: str(value.checkedAt) ?? '',
    ok: value.ok === true,
    problems: Array.isArray(value.problems) ? value.problems.filter((p): p is string => typeof p === 'string') : [],
    items: {
      lastRun: readItem(items.lastRun),
      log: readItem(items.log),
      disk: readItem(items.disk),
      snapshots: readItem(items.snapshots),
      periodic: readItem(items.periodic),
    },
  }
}

/** `host.call('windows-backup.status')` 的回包 → 展示形状；回包不是成功态回 undefined。 */
export function readStatus(value: unknown): StatusView | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined
  const data = isRecord(value.data) ? value.data : {}
  const backup = isRecord(data.backup) ? data.backup : {}
  return {
    version: str(data.version) ?? '?',
    moduleLoadedAt: str(data.moduleLoadedAt) ?? '',
    dataDir: str(data.dataDir),
    intervalHours: num(data.intervalHours),
    checking: bool(data.checking) ?? false,
    lastCheckedAt: str(data.lastCheckedAt),
    nextCheckAt: str(data.nextCheckAt),
    lastError: str(data.lastError),
    report: data.report === null ? null : readReport(data.report),
    backup: {
      frequencyMinutes: num(backup.frequencyMinutes),
      running: bool(backup.running) ?? false,
      lastRunAt: str(backup.lastRunAt),
      lastRunOk: bool(backup.lastRunOk),
      lastRunSummary: str(backup.lastRunSummary),
      nextRunAt: str(backup.nextRunAt),
    },
  }
}

/** 状态灯的口径：report null = 还没结论（灰），不是「没问题」。 */
export function toneOf(status: StatusView): { tone: 'ok' | 'warn' | 'muted'; label: string } {
  const report = status.report
  if (report === null) return { tone: 'muted', label: '还没检查过' }
  if (report.ok) return { tone: 'ok', label: '一切正常' }
  return { tone: 'warn', label: `${report.problems.length} 项问题` }
}

/** 五项各自的条目名（展示顺序同 node 半的报告）。 */
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
