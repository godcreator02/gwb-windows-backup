import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger, nullLogger, timestamp } from '../src/log.js'
import type { RunProcess } from '../src/process.js'
import { buildToastCommand, buildToastXml, escapeXml, sendToast } from '../src/toast.js'

const dirs: string[] = []
const tmpFile = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gwb-wb-log-'))
  dirs.push(dir)
  return path.join(dir, 'restic-backup.log')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('logger', () => {
  it('line 带时间戳，raw 原样不加时间戳', () => {
    const file = tmpFile()
    const logger = createLogger(file, () => new Date(2026, 8, 8, 9, 5, 3))
    logger.line('Backup started')
    logger.raw('restic 自己的输出\n')
    expect(readFileSync(file, 'utf8')).toBe('[2026-09-08 09:05:03] Backup started\nrestic 自己的输出\n')
  })

  it('rotate 超阈值只留末 N 行并落轮转标记', () => {
    const file = tmpFile()
    const logger = createLogger(file)
    for (let i = 1; i <= 10; i += 1) logger.line(`行${i}`)
    logger.rotate({ rotateWhenBytes: 1, keepLastLines: 3 })
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('行8')
    expect(text).toContain('行10')
    expect(text).not.toContain('行7\n')
    expect(text).toContain('Log rotated (kept last 3 lines)')
  })

  it('文件还没生出来 rotate 不炸', () => {
    const logger = createLogger(tmpFile())
    expect(() => logger.rotate({ rotateWhenBytes: 10, keepLastLines: 5 })).not.toThrow()
  })

  it('timestamp 是本地时区', () => {
    expect(timestamp(new Date(2026, 8, 8, 9, 5, 3))).toBe('2026-09-08 09:05:03')
  })

  it('nullLogger 什么都不写', () => {
    const logger = nullLogger()
    expect(() => {
      logger.line('x')
      logger.raw('y')
      logger.rotate({ rotateWhenBytes: 1, keepLastLines: 1 })
    }).not.toThrow()
  })
})

describe('toast', () => {
  it('XML 转义五个实体，& 第一个换', () => {
    expect(escapeXml(`&<>'"`)).toBe('&amp;&lt;&gt;&apos;&quot;')
  })

  it('载荷里 title/body 都过转义（PS 单引号串的第二层）', () => {
    expect(buildToastXml("a'b", 'c"d')).toBe(
      '<toast><visual><binding template="ToastGeneric"><text>a&apos;b</text><text>c&quot;d</text></binding></visual></toast>',
    )
  })

  it('命令是 WinRT 三件套 + LoadXml + Show', () => {
    const command = buildToastCommand('<toast/>')
    expect(command).toContain('ToastNotificationManager')
    expect(command).toContain("LoadXml('<toast/>')")
    expect(command).toContain('.Show($toast)')
  })

  it('弹不出来只记一行、不抛、回 false', async () => {
    const fake: RunProcess = async () => ({ code: 1, stdout: '', stderr: '爆了', timedOut: false })
    const lines: string[] = []
    const logger = { file: '', line: (m: string) => lines.push(m), raw: () => {}, rotate: () => {} }
    const ok = await sendToast('t', 'b', { run: fake, logger })
    expect(ok).toBe(false)
    expect(lines).toEqual(['Notification failed: 爆了'])
  })

  it('超时那条人话也进日志', async () => {
    const fake: RunProcess = async () => ({ code: -1, stdout: '', stderr: '', timedOut: true })
    const lines: string[] = []
    const logger = { file: '', line: (m: string) => lines.push(m), raw: () => {}, rotate: () => {} }
    await sendToast('t', 'b', { run: fake, logger })
    expect(lines).toEqual(['Notification failed: PowerShell 超时'])
  })
})
