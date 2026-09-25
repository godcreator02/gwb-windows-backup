import { describe, expect, it } from 'vitest'
import {
  BACKUP_OK,
  BACKUP_STARTED,
  completedLine,
  failedLine,
  matchesFailure,
  OSS_PUSH_OK,
  ossPushStartedLine,
  startedLine,
} from '../src/messages.js'

describe('契约行', () => {
  it('四组锚句一字不差（存量日志认它们）', () => {
    expect(BACKUP_STARTED).toBe('Backup started')
    expect(BACKUP_OK).toBe('Backup completed successfully')
    expect(OSS_PUSH_OK).toBe('OSS push completed successfully')
    expect(startedLine('Prune')).toBe('Prune started')
    expect(completedLine('OSS prune')).toBe('OSS prune completed successfully')
    expect(failedLine('Backup', 1)).toBe('Backup FAILED with exit code 1')
    expect(ossPushStartedLine('s3:e/b/p')).toBe('OSS push started (s3:e/b/p)')
  })
})

describe('matchesFailure', () => {
  it('FAILED / Fatal / exit code 命中（大小写不敏感）', () => {
    expect(matchesFailure('Backup FAILED with exit code 1')).toBe(true)
    expect(matchesFailure('something failed badly')).toBe(true)
    expect(matchesFailure('Fatal: repository not found')).toBe(true)
    expect(matchesFailure('exit code 2')).toBe(true)
    expect(matchesFailure('[2026-09-08 10:00:00] Backup completed successfully')).toBe(false)
  })

  it('error 整词才算，terror 不算', () => {
    expect(matchesFailure('error: something wrong')).toBe(true)
    expect(matchesFailure('terror.txt')).toBe(false)
    expect(matchesFailure('errored-out.txt')).toBe(false)
  })

  it('0 errors 计数行不算失败', () => {
    expect(matchesFailure('0 errors')).toBe(false)
    expect(matchesFailure('processed 100 files, 0 errors')).toBe(false)
    expect(matchesFailure('1 errors')).toBe(true)
  })
})
