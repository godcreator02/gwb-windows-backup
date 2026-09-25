import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseLatestSnapshotTime, runHealthCheck } from '../src/health.js'
import { DEFAULT_FLAT, flatToConfig } from '../src/config.js'
import { layout } from '../src/paths.js'
import type { RunProcess } from '../src/process.js'

const dirs: string[] = []
const tmpPaths = (): ReturnType<typeof layout> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gwb-wb-health-'))
  dirs.push(dir)
  return layout(dir)
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 本地时区无 TZ 标记的时间串——state.json 的口径（UTC 串直接砍 Z 会差出一个时区）。 */
const localTs = (d: Date): string => {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}
const localDate = (d: Date): string => localTs(d).slice(0, 10)

/** 快照那项的 exe 存在性守卫要一个真存在的文件——node 自己就存在。 */
const REAL_EXE = process.execPath

const config = (over: Record<string, unknown> = {}) =>
  flatToConfig({ ...DEFAULT_FLAT, sources: ['D:/Notes'], localRepo: 'D:/Backup/restic-repo', resticExe: REAL_EXE, ...over })

/** 一份正常的 state：40 分钟前成功跑过。 */
const healthyState = (now: Date) => ({
  lastRunAt: localTs(new Date(now.getTime() - 40 * 60_000)),
  lastRunOk: true,
  lastPrune: localDate(new Date(now.getTime() - 40 * 60_000)),
  lastUsbCopy: localDate(new Date(now.getTime() - 2 * 86_400_000)),
  lastExcludeAudit: localDate(new Date(now.getTime() - 3 * 86_400_000)),
  lastReview: localDate(new Date(now.getTime() - 1 * 86_400_000)),
})

/** 一份全绿的假 restic（快照那项用）。 */
const okSnapshots: RunProcess = async () => ({
  code: 0,
  stdout: JSON.stringify([{ time: new Date(Date.now() - 40 * 60_000).toISOString() }]),
  stderr: '',
  timedOut: false,
})

/** 磁盘余量注入点：永远报「很空」。 */
const diskOf = (freeRatio: number) => () => ({
  freeBytes: freeRatio,
  totalBytes: 1,
})

describe('① lastRun', () => {
  it('从没跑过 → problem「还没备份过」', async () => {
    const paths = tmpPaths()
    const now = new Date()
    const report = await runHealthCheck(paths, config(), { now, run: okSnapshots, diskFree: diskOf(0.9), state: {} })
    expect(report.items.lastRun.status).toBe('problem')
    expect(report.problems.some((p) => p.includes('还没备份过'))).toBe(true)
  })

  it('上次失败 → problem，小结念出来', async () => {
    const now = new Date()
    const report = await runHealthCheck(tmpPaths(), config(), {
      now,
      run: okSnapshots,
      diskFree: diskOf(0.9),
      state: { lastRunAt: healthyState(now).lastRunAt, lastRunOk: false, lastRunSummary: 'OSS FAILED' },
    })
    expect(report.items.lastRun.status).toBe('problem')
    expect(report.items.lastRun.message).toContain('OSS FAILED')
  })

  it('太久没成功（> 2 周期）→ problem', async () => {
    const now = new Date()
    const old = localTs(new Date(now.getTime() - 120 * 60_000))
    const report = await runHealthCheck(tmpPaths(), config(), {
      now,
      run: okSnapshots,
      diskFree: diskOf(0.9),
      state: { lastRunAt: old, lastRunOk: true },
    })
    expect(report.items.lastRun.status).toBe('problem')
    expect(report.items.lastRun.message).toContain('两个周期')
  })

  it('40 分钟前成功（周期 30）→ ok', async () => {
    const now = new Date()
    const report = await runHealthCheck(tmpPaths(), config(), {
      now,
      run: okSnapshots,
      diskFree: diskOf(0.9),
      state: healthyState(now),
    })
    expect(report.items.lastRun.status).toBe('ok')
  })

  it('备份照常成功、prune 连着两天没成功 → problem，把上次 prune 的时间念出来', async () => {
    const now = new Date()
    const twoDaysAgo = localTs(new Date(now.getTime() - 2 * 86_400_000))
    const report = await runHealthCheck(tmpPaths(), config(), {
      now,
      run: okSnapshots,
      diskFree: diskOf(0.9),
      state: { ...healthyState(now), lastPrune: twoDaysAgo },
    })
    expect(report.items.lastRun.status).toBe('problem')
    expect(report.items.lastRun.pruneAgeDays).toBe(2)
    expect(report.items.lastRun.message).toContain(twoDaysAgo)
  })

  it('备份成功但 prune 从没成功过 → problem', async () => {
    const now = new Date()
    const report = await runHealthCheck(tmpPaths(), config(), {
      now,
      run: okSnapshots,
      diskFree: diskOf(0.9),
      state: { ...healthyState(now), lastPrune: undefined },
    })
    expect(report.items.lastRun.status).toBe('problem')
    expect(report.items.lastRun.message).toContain('还没成功过')
  })

  it('prune 昨天成功、今天还没轮到 → ok', async () => {
    const now = new Date()
    const yesterday = localDate(new Date(now.getTime() - 86_400_000))
    const report = await runHealthCheck(tmpPaths(), config(), {
      now,
      run: okSnapshots,
      diskFree: diskOf(0.9),
      state: { ...healthyState(now), lastPrune: yesterday },
    })
    expect(report.items.lastRun.status).toBe('ok')
  })
})

describe('② log', () => {
  it('日志文件不存在 → problem「还没产生备份日志」', async () => {
    const now = new Date()
    const report = await runHealthCheck(tmpPaths(), config(), { now, run: okSnapshots, diskFree: diskOf(0.9), state: healthyState(now) })
    expect(report.items.log.exists).toBe(false)
    expect(report.items.log.status).toBe('problem')
  })

  it('最近一轮全成（OSS 关）→ ok；`0 errors` 计数行不算失败', async () => {
    const paths = tmpPaths()
    mkdirSync(path.dirname(paths.logFile), { recursive: true })
    writeFileSync(
      paths.logFile,
      ['[t] Backup started', 'restic 输出 processed 42 files, 0 errors', '[t] Backup completed successfully', ''].join('\n'),
      'utf8',
    )
    const now = new Date()
    const report = await runHealthCheck(paths, config(), { now, run: okSnapshots, diskFree: diskOf(0.9), state: healthyState(now) })
    expect(report.items.log.status).toBe('ok')
    expect(report.items.log.localOk).toBe(true)
    expect(report.items.log.errorLines).toEqual([])
  })

  it('轮进行中（有 started 没结论）→ unknown「还在跑」', async () => {
    const paths = tmpPaths()
    mkdirSync(path.dirname(paths.logFile), { recursive: true })
    writeFileSync(paths.logFile, '[t] Backup started\nrestic 正在跑\n', 'utf8')
    const now = new Date()
    const report = await runHealthCheck(paths, config(), { now, run: okSnapshots, diskFree: diskOf(0.9), state: healthyState(now) })
    expect(report.items.log.status).toBe('unknown')
    expect(report.items.log.localOk).toBeNull()
  })

  it('OSS 开着但最近一轮没有 OSS 成功行 → problem', async () => {
    const paths = tmpPaths()
    mkdirSync(path.dirname(paths.logFile), { recursive: true })
    writeFileSync(
      paths.logFile,
      ['[t] Backup started', '[t] Backup completed successfully', '[t] OSS push FAILED with exit code 1', ''].join('\n'),
      'utf8',
    )
    const now = new Date()
    const report = await runHealthCheck(paths, config({ ossEnabled: true, ossBucket: 'b', ossEndpoint: 'e' }), {
      now,
      run: okSnapshots,
      diskFree: diskOf(0.9),
      state: healthyState(now),
    })
    expect(report.items.log.status).toBe('problem')
    expect(report.items.log.ossOk).toBe(false)
  })

  it('失败行已经被后面的成功轮次翻篇 → 不算问题（2026-09-20 撞到的那种假红）', async () => {
    const paths = tmpPaths()
    mkdirSync(path.dirname(paths.logFile), { recursive: true })
    writeFileSync(
      paths.logFile,
      [
        '[2026-09-20 15:36:13] Backup FAILED with exit code 1',
        '[2026-09-20 15:46:06] Backup started',
        '[2026-09-20 15:47:58] Backup FAILED with exit code 1',
        '[2026-09-20 15:52:48] Backup started',
        '[2026-09-20 15:55:37] Backup completed successfully',
        '',
      ].join('\n'),
      'utf8',
    )
    const now = new Date()
    const report = await runHealthCheck(paths, config(), {
      now,
      run: okSnapshots,
      diskFree: diskOf(0.9),
      state: healthyState(now),
    })
    expect(report.items.log.status).toBe('ok')
    expect(report.items.log.errorLines).toEqual([])
  })

  it('最后一次成功之后的失败行照样算，并把时刻念出来', async () => {
    const paths = tmpPaths()
    mkdirSync(path.dirname(paths.logFile), { recursive: true })
    writeFileSync(
      paths.logFile,
      [
        '[2026-09-20 15:55:37] Backup completed successfully',
        '[2026-09-20 16:25:40] Backup started',
        '[2026-09-20 16:25:41] Backup FAILED with exit code 1',
        '',
      ].join('\n'),
      'utf8',
    )
    const now = new Date()
    const report = await runHealthCheck(paths, config(), {
      now,
      run: okSnapshots,
      diskFree: diskOf(0.9),
      state: healthyState(now),
    })
    expect(report.items.log.status).toBe('problem')
    expect(report.items.log.errorLines.length).toBe(1)
    expect(report.problems.some((problem) => problem.includes('16:25:41'))).toBe(true)
  })
})

describe('③ disk', () => {
  it('跟着 localRepo 的盘走：<10% alert，<20% notice，其余 ok', async () => {
    const now = new Date()
    const base = { now, run: okSnapshots, state: healthyState(now) }
    const alert = await runHealthCheck(tmpPaths(), config(), { ...base, diskFree: diskOf(0.05) })
    expect(alert.items.disk.level).toBe('alert')
    const notice = await runHealthCheck(tmpPaths(), config(), { ...base, diskFree: diskOf(0.15) })
    expect(notice.items.disk.level).toBe('notice')
    const ok = await runHealthCheck(tmpPaths(), config(), { ...base, diskFree: diskOf(0.5) })
    expect(ok.items.disk.level).toBe('ok')
  })

  it('没配 localRepo → unknown；读不到 → unknown（都不算失败）', async () => {
    const now = new Date()
    const unconfigured = await runHealthCheck(tmpPaths(), flatToConfig({}), { now, run: okSnapshots, diskFree: diskOf(0.5), state: healthyState(now) })
    expect(unconfigured.items.disk.status).toBe('unknown')
    const unreadable = await runHealthCheck(tmpPaths(), config(), { now, run: okSnapshots, diskFree: () => null, state: healthyState(now) })
    expect(unreadable.items.disk.status).toBe('unknown')
  })
})

describe('④ snapshots', () => {
  it('restic 读不到仓库 → unknown，不算失败', async () => {
    const failing: RunProcess = async () => ({ code: 1, stdout: '', stderr: 'locked', timedOut: false })
    const now = new Date()
    const report = await runHealthCheck(tmpPaths(), config(), { now, run: failing, diskFree: diskOf(0.9), state: healthyState(now) })
    expect(report.items.snapshots.status).toBe('unknown')
  })

  it('快照太老（> 2 周期）→ problem；skipSnapshots → skipped', async () => {
    const stale: RunProcess = async () => ({ code: 0, stdout: JSON.stringify([{ time: new Date(Date.now() - 200 * 60_000).toISOString() }]), stderr: '', timedOut: false })
    const now = new Date()
    const report = await runHealthCheck(tmpPaths(), config(), { now, run: stale, diskFree: diskOf(0.9), state: healthyState(now) })
    expect(report.items.snapshots.status).toBe('problem')

    const skipped = await runHealthCheck(tmpPaths(), config(), { now, skipSnapshots: true, diskFree: diskOf(0.9), state: healthyState(now) })
    expect(skipped.items.snapshots.status).toBe('skipped')
  })
})

describe('⑤ periodic', () => {
  it('USB ≥7 天、exclude 审计 ≥30 天 → 提醒；从没做过也算', async () => {
    const now = new Date()
    const due = await runHealthCheck(tmpPaths(), config(), { now, run: okSnapshots, diskFree: diskOf(0.9), state: { lastRunAt: healthyState(now).lastRunAt, lastRunOk: true } })
    expect(due.items.periodic.usbCopyDue).toBe(true)
    expect(due.items.periodic.excludeAuditDue).toBe(true)
    expect(due.items.periodic.message).toContain('USB')

    const fresh = healthyState(now)
    const fine = await runHealthCheck(tmpPaths(), config(), { now, run: okSnapshots, diskFree: diskOf(0.9), state: fresh })
    expect(fine.items.periodic.status).toBe('ok')
  })

  it('人工复核：从没做过或超过配置间隔 → reviewDue；间隔跟着配置走', async () => {
    const now = new Date()
    const never = await runHealthCheck(tmpPaths(), config(), { now, run: okSnapshots, diskFree: diskOf(0.9), state: { ...healthyState(now), lastReview: undefined } })
    expect(never.items.periodic.reviewDue).toBe(true)
    expect(never.items.periodic.message).toContain('复核')

    const stale = await runHealthCheck(tmpPaths(), config({ reviewIntervalDays: 3 }), {
      now,
      run: okSnapshots,
      diskFree: diskOf(0.9),
      state: { ...healthyState(now), lastReview: localDate(new Date(now.getTime() - 5 * 86_400_000)) },
    })
    expect(stale.items.periodic.reviewDue).toBe(true)

    const fine = await runHealthCheck(tmpPaths(), config({ reviewIntervalDays: 3 }), {
      now,
      run: okSnapshots,
      diskFree: diskOf(0.9),
      state: { ...healthyState(now), lastReview: localDate(new Date(now.getTime() - 2 * 86_400_000)) },
    })
    expect(fine.items.periodic.reviewDue).toBe(false)
  })
})

describe('汇总', () => {
  it('ok 与 problems 的口径：一个 problem 都没有才是 ok', async () => {
    const now = new Date()
    const report = await runHealthCheck(tmpPaths(), config(), { now, run: okSnapshots, diskFree: diskOf(0.9), state: healthyState(now) })
    // 日志文件不存在是唯一的问题（healthyState 没写日志）——正好验「problems 念清单」
    expect(report.ok).toBe(false)
    expect(report.problems.some((p) => p.includes('备份日志'))).toBe(true)
  })

  it('parseLatestSnapshotTime 认不出回 null', () => {
    expect(parseLatestSnapshotTime('[]')).toBeNull()
    expect(parseLatestSnapshotTime('垃圾')).toBeNull()
    expect(parseLatestSnapshotTime(JSON.stringify([{ time: '2026-09-08T10:00:00Z' }]))).toBe('2026-09-08T10:00:00Z')
  })
})
