/**
 * 周期换算与补跑判据——定时器本体用官方 `@cordisjs/plugin-timer`（`ctx.interval` /
 * `ctx.timeout`，fiber 感知），这儿只留三个纯函数：
 *
 * - `intervalMsOf` / `backupIntervalMsOf`：设置里的小时数 / 分钟数收成毫秒。谁都能往
 *   设置里写 `0` 或负数（设置件没有校验钩子），那会得到一个每 0 毫秒响一次的计时器。
 *   不合法就退回默认值，**不悄悄夹到边界**。（`pickFlat` 已挡一道，这里再挡一道——
 *   两处的默认值都来自 `DEFAULT_FLAT`，不许第二处写死数字。）
 * - `shouldCatchUp`：起来 30 秒后该不该补跑一轮。
 */

import { DEFAULT_FLAT } from './config.js'
import { minutesSince } from './state.js'

export function intervalMsOf(hours: number): number {
  const safe = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_FLAT.healthCheckIntervalHours
  return safe * 3600 * 1000
}

/** 备份周期那根：分钟 → 毫秒，不合法退回默认 30 分钟。 */
export function backupIntervalMsOf(minutes: number): number {
  const safe = Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_FLAT.frequencyMinutes
  return safe * 60 * 1000
}

/**
 * 该不该在起来 30 秒后补跑一轮。
 *
 * 判据是「上一轮离现在有没有超过一个周期」——宿主停了一夜、或者从没跑过，起来就该补上；
 * 十分钟前刚跑过就别急着再跑一次（周期那根会在一个周期后自然轮到）。
 */
export function shouldCatchUp(lastRunAt: string | undefined, frequencyMinutes: number, now: Date): boolean {
  // 分钟差按 state.ts 的口径算（无时区标记按本地时间解析——跟写进去的口径对得上）
  const age = minutesSince(lastRunAt, now)
  if (age === null) return true
  return age >= frequencyMinutes
}
