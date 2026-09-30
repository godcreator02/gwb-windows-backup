/** 本地日期 `YYYY-MM-DD`——「跨日」按人过的日子算，用本地时区。 */
export function localDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`
}

/** 本地时间戳 `YYYY-MM-DDTHH:MM:SS`，不带时区标记（state.json 里一直是这个写法）。 */
export function localTimestamp(now: Date = new Date()): string {
  return `${localDate(now)}T${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}:${twoDigits(now.getSeconds())}`
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

/** 距某个时间戳过了几分钟（四舍五入）。值缺失 / 认不出返回 `null`——调用方按「从没跑过」处理。 */
export function minutesSince(value: string | undefined, now: Date = new Date()): number | null {
  const parsed = parseLocalTimestamp(value)
  if (parsed === null) return null
  return Math.round((now.getTime() - parsed.getTime()) / 60_000)
}

/**
 * `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:MM:SS` → Date。不带时区标记的串被 `new Date` 按本地时间解析，
 * 正是 `localTimestamp` 写进去的口径。缺失 / 认不出回 `null`。
 */
export function parseLocalTimestamp(value: string | undefined): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00` : value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}
