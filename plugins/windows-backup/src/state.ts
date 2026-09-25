import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type BackupState = {
  /** 上次跑完一轮全流程备份的本地时间，`YYYY-MM-DDTHH:MM:SS`。**成败都记**。 */
  lastRunAt?: string
  /** 那一轮成没成。 */
  lastRunOk?: boolean
  /** 那一轮的一句话小结，如 `4.9 KiB | local 0:01`（= 通知正文）。 */
  lastRunSummary?: string
  /** 最近一次成功的本地备份留在**本地仓**里的快照 ID，下一轮交给 restic 的 `--parent`。 */
  lastLocalSnapshot?: string
  /** 同上，**OSS 仓**那一份——两个仓各自一条快照链，ID 不通用。 */
  lastOssSnapshot?: string
  /** 上次 forget+prune 成功的本地时间，`YYYY-MM-DDTHH:MM:SS`；判跨日只看前 10 位。 */
  lastPrune?: string
  /** 上次 USB 离机副本的本地日期，`YYYY-MM-DD`。 */
  lastUsbCopy?: string
  /** 上次 exclude 误伤扫描的本地日期，`YYYY-MM-DD`。 */
  lastExcludeAudit?: string
  /** 上次人工复核备份的本地日期，`YYYY-MM-DD`。 */
  lastReview?: string
}

/** 读；文件缺失 / 内容坏 / 不是对象一律当 `{}`——坏了最多多跑一次 prune。 */
export function readState(file: string): BackupState {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return pickKnownFields(parsed as Record<string, unknown>)
  } catch {
    return {}
  }
}

/** merge 写：只动 `patch` 里的键，别的字段原样留着。返回写回后的全量。 */
export function writeState(file: string, patch: BackupState): BackupState {
  const merged = { ...readState(file), ...patch }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return merged
}

/** 本地日期 `YYYY-MM-DD`——「跨日」按人过的日子算，用本地时区。 */
export function localDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`
}

/** 本地时间戳 `YYYY-MM-DDTHH:MM:SS`，不带时区标记（存量 state.json 就是这个写法）。 */
export function localTimestamp(now: Date = new Date()): string {
  return `${localDate(now)}T${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}:${twoDigits(now.getSeconds())}`
}

/** 每日一次：没记过、或记的不是今天，就该跑。 */
export function shouldRunPrune(state: BackupState, now: Date = new Date()): boolean {
  const lastPrune = state.lastPrune
  if (typeof lastPrune !== 'string' || lastPrune.length < 10) return true
  return lastPrune.slice(0, 10) !== localDate(now)
}

/**
 * 距某个时间戳过了几天（按本地日历日算，不是 24 小时整除）。
 * 值缺失 / 认不出返回 `null`——调用方按「从没做过」处理。
 */
export function daysSince(value: string | undefined, now: Date = new Date()): number | null {
  const parsed = parseLocalTimestamp(value)
  if (parsed === null) return null
  const thenUtcDay = Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())
  const todayUtcDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((todayUtcDay - thenUtcDay) / 86_400_000)
}

/**
 * 距某个时间戳过了几分钟（四舍五入）。值缺失 / 认不出返回 `null`——调用方按「从没跑过」处理。
 */
export function minutesSince(value: string | undefined, now: Date = new Date()): number | null {
  const parsed = parseLocalTimestamp(value)
  if (parsed === null) return null
  return Math.round((now.getTime() - parsed.getTime()) / 60_000)
}

/**
 * `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:MM:SS` → Date。不带时区标记的串被 `new Date` 按本地时间解析，
 * 正是 `localTimestamp` 写进去的口径。缺失 / 认不出回 `null`。
 */
function parseLocalTimestamp(value: string | undefined): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00` : value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const STRING_FIELDS = [
  'lastRunAt',
  'lastRunSummary',
  'lastLocalSnapshot',
  'lastOssSnapshot',
  'lastPrune',
  'lastUsbCopy',
  'lastExcludeAudit',
  'lastReview',
] as const

function pickKnownFields(fields: Record<string, unknown>): BackupState {
  const state: BackupState = {}
  for (const key of STRING_FIELDS) {
    const value = fields[key]
    if (typeof value === 'string') state[key] = value
  }
  if (typeof fields.lastRunOk === 'boolean') state.lastRunOk = fields.lastRunOk
  return state
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}
