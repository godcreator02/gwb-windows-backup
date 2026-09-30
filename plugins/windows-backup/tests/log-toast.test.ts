import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger, KEEP_LAST_LINES, ROTATE_WHEN_BYTES, timestamp } from '../src/log.js'
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

  it('rotate 超阈值只留末尾那么多行并写一行轮转标记', () => {
    const file = tmpFile()
    const longLine = 'x'.repeat(300)
    const lineCount = Math.ceil(ROTATE_WHEN_BYTES / longLine.length) + KEEP_LAST_LINES
    writeFileSync(file, Array.from({ length: lineCount }, (_unused, index) => `${String(index)} ${longLine}`).join('\n') + '\n', 'utf8')
    createLogger(file).rotate()
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
    expect(lines.length).toBe(KEEP_LAST_LINES + 1)
    expect(lines.at(-1)).toContain(`Log rotated (kept last ${KEEP_LAST_LINES} lines)`)
  })

  it('没超阈值、文件还没生出来都不动', () => {
    const file = tmpFile()
    const logger = createLogger(file)
    expect(() => logger.rotate()).not.toThrow()
    logger.line('一行')
    logger.rotate()
    expect(readFileSync(file, 'utf8')).not.toContain('Log rotated')
  })

  it('timestamp 是本地时区', () => {
    expect(timestamp(new Date(2026, 8, 8, 9, 5, 3))).toBe('2026-09-08 09:05:03')
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
    const ok = await sendToast('t', 'b', logger, fake)
    expect(ok).toBe(false)
    expect(lines).toEqual(['Notification failed: 爆了'])
  })

  it('超时那条人话也进日志', async () => {
    const fake: RunProcess = async () => ({ code: -1, stdout: '', stderr: '', timedOut: true })
    const lines: string[] = []
    const logger = { file: '', line: (m: string) => lines.push(m), raw: () => {}, rotate: () => {} }
    await sendToast('t', 'b', logger, fake)
    expect(lines).toEqual(['Notification failed: PowerShell 超时'])
  })
})
