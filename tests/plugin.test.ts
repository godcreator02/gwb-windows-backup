import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '../src/index.js'
import type { HostContext, MountDeps } from '../src/index.js'
import { DEFAULT_FLAT } from '../src/config.js'
import type { HealthReport } from '../src/health.js'
import { layout } from '../src/paths.js'
import type { RunProcess } from '../src/process.js'
import { readState, writeState } from '../src/state.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 一份全绿的最小 HealthReport（fake runner 用）。 */
const greenReport: HealthReport = {
  checkedAt: '2026-09-08T10:00:00',
  ok: true,
  problems: [],
  items: {
    lastRun: { status: 'ok', lastRunAt: 'x', lastRunOk: true, lastRunSummary: null, ageMinutes: 1, toleranceMinutes: 60, message: '' },
    log: { status: 'ok', exists: true, localOk: true, ossOk: null, errorLines: [], message: '' },
    disk: { status: 'ok', drive: 'D:', freeBytes: 1, totalBytes: 2, freeRatio: 0.5, level: 'ok', message: '' },
    snapshots: { status: 'ok', latestAt: 'x', ageMinutes: 1, toleranceMinutes: 60, message: '' },
    periodic: { status: 'ok', usbCopyDays: 1, excludeAuditDays: 1, reviewDays: 1, usbCopyDue: false, excludeAuditDue: false, reviewDue: false, message: '' },
  },
}

type Registered = {
  settingsDefs: Map<string, { type?: string; default?: unknown }>
  settingsValues: Map<string, unknown>
  commands: Map<string, (args?: unknown) => unknown>
  /** 命令名 → 登记的 plugin 字段——commands 0.4 起认完整包名，写运行时名要被 warn */
  commandPlugins: Map<string, string>
  /** 命令名 → 登记时给的 description 与 usage */
  commandTexts: Map<string, { description: string; usage: string }>
  pane?: { id: string }
  cell?: { id: string }
}

/**
 * 假宿主：effect 只登记 disposer；局部注入按「服务在场才回调」；设置 / 命令 / 外壳
 * 全是内存表。`services` 里放局部注入可用的那几个服务（缺哪个，依赖它的那部分就不运行）。
 */
function fakeHost(services: { gwbShell?: unknown } = {}) {
  const registered: Registered = {
    settingsDefs: new Map(),
    settingsValues: new Map(),
    commands: new Map(),
    commandPlugins: new Map(),
    commandTexts: new Map(),
  }
  const disposers: Array<() => void> = []
  const logs: string[] = []
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
    // 官方 timer 插件两个方法的替身：真插件感知 fiber，测试里 vi 的假时钟能接管这两个原生定时器
    interval(callback: () => void, ms: number): () => void {
      const id = setInterval(callback, ms)
      return () => clearInterval(id)
    },
    timeout(callback: () => void, ms: number): void {
      setTimeout(callback, ms)
    },
    logger: {
      debug: () => {},
      info: (...args: unknown[]) => logs.push(String(args[0])),
      warn: (...args: unknown[]) => logs.push(String(args[0])),
    },
    gwbCommands: {
      register(def: { name: string; description: string; usage: string; plugin: string }, handler: (args?: unknown) => unknown) {
        registered.commands.set(def.name, handler)
        registered.commandPlugins.set(def.name, def.plugin)
        registered.commandTexts.set(def.name, { description: def.description, usage: def.usage })
        return () => registered.commands.delete(def.name)
      },
    },
    gwbSettings: {
      define(def: { key: string; type?: string; default?: unknown }) {
        registered.settingsDefs.set(def.key, def)
        return () => registered.settingsDefs.delete(def.key)
      },
      get(key: string) {
        return registered.settingsValues.get(key)
      },
    },
    gwbData: {
      dir: '',
    },
  }
  const dataDir = mkdtempSync(path.join(tmpdir(), 'gwb-wb-mount-'))
  dirs.push(dataDir)
  ;(base.gwbData as { dir: string }).dir = dataDir
  const ctx = base as unknown as HostContext
  return { ctx, registered, disposers, logs, dataDir }
}

/** 默认 deps：健康全绿、备份全成功、restic 直接回空结果。 */
function fakeDeps(over: Partial<MountDeps> = {}): MountDeps {
  return {
    runHealth: async () => greenReport,
    runBackup: async () => ({ ok: true, skipped: null, summary: '4.9 KiB | local 0:01' }),
    run: (async () => ({ code: 0, stdout: '[]', stderr: '', timedOut: false })) as RunProcess,
    ...over,
  }
}

/** 设置里配齐一份能跑的配置。 */
function configure(host: ReturnType<typeof fakeHost>): void {
  host.registered.settingsValues.set('sources', 'D:/Notes')
  host.registered.settingsValues.set('local-repo', 'D:/Backup/test-repo')
}

describe('设置声明', () => {
  it('17 个键全定义、默认值来自 DEFAULT_FLAT', () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    expect(host.registered.settingsDefs.size).toBe(17)
    expect(host.registered.settingsDefs.get('frequency-minutes')?.default).toBe(DEFAULT_FLAT.frequencyMinutes)
    expect(host.registered.settingsDefs.get('sources')?.default).toEqual([])
    expect(host.registered.settingsDefs.get('sources')?.type).toBe('string-list')
    expect(host.registered.settingsDefs.get('exclude')?.default).toEqual([])
    expect(host.registered.settingsDefs.get('exclude')?.type).toBe('string-list')
    expect(host.registered.settingsDefs.get('oss-enabled')?.default).toBe(false)
    expect(host.registered.settingsDefs.get('review-interval-days')?.default).toBe(DEFAULT_FLAT.reviewIntervalDays)
  })
})

describe('命令面', () => {
  it('六条命令都登记上了', () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    expect([...host.registered.commands.keys()].sort()).toEqual(
      ['windows-backup.check', 'windows-backup.mark', 'windows-backup.paths', 'windows-backup.restic', 'windows-backup.run', 'windows-backup.status'].sort(),
    )
    for (const [cmd, pkg] of host.registered.commandPlugins) expect(pkg, cmd).toBe('@godcreator/gwb-windows-backup')
  })

  it('每条命令的 description 与 usage 都是非空字符串（命令总线拒绝登记缺任何一项的命令）', () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    expect(host.registered.commandTexts.size).toBe(6)
    for (const [cmd, { description, usage }] of host.registered.commandTexts) {
      expect(typeof description, cmd).toBe('string')
      expect(description.trim(), cmd).not.toBe('')
      expect(typeof usage, cmd).toBe('string')
      expect(usage.trim(), cmd).not.toBe('')
    }
  })

  it('status 的形状：三指纹、backup 节、report 默认 null（= 没结论不是健康）', async () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    const handler = host.registered.commands.get('windows-backup.status')
    const result = (await handler?.()) as { ok: boolean; data: Record<string, unknown> }
    expect(result.ok).toBe(true)
    expect(result.data.plugin).toBe('gwb-windows-backup')
    expect(typeof result.data.version).toBe('string')
    expect(typeof result.data.moduleLoadedAt).toBe('string')
    expect(result.data.report).toBeNull()
    const backup = result.data.backup as Record<string, unknown>
    expect(backup.frequencyMinutes).toBe(30)
    expect(backup.nextRunAt).not.toBeNull()
  })

  it('run 未配置 → 拒跑并指路 sources', async () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    const handler = host.registered.commands.get('windows-backup.run')
    const result = (await handler?.()) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('sources')
  })

  it('run 配置齐 → 真跑、state 落 lastRunOk', async () => {
    const host = fakeHost()
    configure(host)
    const paths = layout(host.dataDir)
    const deps = fakeDeps({
      runBackup: async (p, _config) => {
        writeState(p.stateFile, { lastRunAt: '2026-09-08T10:00:00', lastRunOk: true, lastRunSummary: 's' })
        return { ok: true, skipped: null, summary: 's' }
      },
    })
    mount(host.ctx, deps)
    const handler = host.registered.commands.get('windows-backup.run')
    const result = (await handler?.()) as { ok: boolean; data?: { lastRunOk?: boolean | null } }
    expect(result.ok).toBe(true)
    expect(result.data?.lastRunOk).toBe(true)
    expect(readState(paths.stateFile).lastRunOk).toBe(true)
  })

  it('run 占不到锁（runner 回 locked）→ ok false + 人话', async () => {
    const host = fakeHost()
    configure(host)
    mount(host.ctx, fakeDeps({ runBackup: async () => ({ ok: false, skipped: 'locked', summary: null }) }))
    const result = (await host.registered.commands.get('windows-backup.run')?.()) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('锁')
  })

  it('run 中途炸了 → 回本轮失败，不拿上一轮的成功冒充', async () => {
    const host = fakeHost()
    configure(host)
    const paths = layout(host.dataDir)
    // state 里留着上一轮的成功——本轮抛错了，回执不许把它当本轮结论
    writeState(paths.stateFile, { lastRunAt: '2026-09-01T10:00:00', lastRunOk: true, lastRunSummary: '上轮成功' })
    mount(
      host.ctx,
      fakeDeps({
        runBackup: async () => {
          throw new Error('EIO')
        },
      }),
    )
    const result = (await host.registered.commands.get('windows-backup.run')?.()) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('本轮')
    // catch 把本轮失败记进了 state——读出来不再是上轮的 true
    expect(readState(paths.stateFile).lastRunOk).toBe(false)
  })

  it('run 跑完但备份失败（ok:false）→ 命令照实回失败', async () => {
    const host = fakeHost()
    configure(host)
    mount(
      host.ctx,
      fakeDeps({
        runBackup: async (p) => {
          writeState(p.stateFile, { lastRunAt: '2026-09-08T10:00:00', lastRunOk: false, lastRunSummary: 'restic 挂了' })
          return { ok: false, skipped: null, summary: 'restic 挂了' }
        },
      }),
    )
    const result = (await host.registered.commands.get('windows-backup.run')?.()) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('本轮')
  })

  it('check → report 进快照；再 status 也拿得到', async () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    await host.registered.commands.get('windows-backup.check')?.()
    const status = (await host.registered.commands.get('windows-backup.status')?.()) as { data: { report: HealthReport | null } }
    expect(status.data.report?.ok).toBe(true)
  })

  it('check 抛了 → lastError 记下、命令不崩', async () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps({ runHealth: async () => { throw new Error('探针炸了') } }))
    const result = (await host.registered.commands.get('windows-backup.check')?.()) as { data: { lastError: string | null } }
    expect(result.data.lastError).toContain('探针炸了')
  })

  it('paths 回数据目录布局', async () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    const result = (await host.registered.commands.get('windows-backup.paths')?.()) as { data: Record<string, string> }
    expect(result.data.dataDir).toBe(host.dataDir)
    expect(result.data.stateFile).toBe(path.join(host.dataDir, 'state.json'))
    expect(result.data.lockFile).toBe(path.join(host.dataDir, 'backup.lock'))
  })

  it('restic 直通：自动补 --repo/--password-file，repo=oss 走 s3 地址', async () => {
    const host = fakeHost()
    configure(host)
    host.registered.settingsValues.set('oss-enabled', true)
    host.registered.settingsValues.set('oss-bucket', 'bkt')
    host.registered.settingsValues.set('oss-endpoint', 'oss-cn-beijing.aliyuncs.com')
    const seen: Array<{ exe: string; args: string[] }> = []
    const deps = fakeDeps({
      run: (async (_exe: string, args: string[]) => {
        seen.push({ exe: _exe, args })
        return { code: 0, stdout: '[{"id":"a"}]', stderr: '', timedOut: false }
      }) as RunProcess,
    })
    mount(host.ctx, deps)
    const handler = host.registered.commands.get('windows-backup.restic')
    const local = (await handler?.({ repo: 'local', args: ['snapshots'] })) as { ok: boolean; data: { stdout: string } }
    expect(local.ok).toBe(true)
    // runRestic 补上的前四个参数是 --repo/--password-file
    expect(seen[0]?.args.slice(0, 2)).toEqual(['--repo', 'D:/Backup/test-repo'])
    expect(seen[0]?.args.slice(4)).toEqual(['snapshots'])

    const oss = (await handler?.({ repo: 'oss', args: ['snapshots'] })) as { ok: boolean }
    expect(oss.ok).toBe(true)
    expect(seen[1]?.args[1]).toBe('s3:oss-cn-beijing.aliyuncs.com/bkt/restic-prod')
  })

  it('mark 补记周期动作（含 review），缺省今天', async () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    const handler = host.registered.commands.get('windows-backup.mark')
    const bad = (await handler?.({ what: '别的' })) as { ok: boolean }
    expect(bad.ok).toBe(false)
    const ok = (await handler?.({ what: 'usb-copy' })) as { ok: boolean; data: { at: string } }
    expect(ok.ok).toBe(true)
    expect(ok.data.at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(readState(path.join(host.dataDir, 'state.json')).lastUsbCopy).toBe(ok.data.at)
    const review = (await handler?.({ what: 'review', at: '2026-09-01' })) as { ok: boolean; data: { lastReview: string | null } }
    expect(review.ok).toBe(true)
    expect(review.data.lastReview).toBe('2026-09-01')
    expect(readState(path.join(host.dataDir, 'state.json')).lastReview).toBe('2026-09-01')
  })
})

describe('定时器与补跑', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('30 秒首检 + 补跑（从没跑过）', async () => {
    vi.useFakeTimers()
    const host = fakeHost()
    const calls: string[] = []
    const deps = fakeDeps({
      runHealth: async () => {
        calls.push('check')
        return greenReport
      },
      runBackup: async () => {
        calls.push('backup')
        return { ok: true, skipped: null, summary: '' }
      },
    })
    configure(host)
    mount(host.ctx, deps)
    expect(calls).toEqual([]) // 挂载当场什么都不跑
    await vi.advanceTimersByTimeAsync(31_000)
    expect(calls).toContain('check')
    expect(calls).toContain('backup')
  })

  it('十分钟前刚跑过 → 不补跑', async () => {
    vi.useFakeTimers()
    const host = fakeHost()
    writeState(path.join(host.dataDir, 'state.json'), {
      lastRunAt: new Date(Date.now() - 10 * 60_000).toISOString().replace('Z', '').slice(0, 19),
    })
    const calls: string[] = []
    mount(host.ctx, fakeDeps({
      runBackup: async () => {
        calls.push('backup')
        return { ok: true, skipped: null, summary: '' }
      },
    }))
    await vi.advanceTimersByTimeAsync(31_000)
    expect(calls).toEqual([])
  })

  it('周期那根每跳推进 nextRunAt（老仓撞过的坑）', async () => {
    vi.useFakeTimers()
    const host = fakeHost()
    configure(host)
    mount(host.ctx, fakeDeps())
    const before = (await host.registered.commands.get('windows-backup.status')?.()) as { data: { backup: { nextRunAt: string } } }
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1000)
    const after = (await host.registered.commands.get('windows-backup.status')?.()) as { data: { backup: { nextRunAt: string } } }
    expect(new Date(after.data.backup.nextRunAt).getTime()).toBeGreaterThan(new Date(before.data.backup.nextRunAt).getTime())
  })

  it('设置里改了频率，跑一轮后计时器按新值重开', async () => {
    vi.useFakeTimers()
    const host = fakeHost()
    configure(host)
    mount(host.ctx, fakeDeps()) // 起来时按默认 30 分钟转
    host.registered.settingsValues.set('frequency-minutes', 15)
    // 手动跑一轮 → 用现读的配置核对定时器，发现 30 → 15，重建
    await host.registered.commands.get('windows-backup.run')?.()
    const status = (await host.registered.commands.get('windows-backup.status')?.()) as { data: { backup: { frequencyMinutes: number | null } } }
    expect(status.data.backup.frequencyMinutes).toBe(15)
    expect(host.logs.some((line) => line.includes('备份周期变更'))).toBe(true)
  })
})

describe('界面占位（局部注入）', () => {
  it('外壳在场 → 注册；缺席 → 一切照常', () => {
    const withUi = fakeHost({
      gwbShell: {
        registerPane: (_spec: { id: string }) => {
          return () => {}
        },
        describeSelf: () => () => {},
      },
    })
    mount(withUi.ctx, fakeDeps())
    expect(withUi.logs.some((line) => line.includes('已挂载'))).toBe(true)

    const headless = fakeHost()
    mount(headless.ctx, fakeDeps())
    expect(headless.logs.some((line) => line.includes('已挂载'))).toBe(true)
    expect(headless.registered.commands.size).toBe(6)
  })

  it('卸载（disposers 全跑）→ 命令全撤', () => {
    const host = fakeHost()
    mount(host.ctx, fakeDeps())
    expect(host.registered.commands.size).toBe(6)
    for (const dispose of host.disposers) dispose()
    expect(host.registered.commands.size).toBe(0)
    expect(host.registered.settingsDefs.size).toBe(0)
  })
})

/** 配置完整性检查：17 个键一个都不许删 */
describe('配置面', () => {
  it('DEFAULT_FLAT 的 17 键齐全', () => {
    expect(Object.keys(DEFAULT_FLAT).length).toBe(17)
  })
})
