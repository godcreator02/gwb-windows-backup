import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { daysSince, localTimestamp, minutesSince } from '../src/clock.js'
import { backupIsDue, nextRunAt, readState, shouldRunPrune, writeState } from '../src/state.js'

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gwb-wb-state-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readState', () => {
  it('文件不存在当空对象', () => {
    expect(readState(path.join(tmp(), 'state.json'))).toEqual({})
  })

  it('坏 JSON / 非对象当空对象（fail-safe）', () => {
    const dir = tmp()
    const file = path.join(dir, 'state.json')
    writeFileSync(file, '{这不是 JSON', 'utf8')
    expect(readState(file)).toEqual({})
    writeFileSync(file, '[1,2,3]', 'utf8')
    expect(readState(file)).toEqual({})
  })

  it('只收认识的字段，布尔格单独收', () => {
    const dir = tmp()
    const file = path.join(dir, 'state.json')
    writeFileSync(
      file,
      JSON.stringify({ lastRunAt: '2026-09-08T10:00:00', lastRunOk: true, 别的: 'x', lastRunSummary: 42 }),
      'utf8',
    )
    expect(readState(file)).toEqual({ lastRunAt: '2026-09-08T10:00:00', lastRunOk: true })
  })
})

describe('writeState', () => {
  it('merge 写：只动 patch 里的键', () => {
    const dir = tmp()
    const file = path.join(dir, 'state.json')
    writeState(file, { lastRunAt: '2026-09-08T10:00:00', lastRunOk: true })
    writeState(file, { lastPrune: '2026-09-08T10:05:00' })
    const merged = readState(file)
    expect(merged.lastRunAt).toBe('2026-09-08T10:00:00')
    expect(merged.lastRunOk).toBe(true)
    expect(merged.lastPrune).toBe('2026-09-08T10:05:00')
  })
})

describe('时间口径', () => {
  it('localTimestamp 无时区标记', () => {
    expect(localTimestamp(new Date(2026, 8, 8, 9, 5, 3))).toBe('2026-09-08T09:05:03')
  })

  it('minutesSince 按本地时间解析（写进去的口径）', () => {
    const now = new Date(2026, 8, 8, 10, 0, 0)
    expect(minutesSince('2026-09-08T09:30:00', now)).toBe(30)
    expect(minutesSince(undefined, now)).toBeNull()
    expect(minutesSince('垃圾', now)).toBeNull()
  })

  it('daysSince 按本地日历日算，日期串（10 位）也认', () => {
    const now = new Date(2026, 8, 8, 23, 0, 0)
    expect(daysSince('2026-09-01', now)).toBe(7)
    expect(daysSince('2026-09-08T00:30:00', now)).toBe(0)
    expect(daysSince(undefined, now)).toBeNull()
  })
})

describe('shouldRunPrune', () => {
  it('没记过 / 记的不是今天 → 该跑', () => {
    const now = new Date(2026, 8, 8, 12, 0, 0)
    expect(shouldRunPrune({}, now)).toBe(true)
    expect(shouldRunPrune({ lastPrune: '2026-09-07T23:00:00' }, now)).toBe(true)
    expect(shouldRunPrune({ lastPrune: '太短' }, now)).toBe(true)
  })

  it('今天记过 → 不跑（判跨日只看前 10 位）', () => {
    const now = new Date(2026, 8, 8, 12, 0, 0)
    expect(shouldRunPrune({ lastPrune: '2026-09-08T01:00:00' }, now)).toBe(false)
  })
})

describe('backupIsDue / nextRunAt', () => {
  const now = new Date(2026, 8, 8, 10, 0, 0)

  it('从没跑过 / 上一轮结束满一个周期 → 该跑；刚跑过 → 不跑', () => {
    expect(backupIsDue(undefined, 30, now)).toBe(true)
    expect(backupIsDue('2026-09-08T09:30:00', 30, now)).toBe(true)
    expect(backupIsDue('2026-09-08T09:45:00', 30, now)).toBe(false)
  })

  it('下一轮 = 上一轮结束加一个周期；已经到期就是现在', () => {
    expect(nextRunAt('2026-09-08T09:45:00', 30, now)).toBe('2026-09-08T10:15:00')
    expect(nextRunAt('2026-09-08T09:00:00', 30, now)).toBe('2026-09-08T10:00:00')
    expect(nextRunAt(undefined, 30, now)).toBe('2026-09-08T10:00:00')
  })
})