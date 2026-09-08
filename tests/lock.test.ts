import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquire, isStale, readLock, STALE_AFTER_MS } from '../src/lock.js'

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
  it('占到了回释放函数，释放后锁文件没了', () => {
    const file = tmpFile()
    const releaseLock = acquire(file, { pid: 101 })
    expect(releaseLock).not.toBeNull()
    const lock = readLock(file)
    expect(lock?.pid).toBe(101)
    expect(lock?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    releaseLock?.()
    expect(existsSync(file)).toBe(false)
  })

  it('释放函数幂等', () => {
    const file = tmpFile()
    const releaseLock = acquire(file, { pid: 101 })
    releaseLock?.()
    expect(() => releaseLock?.()).not.toThrow()
  })

  it('活人占着 → 后来者拿 null', () => {
    const file = tmpFile()
    const first = acquire(file, { pid: 101, alive: () => true })
    expect(first).not.toBeNull()
    expect(acquire(file, { pid: 202, alive: () => true })).toBeNull()
    first?.()
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

  it('超过 6 小时也算陈旧（pid 被回收的兜底）', () => {
    const file = tmpFile()
    const start = new Date('2026-09-08T08:00:00Z')
    const first = acquire(file, { pid: 101, alive: () => true, now: () => start })
    expect(first).not.toBeNull()
    const later = new Date(start.getTime() + STALE_AFTER_MS + 1)
    const second = acquire(file, { pid: 202, alive: () => true, now: () => later })
    expect(second).not.toBeNull()
  })

  it('释放只删自己的 pid——被抢的那方晚一步删不动新主人的锁', () => {
    const file = tmpFile()
    const stale = acquire(file, { pid: 101, alive: () => false })
    const fresh = acquire(file, { pid: 202, alive: (pid) => pid === 202 })
    expect(fresh).not.toBeNull()
    stale?.() // 被抢的那方跑完来删——pid 对不上，一个字都不动
    expect(readLock(file)?.pid).toBe(202)
  })
})

describe('readLock / isStale', () => {
  it('锁文件坏了当没有锁', () => {
    const file = tmpFile()
    expect(readLock('/definitely/not/here.lock')).toBeNull()
    writeFileSync(file, '坏 JSON', 'utf8')
    expect(readLock(file)).toBeNull()
  })

  it('startedAt 认不出的也算陈旧', () => {
    expect(isStale({ pid: 1, startedAt: '垃圾' }, { alive: () => true })).toBe(true)
  })
})
