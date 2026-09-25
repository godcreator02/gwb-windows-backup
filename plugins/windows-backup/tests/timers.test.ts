import { describe, expect, it } from 'vitest'
import { backupIntervalMsOf, intervalMsOf, shouldCatchUp } from '../src/timers.js'

describe('换算与兜底', () => {
  it('intervalMsOf：不合法退默认 8 小时，不夹边界', () => {
    expect(intervalMsOf(1)).toBe(3_600_000)
    expect(intervalMsOf(0)).toBe(8 * 3_600_000)
    expect(intervalMsOf(-3)).toBe(8 * 3_600_000)
    expect(intervalMsOf(Number.NaN)).toBe(8 * 3_600_000)
  })

  it('backupIntervalMsOf：不合法退默认 30 分钟', () => {
    expect(backupIntervalMsOf(30)).toBe(1_800_000)
    expect(backupIntervalMsOf(0)).toBe(1_800_000)
  })

  it('shouldCatchUp：从没跑过 / 超过一个周期 → true；刚跑过 → false', () => {
    const now = new Date(2026, 8, 8, 10, 0, 0)
    expect(shouldCatchUp(undefined, 30, now)).toBe(true)
    expect(shouldCatchUp('2026-09-08T09:15:00', 30, now)).toBe(true)
    expect(shouldCatchUp('2026-09-08T09:45:00', 30, now)).toBe(false)
  })
})
