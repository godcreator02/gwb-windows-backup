import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localTimestamp } from '../src/clock.js'
import { SETTINGS } from '../src/config.js'
import { mount } from '../src/index.js'
import type { HostContext, MountDeps } from '../src/index.js'
import { acquire } from '../src/lock.js'
import { layout } from '../src/paths.js'
import type { RunProcess } from '../src/process.js'
import { readState, writeState } from '../src/state.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type CommandDef = { name: string; description: string; usage: string; plugin: string; effect: string }

type Registered = {
  settingsDefs: Map<string, { type?: string; default?: unknown }>
  settingsValues: Map<string, unknown>
  commands: Map<string, (args?: unknown) => unknown>
  commandDefs: Map<string, CommandDef>
}

/**
 * 假宿主：effect 只登记 disposer；局部注入按「服务在场才回调」；设置 / 命令 / 外壳全是内存表。
 * 设置的 `get` 跟真插件一样：没设过的项回声明时的默认值。
 */
function fakeHost(services: { gwbShell?: unknown } = {}) {
  const registered: Registered = { settingsDefs: new Map(), settingsValues: new Map(), commands: new Map(), commandDefs: new Map() }
  const disposers: Array<() => void> = []
  const logs: string[] = []
  const dataDir = mkdtempSync(path.join(tmpdir(), 'gwb-wb-mount-'))
  dirs.push(dataDir)
  const base = {
    effect(setup: () => () => void): void {
      disposers.push(setup())
    },
    inject(deps: readonly string[], callback: (scoped: unknown) => void): void {
      const first = deps[0]
      if (first !== undefined && (services as Record<string, unknown>)[first] !== undefined) {
        callback({ ...base, ...(services as Record<string, unknown>) })
      }
    },
    // 官方 timer 插件 interval 的替身：vi 的假时钟能接管原生定时器
    interval(callback: () => void, ms: number): () => void {
      const id = setInterval(callback, ms)
      return () => clearInterval(id)
    },
    logger: {
      info: (...args: unknown[]) => logs.push(args.map(String).join('')),
      warn: (...args: unknown[]) => logs.push(args.map(String).join('')),
    },
    gwbCommands: {
      register(def: CommandDef, handler: (args?: unknown) => unknown) {
        registered.commands.set(def.name, handler)
        registered.commandDefs.set(def.name, def)
        return () => registered.commands.delete(def.name)
      },
    },
    gwbSettings: {
      define(def: { key: string; type?: string; default?: unknown }) {
        registered.settingsDefs.set(def.key, def)
        return () => registered.settingsDefs.delete(def.key)
      },
      async set(key: string, value: unknown) { registered.settingsValues.set(key, value) },
      get(key: string) {
        return registered.settingsValues.has(key) ? registered.settingsValues.get(key) : registered.settingsDefs.get(key)?.default
      },
    },
    gwbData: { dir: dataDir },
  }
  const call = async (command: string, args?: unknown): Promise<Record<string, unknown>> => {
    const handler = registered.commands.get(command)
    if (handler === undefined) throw new Error(`没登记 ${command}`)
    return (await handler(args)) as Record<string, unknown>
  }
  return { ctx: base as unknown as HostContext, registered, disposers, logs, dataDir, paths: layout(dataDir), call }
}

type FakeHost = ReturnType<typeof fakeHost>

/** 默认 deps：备份全成功（照真实现写 state）、restic 回一个 40 分钟前的快照。 */
function fakeDeps(over: Partial<MountDeps> = {}): MountDeps {
  return {
    runBackup: async (paths) => {
      writeState(paths.stateFile, { lastRunAt: localTimestamp(), lastRunOk: true, lastRunSummary: '4.9 KiB | local 0:01' })
      return { ok: true, skipped: null }
    },
    run: (async () => ({ code: 0, stdout: JSON.stringify([{ time: new Date(Date.now() - 40 * 60_000).toISOString() }]), stderr: '', timedOut: false })) as RunProcess,
    diskFree: () => ({ freeBytes: 9, totalBytes: 10 }),
    ...over,
  }
}

/** 设置里配齐一份能跑的配置；restic 位置指向一个真存在的文件，读快照那一步才会调 `run`。 */
function configure(host: FakeHost): void {
  host.registered.settingsValues.set('restic-password', 'fixture-restic-password')
  host.registered.settingsValues.set('sources', ['D:/Notes'])
  host.registered.settingsValues.set('local-repo', 'D:/Backup/test-repo')
  host.registered.settingsValues.set('restic-exe', process.execPath)
}

type StatusData = {
  version: string
  refuseReason: string | null
  backup: { frequencyMinutes: number | null; running: boolean; lastRunAt: string | null; lastRunOk: boolean | null; nextRunAt: string | null }
  health: { ok: boolean; items: { snapshots: { status: string } } } | null
  reminders: Array<{ what: string }>
}

const statusOf = async (host: FakeHost): Promise<StatusData> => (await host.call('windows-backup.status')).data as StatusData

describe('设置声明', () => {
  it('SETTINGS 里的每一项都声明了，默认值与类型照表', () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    expect([...host.registered.settingsDefs.keys()]).toEqual(['restic-password', 'restic-password-migrated', 'oss-credentials', 'oss-credentials-migrated', ...SETTINGS.map((spec) => spec.key)])
    expect(host.registered.settingsDefs.get('frequency-minutes')?.default).toBe(30)
    expect(host.registered.settingsDefs.get('sources')?.type).toBe('string-list')
    expect(host.registered.settingsDefs.has('health-check-interval-hours')).toBe(false)
  })
})

describe('命令面', () => {
  it('六条命令都登记上了，plugin 写完整包名，description / usage / effect 都有', () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    const effects = Object.fromEntries([...host.registered.commandDefs].map(([name, def]) => [name, def.effect]))
    expect(effects).toEqual({
      'windows-backup.run': 'external',
      'windows-backup.check': 'read',
      'windows-backup.status': 'read',
      'windows-backup.paths': 'read',
      'windows-backup.restic': 'external',
      'windows-backup.mark': 'write',
    })
    for (const def of host.registered.commandDefs.values()) {
      expect(def.plugin, def.name).toBe('@godcreator/gwb-windows-backup')
      expect(def.description.trim(), def.name).not.toBe('')
      expect(def.usage.trim(), def.name).not.toBe('')
    }
  })

  it('status 没配置时：拒跑理由指路 sources，健康结论照样现算', async () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    const status = await statusOf(host)
    expect(typeof status.version).toBe('string')
    expect(status.refuseReason).toContain('sources')
    expect(status.health).not.toBeNull()
    expect(status.backup.frequencyMinutes).toBe(30)
    expect(status.backup.running).toBe(false)
    expect(status.reminders.map((one) => one.what)).toEqual(['usb-copy', 'exclude-audit', 'review'])
  })

  it('status 设置不合法：拒跑理由说出哪个键，health 为 null', async () => {
    const host = fakeHost()
    configure(host)
    host.registered.settingsValues.set('frequency-minutes', 0)
    mount(host.ctx, fakeDeps())
    const status = await statusOf(host)
    expect(status.refuseReason).toContain('`frequency-minutes`')
    expect(status.health).toBeNull()
    expect(status.backup.frequencyMinutes).toBeNull()
  })

  it('status 现算：备份失败写进 state 之后，下一次 status 立刻看到', async () => {
    const host = fakeHost()
    configure(host)
    mount(host.ctx, fakeDeps())
    writeState(host.paths.stateFile, { lastRunAt: localTimestamp(), lastRunOk: false, lastRunSummary: 'OSS FAILED' })
    const status = await statusOf(host)
    expect(status.health?.ok).toBe(false)
  })

  it('run 未配置 → 拒跑并指路 sources', async () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    const result = await host.call('windows-backup.run')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('sources')
  })

  it('run 配置齐 → 跑完回 ok 与 state 里的这一轮', async () => {
    const host = fakeHost()
    configure(host)
    mount(host.ctx, fakeDeps())
    const result = await host.call('windows-backup.run')
    expect(result.ok).toBe(true)
    expect((result.data as { lastRunOk: boolean }).lastRunOk).toBe(true)
  })

  it('run 占不到锁（runner 回 locked）→ ok false 并说另一轮在跑', async () => {
    const host = fakeHost()
    configure(host)
    mount(host.ctx, fakeDeps({ runBackup: async () => ({ ok: false, skipped: 'locked' }) }))
    const result = await host.call('windows-backup.run')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('另一轮')
  })

  it('run 中途抛错 → 回本轮失败，不拿上一轮的成功冒充', async () => {
    const host = fakeHost()
    configure(host)
    writeState(host.paths.stateFile, { lastRunAt: '2026-09-01T10:00:00', lastRunOk: true, lastRunSummary: '上轮成功' })
    mount(host.ctx, fakeDeps({ runBackup: async () => Promise.reject(new Error('EIO')) }))
    const result = await host.call('windows-backup.run')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('本轮')
    expect(readState(host.paths.stateFile).lastRunOk).toBe(false)
  })

  it('run 跑完但备份失败 → 命令照实回失败', async () => {
    const host = fakeHost()
    configure(host)
    mount(host.ctx, fakeDeps({ runBackup: async () => ({ ok: false, skipped: null }) }))
    const result = await host.call('windows-backup.run')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('本轮')
  })

  it('另一轮持着锁 → status 显示正在跑，时间取锁里的 startedAt', async () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    const held = acquire(host.paths.lockFile)
    expect((await statusOf(host)).backup.running).toBe(true)
    held?.release()
    expect((await statusOf(host)).backup.running).toBe(false)
  })

  it('check → 读一次仓库，快照那项有了结论', async () => {
    const host = fakeHost()
    configure(host)
    mount(host.ctx, fakeDeps())
    expect((await statusOf(host)).health?.items.snapshots.status).toBe('unknown')
    await host.call('windows-backup.check')
    expect((await statusOf(host)).health?.items.snapshots.status).toBe('ok')
  })

  it('paths 回数据目录布局', async () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    const data = (await host.call('windows-backup.paths')).data as Record<string, string>
    expect(data.dataDir).toBe(host.dataDir)
    expect(data.stateFile).toBe(path.join(host.dataDir, 'state.json'))
    expect(data.lockFile).toBe(path.join(host.dataDir, 'backup.lock'))
  })

  it('restic 透传：自动补 --repo/--password-file，repo=oss 走 s3 地址并带上凭据', async () => {
    const host = fakeHost()
    configure(host)
    host.registered.settingsValues.set('oss-bucket', 'bkt')
    host.registered.settingsValues.set('oss-endpoint', 'oss-cn-beijing.aliyuncs.com')
    mkdirSync(host.paths.credentialsDir, { recursive: true })
    writeFileSync(host.paths.ossCredentialsFile, 'AWS_ACCESS_KEY_ID=k\nAWS_SECRET_ACCESS_KEY=s\n', 'utf8')
    const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = []
    mount(
      host.ctx,
      fakeDeps({
        run: (async (_exe: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
          seen.push({ args, env: options?.env })
          return { code: 0, stdout: '[]', stderr: '', timedOut: false }
        }) as RunProcess,
      }),
    )
    expect((await host.call('windows-backup.restic', { args: ['snapshots'] })).ok).toBe(true)
    expect(seen[0]?.args.slice(0, 2)).toEqual(['--repo', 'D:/Backup/test-repo'])
    expect(seen[0]?.args.slice(2)).toEqual(['snapshots'])

    expect((await host.call('windows-backup.restic', { repo: 'oss', args: ['snapshots'] })).ok).toBe(true)
    expect(seen[1]?.args[1]).toBe('s3:oss-cn-beijing.aliyuncs.com/bkt/restic-prod')
    expect(seen[1]?.env?.AWS_ACCESS_KEY_ID).toBe('k')
  })

  it('restic 透传：repo 或 args 形状不对、OSS 没配全都直接报错，不启动进程', async () => {
    const host = fakeHost()
    configure(host)
    let started = false
    mount(host.ctx, fakeDeps({ run: (async () => { started = true; return { code: 0, stdout: '', stderr: '', timedOut: false } }) as RunProcess }))
    expect((await host.call('windows-backup.restic', { repo: 'remote' })).error).toContain('repo 只认')
    expect((await host.call('windows-backup.restic', { args: ['snapshots', 3] })).error).toContain('args 要是字符串数组')
    expect((await host.call('windows-backup.restic', { repo: 'oss' })).error).toContain('OSS 还没配全')
    expect(started).toBe(false)
  })

  it('mark 补记人工维护，缺省今天；what 或 at 不对直接报错', async () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    expect((await host.call('windows-backup.mark', { what: '别的' })).ok).toBe(false)
    expect((await host.call('windows-backup.mark', { what: 'review', at: '2026-13-01' })).error).toContain('YYYY-MM-DD')
    const today = await host.call('windows-backup.mark', { what: 'usb-copy' })
    expect((today.data as { at: string }).at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const review = await host.call('windows-backup.mark', { what: 'review', at: '2026-09-01' })
    expect((review.data as { lastReview: string }).lastReview).toBe('2026-09-01')
    expect(readState(host.paths.stateFile).lastReview).toBe('2026-09-01')
  })
})

describe('每分钟一跳', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 记下每次跑备份与读快照。 */
  function recordingDeps(calls: string[]): MountDeps {
    const base = fakeDeps()
    return fakeDeps({
      runBackup: async (paths, config, credentials) => {
        calls.push('backup')
        return base.runBackup(paths, config, credentials)
      },
      run: (async (exe: string, args: string[]) => {
        calls.push(args.includes('snapshots') ? 'snapshots' : 'other')
        return base.run?.(exe, args) ?? { code: 0, stdout: '', stderr: '', timedOut: false }
      }) as RunProcess,
    })
  }

  it('加载当场什么都不跑；一分钟后从没跑过就跑一轮，跑完读一次仓库', async () => {
    const host = fakeHost()
    configure(host)
    const calls: string[] = []
    mount(host.ctx, recordingDeps(calls))
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(61_000)
    expect(calls).toEqual(['backup', 'snapshots'])
  })

  it('十分钟前刚跑过 → 不跑备份，只读一次仓库；之后没到期就什么都不做', async () => {
    const host = fakeHost()
    configure(host)
    writeState(host.paths.stateFile, { lastRunAt: localTimestamp(new Date(Date.now() - 10 * 60_000)), lastRunOk: true })
    const calls: string[] = []
    mount(host.ctx, recordingDeps(calls))
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1000)
    expect(calls).toEqual(['snapshots'])
  })

  it('改了周期下一跳就生效', async () => {
    const host = fakeHost()
    configure(host)
    writeState(host.paths.stateFile, { lastRunAt: localTimestamp(new Date(Date.now() - 20 * 60_000)), lastRunOk: true })
    const calls: string[] = []
    mount(host.ctx, recordingDeps(calls))
    await vi.advanceTimersByTimeAsync(61_000)
    expect(calls).not.toContain('backup')
    host.registered.settingsValues.set('frequency-minutes', 15)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toContain('backup')
  })

  it('另一轮持着锁 → 这一跳不启动', async () => {
    const host = fakeHost()
    configure(host)
    const held = acquire(host.paths.lockFile)
    const calls: string[] = []
    mount(host.ctx, recordingDeps(calls))
    await vi.advanceTimersByTimeAsync(61_000)
    expect(calls).toEqual([])
    held?.release()
  })

  it('拒跑理由每分钟都一样时只写一次日志', async () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000)
    expect(host.logs.filter((line) => line.includes('不跑定时备份')).length).toBe(1)
  })
})

describe('窗格（局部注入）与卸载', () => {
  it('外壳在场 → 注册窗格；缺席 → 命令照常', () => {
    let registeredPane = ''
    const withUi = fakeHost({
      gwbShell: {
        registerPane: (spec: { id: string }) => {
          registeredPane = spec.id
          return () => {}
        },
        describeSelf: () => () => {},
      },
    })
    mount(withUi.ctx, fakeDeps())
    expect(registeredPane).toBe('main')

    const headless = fakeHost()
    mount(headless.ctx, fakeDeps())
    expect(headless.registered.commands.size).toBe(6)
  })

  it('卸载（disposers 全跑）→ 命令、设置、定时都撤', () => {
    vi.useFakeTimers()
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    for (const dispose of host.disposers) dispose()
    expect(host.registered.commands.size).toBe(0)
    expect(host.registered.settingsDefs.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})
