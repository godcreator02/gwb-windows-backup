import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildNotification,
  excludeArgv,
  formatDuration,
  refuseReason,
  runFullBackup,
} from '../src/backup.js'
import { DEFAULT_FLAT, flatToConfig } from '../src/config.js'
import { createLogger, nullLogger } from '../src/log.js'
import { BACKUP_OK, BACKUP_STARTED } from '../src/messages.js'
import { layout } from '../src/paths.js'
import type { RunProcess, RunResult } from '../src/process.js'
import { readState, writeState } from '../src/state.js'

const dirs: string[] = []
const tmpPaths = (): ReturnType<typeof layout> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gwb-wb-backup-'))
  dirs.push(dir)
  return layout(dir)
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** restic 一轮全成的 stdout 模样（够解析出 snapshot 与体量）。 */
const OK_STDOUT = 'snapshot abc12345 saved\nprocessed 42 files, 4.9 KiB in 0:01'

/** 造一个按「子命令前缀」分发的假 restic。每个调用的 (args) 都记进 calls。 */
function fakeRestic(cases: { when: string[]; result: Partial<RunResult> }[]): { run: RunProcess; calls: string[][] } {
  const calls: string[][] = []
  const run: RunProcess = async (_exe, args) => {
    calls.push(args)
    const hit = cases.find((one) => one.when.every((token, index) => args[index + 4] === token))
    if (hit === undefined) return { code: 0, stdout: '', stderr: '', timedOut: false }
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...hit.result }
  }
  return { run, calls }
}

const configured = (over: Record<string, unknown> = {}) =>
  // toast 默认关：默认开着的话每轮多一次 powershell 调用，跟 restic 的调用混在一个表里
  flatToConfig({ ...DEFAULT_FLAT, sources: 'D:/Notes', localRepo: 'D:/Backup/restic-repo', toast: false, ...over })

describe('refuseReason', () => {
  it('sources 空 → 拒跑并指路', () => {
    expect(refuseReason(flatToConfig({ localRepo: 'D:/r' }))).toContain('sources')
  })

  it('localRepo 空 → 拒跑', () => {
    expect(refuseReason(flatToConfig({ sources: 'D:/A' }))).toContain('local-repo')
  })

  it('OSS 开着缺 bucket / endpoint → 拒跑', () => {
    expect(refuseReason(configured({ ossEnabled: true }))).toContain('oss-bucket')
  })

  it('配齐了 → null', () => {
    expect(refuseReason(configured())).toBeNull()
    expect(refuseReason(configured({ ossEnabled: true, ossBucket: 'b', ossEndpoint: 'e' }))).toBeNull()
  })
})

describe('runFullBackup', () => {
  it('全成的一轮：契约句、prune 每日一次、状态三格、锁释放', async () => {
    const paths = tmpPaths()
    const { run, calls } = fakeRestic([
      { when: ['backup'], result: { stdout: OK_STDOUT } },
      { when: ['forget'], result: { stdout: 'ok' } },
    ])
    const logger = createLogger(paths.logFile, () => new Date(2026, 8, 8, 10, 0, 0))
    const result = await runFullBackup({ paths, config: configured(), logger, run, now: () => new Date(2026, 8, 8, 10, 0, 0) })

    expect(result.skipped).toBeNull()
    if (result.skipped !== null) throw new Error('这轮不该被跳过')
    expect(result.ok).toBe(true)
    expect(result.local.snapshotId).toBe('abc12345')
    expect(result.local.size).toBe('4.9 KiB')

    const text = readFileSync(paths.logFile, 'utf8')
    expect(text).toContain(BACKUP_STARTED)
    expect(text).toContain(BACKUP_OK)
    expect(text).toContain('Prune started')
    expect(text).toContain('Prune completed successfully')

    // 状态：成败都记 + prune 时间戳只在成功后落
    const state = readState(paths.stateFile)
    expect(state.lastRunOk).toBe(true)
    expect(state.lastRunAt).toBe('2026-09-08T10:00:00')
    expect(state.lastPrune).toBe('2026-09-08T10:00:00')

    // 锁跑完即删
    expect(existsSync(paths.lockFile)).toBe(false)
    // 本地一轮 = backup + forget，各一次
    expect(calls.length).toBe(2)
  })

  it('今天已经 prune 过 → 这轮不再 prune', async () => {
    const paths = tmpPaths()
    const { run, calls } = fakeRestic([{ when: ['backup'], result: { stdout: OK_STDOUT } }])
    const now = new Date(2026, 8, 8, 11, 0, 0)
    // 早上 8 点已经 prune 成功过
    writeState(paths.stateFile, { lastPrune: '2026-09-08T08:00:00' })
    await runFullBackup({ paths, config: configured(), logger: nullLogger(), run, now: () => now })
    expect(calls.length).toBe(1) // 只有 backup
    const state = readState(paths.stateFile)
    expect(state.lastPrune).toBe('2026-09-08T08:00:00') // 没被覆盖
  })

  it('本地失败 → 不 prune、不推 OSS、状态记失败', async () => {
    const paths = tmpPaths()
    const { run, calls } = fakeRestic([{ when: ['backup'], result: { code: 1, stderr: 'Fatal: 打不开仓库' } }])
    const result = await runFullBackup({
      paths,
      config: configured({ ossEnabled: true, ossBucket: 'b', ossEndpoint: 'e' }),
      logger: nullLogger(),
      run,
      now: () => new Date(2026, 8, 8, 10, 0, 0),
    })
    expect(result.ok).toBe(false)
    if (result.skipped !== null) throw new Error('这轮不该被跳过')
    expect(result.oss).toBeNull()
    expect(calls.length).toBe(1) // 只有本地 backup 那一次
    expect(readState(paths.stateFile).lastRunOk).toBe(false)
  })

  it('OSS 半成：本地成、OSS 推败 → 整轮 false、通知 partial、OSS 不 prune', async () => {
    const paths = tmpPaths()
    const { run } = fakeRestic([
      { when: ['backup'], result: { stdout: OK_STDOUT } },
      { when: ['forget'], result: {} },
    ])
    // 第二次 backup（OSS 那趟）要失败：按「第几次调用」分
    let backupCount = 0
    const allCalls: string[][] = []
    const run2: RunProcess = async (exe, args, options) => {
      allCalls.push(args)
      const first = args[4]
      if (first === 'backup') {
        backupCount += 1
        if (backupCount === 2) return { code: 1, stdout: '', stderr: 'oss 挂了', timedOut: false }
      }
      return run(exe, args, options)
    }
    const result = await runFullBackup({
      paths,
      config: configured({ ossEnabled: true, ossBucket: 'b', ossEndpoint: 'e' }),
      logger: nullLogger(),
      run: run2,
      now: () => new Date(2026, 8, 8, 10, 0, 0),
    })
    expect(result.ok).toBe(false)
    if (result.skipped !== null) throw new Error('这轮不该被跳过')
    expect(result.oss?.ok).toBe(false)
    expect(result.notification.title).toBe('Restic Backup partial - OSS push FAILED')
    // backup×2（本地+OSS）+ forget×1（本地 prune）——OSS prune 不跑
    expect(allCalls.length).toBe(3)
    expect(readState(paths.stateFile).lastRunOk).toBe(false)
  })

  it('占不到锁 → skipped locked，一个字不写', async () => {
    const paths = tmpPaths()
    const result = await runFullBackup({
      paths,
      config: configured(),
      logger: nullLogger(),
      acquireLock: () => null,
    })
    expect(result).toMatchObject({ ok: false, skipped: 'locked' })
  })
})

describe('excludeArgv', () => {
  it('规则转 --exclude 参数对；# 注释与空行不进 argv', () => {
    expect(excludeArgv(['# 分区注释', '  ', '*.gwbprobe', ' .venv '])).toEqual([
      '--exclude',
      '*.gwbprobe',
      '--exclude',
      '.venv',
    ])
    expect(excludeArgv([])).toEqual([])
  })

  it('跑真的一轮时：基线走 --exclude-file，追加规则逐条 --exclude', async () => {
    const paths = tmpPaths()
    const { run, calls } = fakeRestic([{ when: ['backup'], result: { stdout: OK_STDOUT } }])
    await runFullBackup({
      paths,
      config: configured({ exclude: ['# 注释', '*.gwbprobe'] }),
      logger: nullLogger(),
      run,
      now: () => new Date(2026, 8, 8, 10, 0, 0),
    })
    const args = calls[0] ?? []
    expect(args).toContain(`--exclude-file=${paths.defaultExcludeFile}`)
    const i = args.indexOf('--exclude')
    expect(args[i + 1]).toBe('*.gwbprobe')
    expect(args).not.toContain('# 注释')
    expect(args.indexOf('--exclude')).toBeGreaterThan(args.indexOf('--exclude-file'))
    expect(args[args.length - 1]).toBe('D:/Notes')
  })
})

describe('buildNotification / formatDuration', () => {
  it('M:SS', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65)).toBe('1:05')
  })

  it('本地失败念日志路径', () => {
    const n = buildNotification({ ok: false, snapshotId: null, size: null, durationSeconds: 1 }, null, false, 'L:/log')
    expect(n.title).toBe('Restic Backup FAILED')
    expect(n.body).toContain('L:/log')
  })

  it('本地成 + OSS 关 → OK', () => {
    const n = buildNotification({ ok: true, snapshotId: 'a', size: '4.9 KiB', durationSeconds: 61 }, null, false, 'L')
    expect(n.title).toBe('Restic Backup OK')
    expect(n.body).toBe('4.9 KiB | local 1:01')
  })

  it('本地成 + OSS 成 → OK 带 OSS 段', () => {
    const n = buildNotification(
      { ok: true, snapshotId: 'a', size: null, durationSeconds: 1 },
      { ok: true, repo: 's3:e/b/p', durationSeconds: 2 },
      true,
      'L',
    )
    expect(n.title).toBe('Restic Backup OK')
    expect(n.body).toBe('local 0:01 | OSS 0:02')
  })
})
