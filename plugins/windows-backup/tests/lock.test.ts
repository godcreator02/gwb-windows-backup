import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquire, activeLock, isStale, readLock, STALE_AFTER_MS } from '../src/lock.js'

const dirs: string[] = []
const tmpFile = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gwb-wb-lock-'))
  dirs.push(dir)
  return path.join(dir, 'backup.lock')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('acquire / release', () => {
  it('占到了回持有句柄，锁里带租约与心跳，释放后锁文件没了', () => {
    const file = tmpFile()
    const held = acquire(file, { pid: 101, lease: 'lease-a' })
    expect(held).not.toBeNull()
    const lock = readLock(file)
    expect(lock?.pid).toBe(101)
    expect(lock?.lease).toBe('lease-a')
    expect(lock?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(lock?.beatAt).toBe(lock?.startedAt)
    held?.release()
    expect(existsSync(file)).toBe(false)
  })

  it('释放幂等', () => {
    const file = tmpFile()
    const held = acquire(file, { pid: 101 })
    held?.release()
    expect(() => held?.release()).not.toThrow()
  })

  it('活人占着 → 后来者拿 null', () => {
    const file = tmpFile()
    const first = acquire(file, { pid: 101, alive: () => true })
    expect(first).not.toBeNull()
    expect(acquire(file, { pid: 202, alive: () => true })).toBeNull()
    first?.release()
  })

  it('进程没了 → 锁算陈旧，后来者接管', () => {
    const file = tmpFile()
    const first = acquire(file, { pid: 101, alive: () => false })
    expect(first).not.toBeNull()
    // 第二个看到的是死进程的锁——接管而不是永久停摆
    const second = acquire(file, { pid: 202, alive: (pid) => pid === 202 })
    expect(second).not.toBeNull()
    expect(readLock(file)?.pid).toBe(202)
  })

  it('心跳停了超过上限也算陈旧（pid 被回收的兜底）', () => {
    const file = tmpFile()
    const start = new Date('2026-09-08T08:00:00Z')
    const first = acquire(file, { pid: 101, alive: () => true, now: () => start })
    expect(first).not.toBeNull()
    const later = new Date(start.getTime() + STALE_AFTER_MS + 1)
    const second = acquire(file, { pid: 202, alive: () => true, now: () => later })
    expect(second).not.toBeNull()
  })

  it('释放只删自己的 lease——被抢的那方晚一步删不动新主人的锁', () => {
    const file = tmpFile()
    const stale = acquire(file, { pid: 101, lease: 'lease-old', alive: () => false })
    const fresh = acquire(file, { pid: 202, lease: 'lease-new', alive: (pid) => pid === 202 })
    expect(fresh).not.toBeNull()
    stale?.release() // 被抢的那方跑完来删——lease 对不上，一个字都不动
    expect(readLock(file)?.pid).toBe(202)
  })

  it('同一个 pid 的两代任务也分得清：旧代的 release 删不掉新代的锁', () => {
    const file = tmpFile()
    // 同 pid 时 alive 判定分不出两代，抢占只能走时间支（第一代心跳停了超上限）
    const start = new Date('2026-09-08T08:00:00Z')
    const older = acquire(file, { pid: 101, lease: 'lease-gen1', alive: () => true, now: () => start })
    const later = new Date(start.getTime() + STALE_AFTER_MS + 1)
    const newer = acquire(file, { pid: 101, lease: 'lease-gen2', alive: () => true, now: () => later })
    expect(newer).not.toBeNull()
    older?.release() // pid 相同——但租约不同，删不掉
    expect(readLock(file)?.lease).toBe('lease-gen2')
  })

  it('心跳刷新 beatAt；锁已被抢走后心跳是空操作', () => {
    const file = tmpFile()
    const held = acquire(file, { pid: 101, lease: 'lease-a', alive: () => true })
    held?.renew()
    expect(readLock(file)?.lease).toBe('lease-a')
    // 被抢：原持有方还跳心跳——lease 对不上，锁内容一个字不变
    const taker = acquire(file, { pid: 202, lease: 'lease-b', alive: (pid) => pid === 202, now: () => new Date(Date.now() + STALE_AFTER_MS + 1) })
    expect(taker).not.toBeNull()
    const before = readLock(file)
    held?.renew()
    expect(readLock(file)).toEqual(before)
  })
})

describe('readLock / isStale', () => {
  it('锁文件坏了当没有锁', () => {
    const file = tmpFile()
    expect(readLock('/definitely/not/here.lock')).toBeNull()
    writeFileSync(file, '坏 JSON', 'utf8')
    expect(readLock(file)).toBeNull()
  })

  it('缺 lease 或 beatAt 的锁当没有有效的锁', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ pid: 1, startedAt: '2026-09-08T19:59:00Z' }), 'utf8')
    expect(readLock(file)).toBeNull()
  })

  it('beatAt 认不出的算陈旧', () => {
    expect(isStale({ pid: 1, lease: 'l', startedAt: '2026-09-08T08:00:00Z', beatAt: '垃圾' }, { alive: () => true })).toBe(true)
  })

  it('陈旧判定看心跳不看开工时长——startedAt 早已超限、心跳刚跳过的不算死', () => {
    const now = new Date('2026-09-08T20:00:00Z')
    const startedAt = '2026-09-08T08:00:00Z'
    expect(isStale({ pid: 1, lease: 'l', startedAt, beatAt: '2026-09-08T19:59:00Z' }, { alive: () => true, now: () => now })).toBe(false)
    expect(isStale({ pid: 1, lease: 'l', startedAt, beatAt: startedAt }, { alive: () => true, now: () => now })).toBe(true)
  })
})

describe('activeLock', () => {
  it('持着的锁算正在跑；释放后、或持锁进程没了都不算', () => {
    const file = tmpFile()
    expect(activeLock(file)).toBeNull()
    const held = acquire(file)
    expect(activeLock(file)?.pid).toBe(process.pid)
    held?.release()
    expect(activeLock(file)).toBeNull()
    acquire(file, { pid: 999_999_999 })
    expect(activeLock(file)).toBeNull()
  })
})
