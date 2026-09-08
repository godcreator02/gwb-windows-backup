import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backupIntervalMsOf, createTimers, intervalMsOf, shouldCatchUp } from '../src/timers.js'
import type { EffectHost } from '../src/timers.js'


beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createTimers', () => {
  it('interval 到点响；停掉那一根就不再响', () => {
    const host: EffectHost = { effect: () => () => {} }
    const timers = createTimers(host)
    let ticks = 0
    const stop = timers.interval(() => {
      ticks += 1
    }, 1000)
    vi.advanceTimersByTime(3000)
    expect(ticks).toBe(3)
    stop()
    vi.advanceTimersByTime(3000)
    expect(ticks).toBe(3)
  })

  it('timeout 只响一次；还没响就撤掉则不响', () => {
    const host: EffectHost = { effect: () => () => {} }
    const timers = createTimers(host)
    let fired = 0
    timers.timeout(() => {
      fired += 1
    }, 1000)
    vi.advanceTimersByTime(5000)
    expect(fired).toBe(1)

    let fired2 = 0
    const stop = timers.timeout(() => {
      fired2 += 1
    }, 1000)
    stop()
    vi.advanceTimersByTime(5000)
    expect(fired2).toBe(0)
  })

  it('fiber 撤下（effect 的 disposer 跑）→ 一把全收', () => {
    let disposeAll: (() => void) | undefined
    const host: EffectHost = {
      effect: (setup) => {
        disposeAll = setup()
        return () => {}
      },
    }
    const timers = createTimers(host)
    let ticks = 0
    timers.interval(() => {
      ticks += 1
    }, 1000)
    timers.timeout(() => {
      ticks += 100
    }, 2000)
    disposeAll?.()
    vi.advanceTimersByTime(10_000)
    expect(ticks).toBe(0)
  })

  it('停掉的函数幂等', () => {
    const host: EffectHost = { effect: () => () => {} }
    const timers = createTimers(host)
    const stop = timers.interval(() => {}, 1000)
    stop()
    expect(() => stop()).not.toThrow()
  })
})

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
