import { DEFAULT_FLAT } from './config.js'
import { minutesSince } from './state.js'

/** 自检间隔：小时 → 毫秒，非正数或非有限数退回默认值（不夹到边界）。 */
export function intervalMsOf(hours: number): number {
  const validHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_FLAT.healthCheckIntervalHours
  return validHours * 3600 * 1000
}

/** 备份周期：分钟 → 毫秒，小于 1 或非有限数退回默认值。 */
export function backupIntervalMsOf(minutes: number): number {
  const validMinutes = Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_FLAT.frequencyMinutes
  return validMinutes * 60 * 1000
}

/** 加载 30 秒后该不该补跑一轮：从没跑过，或上一轮离现在已满一个周期。 */
export function shouldCatchUp(lastRunAt: string | undefined, frequencyMinutes: number, now: Date): boolean {
  const minutesSinceLastRun = minutesSince(lastRunAt, now)
  if (minutesSinceLastRun === null) return true
  return minutesSinceLastRun >= frequencyMinutes
}
