import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildNotification, excludeArgv, formatDuration, runFullBackup } from '../src/backup.js'
import type { BackupConfig } from '../src/config.js'
import { createLogger } from '../src/log.js'
import { layout } from '../src/paths.js'
import type { RunProcess, RunResult } from '../src/process.js'
import { readState, writeState } from '../src/state.js'
import { configOf, nullLogger } from './helpers.js'

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
    const hit = cases.find((one) => one.when.every((token, index) => args[index + 2] === token))
    if (hit === undefined) return { code: 0, stdout: '', stderr: '', timedOut: false }
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...hit.result }
  }
  return { run, calls }
}

const configured = (over: Partial<BackupConfig> = {}): BackupConfig =>
  // toast 默认关：默认开着的话每轮多一次 powershell 调用，跟 restic 的调用混在一个表里
  configOf({ sources: ['D:/Notes'], localRepo: 'D:/Backup/restic-repo', toast: false, ...over })

/** 开着 OSS 的配置，并在数据目录里放一份格式正确的凭据文件。 */
const withOss = (paths: ReturnType<typeof layout>): BackupConfig => {
  mkdirSync(paths.credentialsDir, { recursive: true })
  writeFileSync(paths.ossCredentialsFile, 'AWS_ACCESS_KEY_ID=k\nAWS_SECRET_ACCESS_KEY=s\n', 'utf8')
  return configured({ ossEnabled: true, ossBucket: 'b', ossEndpoint: 'e' })
}

describe('runFullBackup', () => {
  it.each(['1', '4.9', 'snapshot'])('短密码 %s 不破坏快照和体量解析', async (password) => {
    const paths = tmpPaths()
    const { run } = fakeRestic([{ when: ['backup'], result: { stdout: OK_STDOUT } }])
    const result = await runFullBackup({ credentials: { password, ossEnv: {} }, paths, config: configured(), logger: nullLogger(), run })
    expect(result.skipped).toBeNull()
    if (result.skipped !== null) throw new Error('这轮不该被跳过')
    expect(result.local.snapshotId).toBe('abc12345')
    expect(result.local.size).toBe('4.9 KiB')
    expect(readState(paths.stateFile).lastLocalSnapshot).toBe('abc12345')
  })

  it('全成的一轮：日志行、prune 每日一次、状态三格、锁释放', async () => {
    const paths = tmpPaths()
    const { run, calls } = fakeRestic([
      { when: ['backup'], result: { stdout: OK_STDOUT } },
      { when: ['forget'], result: { stdout: 'ok' } },
    ])
    const logger = createLogger(paths.logFile, () => new Date(2026, 8, 8, 10, 0, 0))
    const result = await runFullBackup({ credentials: { password: "fixture-restic-password", ossEnv: { AWS_ACCESS_KEY_ID: "fixture-access-id", AWS_SECRET_ACCESS_KEY: "fixture-access-secret" } }, paths, config: configured(), logger, run, now: () => new Date(2026, 8, 8, 10, 0, 0) })

    expect(result.skipped).toBeNull()
    if (result.skipped !== null) throw new Error('这轮不该被跳过')
    expect(result.ok).toBe(true)
    expect(result.local.snapshotId).toBe('abc12345')
    expect(result.local.size).toBe('4.9 KiB')

    const text = readFileSync(paths.logFile, 'utf8')
    expect(text).toContain('Backup started')
    expect(text).toContain('Backup completed successfully')
    expect(text).toContain('Prune started')
    expect(text).toContain('Prune completed successfully')

    // 状态：成败都记 + prune 时间戳只在成功后落
    const state = readState(paths.stateFile)
    expect(state.lastRunOk).toBe(true)
    expect(state.lastRunAt).toBe('2026-09-08T10:00:00')
    expect(state.lastPrune).toBe('2026-09-08T10:00:00')

    // 锁跑完即删
    expect(existsSync(paths.lockFile)).toBe(false)
    // 本地一轮 = backup + unlock + forget，各一次；unlock 先于 forget
    expect(calls.map((args) => args[2])).toEqual(['backup', 'unlock', 'forget'])
  })

  it('unlock 清不掉锁也照跑 forget：prune 的成败只看 forget', async () => {
    const paths = tmpPaths()
    const { run, calls } = fakeRestic([
      { when: ['backup'], result: { stdout: OK_STDOUT } },
      { when: ['unlock'], result: { code: 1, stderr: 'Fatal: unable to open config file' } },
      { when: ['forget'], result: { code: 11, stderr: 'unable to create lock in backend' } },
    ])
    const logger = createLogger(paths.logFile, () => new Date(2026, 8, 8, 10, 0, 0))
    await runFullBackup({ credentials: { password: "fixture-restic-password", ossEnv: { AWS_ACCESS_KEY_ID: "fixture-access-id", AWS_SECRET_ACCESS_KEY: "fixture-access-secret" } }, paths, config: configured(), logger, run, now: () => new Date(2026, 8, 8, 10, 0, 0) })

    expect(calls.map((args) => args[2])).toEqual(['backup', 'unlock', 'forget'])
    const text = readFileSync(paths.logFile, 'utf8')
    expect(text).toContain('unable to open config file')
    expect(text).toContain('Prune FAILED with exit code 11')
    expect(readState(paths.stateFile).lastPrune).toBeUndefined()
  })

  it('今天已经 prune 过 → 这轮不再 prune', async () => {
    const paths = tmpPaths()
    const { run, calls } = fakeRestic([{ when: ['backup'], result: { stdout: OK_STDOUT } }])
    const now = new Date(2026, 8, 8, 11, 0, 0)
    // 早上 8 点已经 prune 成功过
    writeState(paths.stateFile, { lastPrune: '2026-09-08T08:00:00' })
    await runFullBackup({ credentials: { password: "fixture-restic-password", ossEnv: { AWS_ACCESS_KEY_ID: "fixture-access-id", AWS_SECRET_ACCESS_KEY: "fixture-access-secret" } }, paths, config: configured(), logger: nullLogger(), run, now: () => now })
    expect(calls.length).toBe(1) // 只有 backup
    const state = readState(paths.stateFile)
    expect(state.lastPrune).toBe('2026-09-08T08:00:00') // 没被覆盖
  })

  it('本地失败 → 不 prune、不推 OSS、状态记失败', async () => {
    const paths = tmpPaths()
    const { run, calls } = fakeRestic([{ when: ['backup'], result: { code: 1, stderr: 'Fatal: 打不开仓库' } }])
    const result = await runFullBackup({ credentials: { password: "fixture-restic-password", ossEnv: { AWS_ACCESS_KEY_ID: "fixture-access-id", AWS_SECRET_ACCESS_KEY: "fixture-access-secret" } },
      paths,
      config: withOss(paths),
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
      const first = args[2]
      if (first === 'backup') {
        backupCount += 1
        if (backupCount === 2) return { code: 1, stdout: '', stderr: 'oss 挂了', timedOut: false }
      }
      return run(exe, args, options)
    }
    const result = await runFullBackup({ credentials: { password: "fixture-restic-password", ossEnv: { AWS_ACCESS_KEY_ID: "fixture-access-id", AWS_SECRET_ACCESS_KEY: "fixture-access-secret" } },
      paths,
      config: withOss(paths),
      logger: nullLogger(),
      run: run2,
      now: () => new Date(2026, 8, 8, 10, 0, 0),
    })
    expect(result.ok).toBe(false)
    if (result.skipped !== null) throw new Error('这轮不该被跳过')
    expect(result.oss?.ok).toBe(false)
    expect(result.notification.title).toBe('Restic Backup partial - OSS push FAILED')
    // backup×2（本地+OSS）+ unlock、forget 各一次（本地 prune）——OSS prune 不跑
    expect(allCalls.length).toBe(4)
    expect(readState(paths.stateFile).lastRunOk).toBe(false)
  })

  it('记着父本就带上 --parent（本地一份、OSS 一份），跑完把新 ID 写回 state', async () => {
    const paths = tmpPaths()
    const { run, calls } = fakeRestic([
      { when: ['backup'], result: { stdout: OK_STDOUT } },
      { when: ['forget'], result: {} },
    ])
    writeState(paths.stateFile, { lastLocalSnapshot: 'oldlocal', lastOssSnapshot: 'oldoss' })
    await runFullBackup({ credentials: { password: "fixture-restic-password", ossEnv: { AWS_ACCESS_KEY_ID: "fixture-access-id", AWS_SECRET_ACCESS_KEY: "fixture-access-secret" } },
      paths,
      config: withOss(paths),
      logger: nullLogger(),
      run,
      now: () => new Date(2026, 8, 8, 10, 0, 0),
    })

    const backups = calls.filter((args) => args[2] === 'backup')
    expect(backups.length).toBe(2)
    // 两个仓各自一条快照链，ID 不通用——本地那趟吃本地父本，OSS 那趟吃 OSS 父本
    const parentOf = (args: string[] | undefined): string | undefined =>
      args === undefined ? undefined : args[args.indexOf('--parent') + 1]
    expect(parentOf(backups[0])).toBe('oldlocal')
    expect(parentOf(backups[1])).toBe('oldoss')
    // 跑完写回新 ID：下一轮（哪怕白名单又改了）照样有基准
    const state = readState(paths.stateFile)
    expect(state.lastLocalSnapshot).toBe('abc12345')
    expect(state.lastOssSnapshot).toBe('abc12345')
  })

  it('没记过父本 → 一个 --parent 都不带（冷启动交给 restic 自己挑）', async () => {
    const paths = tmpPaths()
    const { run, calls } = fakeRestic([{ when: ['backup'], result: { stdout: OK_STDOUT } }])
    writeState(paths.stateFile, { lastPrune: '2026-09-08T08:00:00' })
    await runFullBackup({ credentials: { password: "fixture-restic-password", ossEnv: { AWS_ACCESS_KEY_ID: "fixture-access-id", AWS_SECRET_ACCESS_KEY: "fixture-access-secret" } }, paths, config: configured(), logger: nullLogger(), run, now: () => new Date(2026, 8, 8, 10, 0, 0) })
    expect(calls[0]).not.toContain('--parent')
    expect(readState(paths.stateFile).lastLocalSnapshot).toBe('abc12345')
  })

  it('父本在仓库里没了 → 丢开它重跑一次，且不写失败行', async () => {
    const paths = tmpPaths()
    let backups = 0
    const run: RunProcess = async (_exe, args) => {
      if (args[2] !== 'backup') return { code: 0, stdout: '', stderr: '', timedOut: false }
      backups += 1
      // 第一次：restic 说找不到这份父快照（实测 0.18.1 的原话）
      if (backups === 1) {
        return { code: 1, stdout: '', stderr: 'no matching ID found for prefix "oldlocal"', timedOut: false }
      }
      return { code: 0, stdout: OK_STDOUT, stderr: '', timedOut: false }
    }
    writeState(paths.stateFile, { lastLocalSnapshot: 'oldlocal', lastPrune: '2026-09-08T08:00:00' })
    const logger = createLogger(paths.logFile, () => new Date(2026, 8, 8, 10, 0, 0))
    const result = await runFullBackup({ credentials: { password: "fixture-restic-password", ossEnv: { AWS_ACCESS_KEY_ID: "fixture-access-id", AWS_SECRET_ACCESS_KEY: "fixture-access-secret" } },
      paths,
      config: configured(),
      logger,
      run,
      now: () => new Date(2026, 8, 8, 10, 0, 0),
    })

    expect(result.skipped).toBeNull()
    if (result.skipped !== null) throw new Error('这轮不该被跳过')
    expect(result.ok).toBe(true)
    expect(backups).toBe(2)

    const text = readFileSync(paths.logFile, 'utf8')
    expect(text).toContain('丢开父本重跑一轮')
    // 自我修复不算故障：日志里一个失败关键词都不该多出来
    expect(text).not.toContain('Backup FAILED')
    expect(readState(paths.stateFile).lastLocalSnapshot).toBe('abc12345')
  })

  it('别的失败不重试：照旧一次就收，写失败行', async () => {
    const paths = tmpPaths()
    let backups = 0
    const run: RunProcess = async (_exe, args) => {
      if (args[2] !== 'backup') return { code: 0, stdout: '', stderr: '', timedOut: false }
      backups += 1
      return { code: 1, stdout: '', stderr: 'Fatal: unable to open repository', timedOut: false }
    }
    writeState(paths.stateFile, { lastLocalSnapshot: 'oldlocal', lastPrune: '2026-09-08T08:00:00' })
    const logger = createLogger(paths.logFile, () => new Date(2026, 8, 8, 10, 0, 0))
    await runFullBackup({ credentials: { password: "fixture-restic-password", ossEnv: { AWS_ACCESS_KEY_ID: "fixture-access-id", AWS_SECRET_ACCESS_KEY: "fixture-access-secret" } }, paths, config: configured(), logger, run, now: () => new Date(2026, 8, 8, 10, 0, 0) })
    expect(backups).toBe(1)
    expect(readFileSync(paths.logFile, 'utf8')).toContain('Backup FAILED')
  })

  it('占不到锁 → skipped locked，一个字不写', async () => {
    const paths = tmpPaths()
    const result = await runFullBackup({ credentials: { password: "fixture-restic-password", ossEnv: { AWS_ACCESS_KEY_ID: "fixture-access-id", AWS_SECRET_ACCESS_KEY: "fixture-access-secret" } },
      paths,
      config: configured(),
      logger: nullLogger(),
      acquireLock: () => null,
    })
    expect(result).toMatchObject({ ok: false, skipped: 'locked' })
  })

  it('本 home OSS 凭据未配置 → OSS 那次记失败、不启动 restic，本地照常', async () => {
    const paths = tmpPaths()
    const { run, calls } = fakeRestic([{ when: ['backup'], result: { stdout: OK_STDOUT } }])
    writeState(paths.stateFile, { lastPrune: '2026-09-08T08:00:00' })
    const logger = createLogger(paths.logFile, () => new Date(2026, 8, 8, 10, 0, 0))
    const result = await runFullBackup({ credentials: { password: "fixture-restic-password", ossEnv: {} },
      paths,
      config: configured({ ossEnabled: true, ossBucket: 'b', ossEndpoint: 'e' }),
      logger,
      run,
      now: () => new Date(2026, 8, 8, 10, 0, 0),
    })
    if (result.skipped !== null) throw new Error('这轮不该被跳过')
    expect(result.local.ok).toBe(true)
    expect(result.oss?.ok).toBe(false)
    expect(calls.length).toBe(1)
    expect(readFileSync(paths.logFile, 'utf8')).toContain('OSS push FAILED: 本 home 的 OSS 凭据未配置')
    expect(readState(paths.stateFile).lastRunOk).toBe(false)
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
    await runFullBackup({ credentials: { password: "fixture-restic-password", ossEnv: { AWS_ACCESS_KEY_ID: "fixture-access-id", AWS_SECRET_ACCESS_KEY: "fixture-access-secret" } },
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
    const n = buildNotification({ ok: false, snapshotId: null, size: null, durationSeconds: 1 }, null, 'L:/log')
    expect(n.title).toBe('Restic Backup FAILED')
    expect(n.body).toContain('L:/log')
  })

  it('本地成 + OSS 关 → OK', () => {
    const n = buildNotification({ ok: true, snapshotId: 'a', size: '4.9 KiB', durationSeconds: 61 }, null, 'L')
    expect(n.title).toBe('Restic Backup OK')
    expect(n.body).toBe('4.9 KiB | local 1:01')
  })

  it('本地成 + OSS 成 → OK 带 OSS 段', () => {
    const n = buildNotification(
      { ok: true, snapshotId: 'a', size: null, durationSeconds: 1 },
      { ok: true, snapshotId: 'b', size: null, durationSeconds: 2 },
      'L',
    )
    expect(n.title).toBe('Restic Backup OK')
    expect(n.body).toBe('local 0:01 | OSS 0:02')
  })
})
