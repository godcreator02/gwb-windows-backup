/**
 * `state.json` —— 动作时间戳，落在数据目录里（宿主层用 `ctx.gwbData.dir` 定位）。
 *
 * 取代靠 mtime 判跨日的空文件存法：mtime 这种「载重信息在元数据里」的存法，任何一次
 * 拷贝 / 同步 / 解压都可能把它抹平，而抹平的症状是 prune 每次都跑或永远不跑。换成显式
 * 字段后，语义仍是「本地日期跨日才再跑」。
 *
 * **fail-safe**：解析失败当空对象。这份文件坏掉最坏的后果是多跑一次 prune，为它中断整条
 * 备份链路不划算。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type BackupState = {
  /**
   * 上次跑完一轮全流程备份的本地时间，`YYYY-MM-DDTHH:MM:SS`。
   *
   * **成败都记**——它回答的是「这台机器上次备份是什么时候」，健康检查的「上次备份」
   * 那一项与开机补跑的判定读的都是它。只在成功时记的话，连着失败三天看起来会像
   * 「三天前刚备过」。
   */
  lastRunAt?: string
  /** 那一轮成没成。 */
  lastRunOk?: boolean
  /** 那一轮的一句话小结，如 `4.9 KiB | local 0:01`（= 通知正文）。 */
  lastRunSummary?: string
  /** 上次 forget+prune 成功的本地时间，`YYYY-MM-DDTHH:MM:SS`；判跨日只看前 10 位。 */
  lastPrune?: string
  /** 上次 USB 离机副本的本地日期，`YYYY-MM-DD`。 */
  lastUsbCopy?: string
  /** 上次 exclude 误伤扫描的本地日期，`YYYY-MM-DD`。 */
  lastExcludeAudit?: string
}

/** 读；文件缺失 / 内容坏 / 不是对象一律当 `{}`。 */
export function readState(file: string): BackupState {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return pick(parsed as Record<string, unknown>)
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

/** 本地日期 `YYYY-MM-DD`——用本地时区，因为「跨日」是人过的那个日子，不是 UTC 的。 */
export function localDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}

/** 本地时间戳 `YYYY-MM-DDTHH:MM:SS`，无时区标记（跟老仓的写法一致，存量对得上）。 */
export function localTimestamp(now: Date = new Date()): string {
  return `${localDate(now)}T${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`
}

/** 每日一次：没记过、或记的不是今天，就该跑。 */
export function shouldRunPrune(state: BackupState, now: Date = new Date()): boolean {
  const last = state.lastPrune
  if (typeof last !== 'string' || last.length < 10) return true
  return last.slice(0, 10) !== localDate(now)
}

/**
 * 距某个时间戳过了几天（按本地日历日算，不是 24 小时整除）。
 * 值缺失 / 认不出返回 `null`——调用方按「从没做过」处理。
 */
export function daysSince(value: string | undefined, now: Date = new Date()): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00` : value)
  if (Number.isNaN(parsed.getTime())) return null
  const a = Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((b - a) / 86_400_000)
}

/**
 * 距某个时间戳过了几分钟（四舍五入）。值缺失 / 认不出返回 `null`——调用方按「从没跑过」处理。
 *
 * 无时区标记的 `YYYY-MM-DDTHH:MM:SS` 被 `new Date` 当**本地时间**解析，正是
 * `localTimestamp` 写进去的那个口径，两头对得上。
 */
export function minutesSince(value: string | undefined, now: Date = new Date()): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00` : value)
  if (Number.isNaN(parsed.getTime())) return null
  return Math.round((now.getTime() - parsed.getTime()) / 60_000)
}

function pick(raw: Record<string, unknown>): BackupState {
  const state: BackupState = {}
  for (const key of ['lastRunAt', 'lastRunSummary', 'lastPrune', 'lastUsbCopy', 'lastExcludeAudit'] as const) {
    const value = raw[key]
    if (typeof value === 'string') state[key] = value
  }
  // 唯一的布尔格单独收：混进上面那圈会被 `typeof value === 'string'` 静默吃掉
  if (typeof raw.lastRunOk === 'boolean') state.lastRunOk = raw.lastRunOk
  return state
}

function two(value: number): string {
  return String(value).padStart(2, '0')
}
