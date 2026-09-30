import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { localDate, localTimestamp, minutesSince, parseLocalTimestamp } from './clock.js'

export type BackupState = {
  /** 上次跑完一轮全流程备份的本地时间，`YYYY-MM-DDTHH:MM:SS`。**成败都记**。 */
  lastRunAt?: string
  /** 那一轮成没成：本地备份成功，并且 OSS 关着或 OSS 那次也成功。 */
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

/** 读；文件缺失 / 内容坏 / 不是对象一律当 `{}`——坏了最多提前跑一轮、多跑一次 prune。 */
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

/** 该跑下一轮了：从没跑过，或上一轮结束已满一个周期。定时那一跳每分钟问一次。 */
export function backupIsDue(lastRunAt: string | undefined, frequencyMinutes: number, now: Date): boolean {
  const minutesSinceLastRun = minutesSince(lastRunAt, now)
  return minutesSinceLastRun === null || minutesSinceLastRun >= frequencyMinutes
}

/** 下一轮最早什么时候跑（本地时间戳）：上一轮结束加一个周期，已经到期就是现在。 */
export function nextRunAt(lastRunAt: string | undefined, frequencyMinutes: number, now: Date): string {
  const last = parseLocalTimestamp(lastRunAt)
  if (last === null) return localTimestamp(now)
  const due = new Date(last.getTime() + frequencyMinutes * 60_000)
  return localTimestamp(due > now ? due : now)
}

/** 每日一次：没记过、或记的不是今天，就该跑。 */
export function shouldRunPrune(state: BackupState, now: Date = new Date()): boolean {
  const lastPrune = state.lastPrune
  if (typeof lastPrune !== 'string' || lastPrune.length < 10) return true
  return lastPrune.slice(0, 10) !== localDate(now)
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
