import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localDate, localTimestamp } from '../src/clock.js'
import type { SnapshotReading } from '../src/health.js'
import { assessHealth, dueReminders, parseLatestSnapshotTime, readLatestSnapshot } from '../src/health.js'
import { layout } from '../src/paths.js'
import type { RunProcess } from '../src/process.js'
import type { BackupState } from '../src/state.js'
import { configOf } from './helpers.js'

const dirs: string[] = []
const tmpPaths = (): ReturnType<typeof layout> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gwb-wb-health-'))
  dirs.push(dir)
  return layout(dir)
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const minutesAgo = (now: Date, minutes: number): Date => new Date(now.getTime() - minutes * 60_000)
const daysAgo = (now: Date, days: number): Date => new Date(now.getTime() - days * 86_400_000)

const config = configOf({ sources: ['D:/Notes'], localRepo: 'D:/Backup/restic-repo', resticExe: process.execPath })

/** 一份正常的 state：40 分钟前成功跑过，今天 prune 过。 */
const healthyState = (now: Date): BackupState => ({
  lastRunAt: localTimestamp(minutesAgo(now, 40)),
  lastRunOk: true,
  lastPrune: localTimestamp(minutesAgo(now, 40)),
})

/** 40 分钟前的快照。 */
const freshReading = (now: Date): SnapshotReading => ({ readAt: localTimestamp(now), latestAt: minutesAgo(now, 40).toISOString(), unreadable: null })

const roomyDisk = () => ({ freeBytes: 9, totalBytes: 10 })

const assess = (now: Date, over: { state?: BackupState; snapshots?: SnapshotReading | null; freeRatio?: number } = {}) =>
  assessHealth({
    state: over.state ?? healthyState(now),
    config,
    snapshots: over.snapshots === undefined ? freshReading(now) : over.snapshots,
    now,
    diskFree: over.freeRatio === undefined ? roomyDisk : () => ({ freeBytes: over.freeRatio ?? 0, totalBytes: 1 }),
  })

describe('① 上次备份', () => {
  it('从没跑过 → problem「还没备份过」', () => {
    const report = assess(new Date(), { state: {} })
    expect(report.items.lastRun.status).toBe('problem')
    expect(report.problems.some((problem) => problem.includes('还没备份过'))).toBe(true)
  })

  it('上次失败 → problem，小结念出来', () => {
    const now = new Date()
    const report = assess(now, { state: { ...healthyState(now), lastRunOk: false, lastRunSummary: 'OSS FAILED' } })
    expect(report.items.lastRun.status).toBe('problem')
    expect(report.items.lastRun.message).toContain('OSS FAILED')
  })

  it('太久没成功（> 2 周期）→ problem', () => {
    const now = new Date()
    const report = assess(now, { state: { ...healthyState(now), lastRunAt: localTimestamp(minutesAgo(now, 120)) } })
    expect(report.items.lastRun.message).toContain('两个周期')
  })

  it('40 分钟前成功（周期 30）→ ok；全绿时 ok 为 true', () => {
    const report = assess(new Date())
    expect(report.items.lastRun.status).toBe('ok')
    expect(report.ok).toBe(true)
    expect(report.problems).toEqual([])
  })

  it('备份照常成功、prune 连着两天没成功 → problem，把上次 prune 的时间念出来', () => {
    const now = new Date()
    const twoDaysAgo = localTimestamp(daysAgo(now, 2))
    const report = assess(now, { state: { ...healthyState(now), lastPrune: twoDaysAgo } })
    expect(report.items.lastRun.pruneAgeDays).toBe(2)
    expect(report.items.lastRun.message).toContain(twoDaysAgo)
  })

  it('备份成功但 prune 从没成功过 → problem', () => {
    const now = new Date()
    const { lastPrune: _dropped, ...withoutPrune } = healthyState(now)
    expect(assess(now, { state: withoutPrune }).items.lastRun.message).toContain('还没成功过')
  })
})

describe('② 磁盘', () => {
  it('跟着 localRepo 的盘走：<10% alert，<20% notice，其余 ok', () => {
    const now = new Date()
    expect(assess(now, { freeRatio: 0.05 }).items.disk.level).toBe('alert')
    expect(assess(now, { freeRatio: 0.15 }).items.disk.level).toBe('notice')
    expect(assess(now, { freeRatio: 0.5 }).items.disk.status).toBe('ok')
  })

  it('没配 localRepo → unknown；读不到 → unknown（都不算失败）', () => {
    const now = new Date()
    const unconfigured = assessHealth({ state: healthyState(now), config: configOf(), snapshots: freshReading(now), now, diskFree: roomyDisk })
    expect(unconfigured.items.disk.status).toBe('unknown')
    const unreadable = assessHealth({ state: healthyState(now), config, snapshots: freshReading(now), now, diskFree: () => null })
    expect(unreadable.items.disk.status).toBe('unknown')
    expect(unreadable.ok).toBe(true)
  })
})

describe('③ 快照新鲜度', () => {
  it('还没读过仓库 → unknown，不算失败', () => {
    const report = assess(new Date(), { snapshots: null })
    expect(report.items.snapshots.status).toBe('unknown')
    expect(report.ok).toBe(true)
  })

  it('读不出 → unknown，原因念出来', () => {
    const now = new Date()
    const report = assess(now, { snapshots: { readAt: localTimestamp(now), latestAt: null, unreadable: 'restic 读不到仓库（锁着或盘不在）' } })
    expect(report.items.snapshots.status).toBe('unknown')
    expect(report.items.snapshots.message).toContain('锁着')
  })

  it('年龄按现在算：两小时前读到的快照当时新鲜，现在超过两个周期就是 problem', () => {
    const now = new Date()
    const readTwoHoursAgo: SnapshotReading = { readAt: localTimestamp(minutesAgo(now, 120)), latestAt: minutesAgo(now, 130).toISOString(), unreadable: null }
    expect(assess(now, { snapshots: readTwoHoursAgo }).items.snapshots.status).toBe('problem')
  })
})

describe('readLatestSnapshot', () => {
  it('restic 读不到仓库 → unreadable，不抛', async () => {
    const failing: RunProcess = async () => ({ code: 1, stdout: '', stderr: 'locked', timedOut: false })
    const reading = await readLatestSnapshot(tmpPaths(), config, failing, new Date())
    expect(reading.latestAt).toBeNull()
    expect(reading.unreadable).toContain('读不到仓库')
  })

  it('restic 不在 → unreadable，不启动进程', async () => {
    let started = false
    const run: RunProcess = async () => {
      started = true
      return { code: 0, stdout: '[]', stderr: '', timedOut: false }
    }
    const reading = await readLatestSnapshot(tmpPaths(), configOf({ localRepo: 'D:/r' }), run, new Date())
    expect(started).toBe(false)
    expect(reading.unreadable).toContain('restic 还没装到位')
  })

  it('读出最新快照的时间，补上 --repo 与 --password-file', async () => {
    const seen: string[][] = []
    const run: RunProcess = async (_exe, args) => {
      seen.push(args)
      return { code: 0, stdout: JSON.stringify([{ time: '2026-09-08T10:00:00Z' }]), stderr: '', timedOut: false }
    }
    const reading = await readLatestSnapshot(tmpPaths(), config, run, new Date())
    expect(reading.latestAt).toBe('2026-09-08T10:00:00Z')
    expect(seen[0]?.slice(0, 2)).toEqual(['--repo', 'D:/Backup/restic-repo'])
    expect(seen[0]?.slice(4)).toEqual(['snapshots', '--latest', '1', '--json'])
  })

  it('parseLatestSnapshotTime 认不出回 null', () => {
    expect(parseLatestSnapshotTime('[]')).toBeNull()
    expect(parseLatestSnapshotTime('垃圾')).toBeNull()
  })
})

describe('到期的人工维护', () => {
  it('从没做过都算到期；到期的不算进健康结论', () => {
    const now = new Date()
    expect(dueReminders({}, config, now).map((one) => one.what)).toEqual(['usb-copy', 'exclude-audit', 'review'])
    expect(assess(now, { state: healthyState(now) }).ok).toBe(true)
  })

  it('USB ≥7 天、exclude 审计 ≥30 天、复核 ≥ review-interval-days 才到期', () => {
    const now = new Date()
    const state: BackupState = {
      lastUsbCopy: localDate(daysAgo(now, 6)),
      lastExcludeAudit: localDate(daysAgo(now, 30)),
      lastReview: localDate(daysAgo(now, 2)),
    }
    expect(dueReminders(state, configOf({ reviewIntervalDays: 3 }), now).map((one) => one.what)).toEqual(['exclude-audit'])
    expect(dueReminders(state, configOf({ reviewIntervalDays: 2 }), now).map((one) => one.what)).toEqual(['exclude-audit', 'review'])
  })
})
