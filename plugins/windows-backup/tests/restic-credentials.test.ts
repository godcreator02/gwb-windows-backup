import { describe, expect, it } from 'vitest'
import { parseOssCredentials, readOssCredentials } from '../src/credentials.js'
import { ossRepoUrl, parentUnusable, parseProcessedSize, parseSnapshotId, pruneArgs, resticEnv, runRestic } from '../src/restic.js'
import type { RunProcess } from '../src/process.js'

describe('parseOssCredentials', () => {
  it('KEY=VALUE 逐行收，空行与 # 注释跳过', () => {
    const env = parseOssCredentials('AWS_ACCESS_KEY_ID=abc\n# 注释\n\nAWS_SECRET_ACCESS_KEY=def\r\n')
    expect(env).toEqual({ AWS_ACCESS_KEY_ID: 'abc', AWS_SECRET_ACCESS_KEY: 'def' })
  })

  it('格式不对的行报出行号，不带那一行的内容', () => {
    expect(() => parseOssCredentials('AWS_ACCESS_KEY_ID=abc\nexport SECRET=xyz')).toThrow('OSS 凭据文件第 2 行不是 KEY=VALUE')
    try {
      parseOssCredentials('没有等号的秘密')
    } catch (error) {
      expect(String(error)).not.toContain('秘密')
    }
  })

  it('缺两个必需键之一 → 报缺哪个', () => {
    expect(() => parseOssCredentials('AWS_ACCESS_KEY_ID=abc')).toThrow('OSS 凭据文件缺 AWS_SECRET_ACCESS_KEY')
  })

  it('readOssCredentials 文件不在 → 抛错并说出路径', () => {
    expect(() => readOssCredentials('/definitely/not/here.txt')).toThrow('没有 OSS 凭据文件')
  })
})
describe('runRestic', () => {
  it('自动补 --repo 与 --password-file，用户参数原样在后', async () => {
    let seen: { exe: string; args: string[] } | undefined
    const fake: RunProcess = async (exe, args) => {
      seen = { exe, args }
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    await runRestic('restic.exe', 'D:/repo', ['snapshots', '--json'], { password: 'fixture-password', run: fake })
    expect(seen?.exe).toBe('restic.exe')
    expect(seen?.args).toEqual(['--repo', 'D:/repo', 'snapshots', '--json'])
  })
})

describe('参数表 SSOT', () => {
  it('ossRepoUrl 拼法', () => {
    expect(ossRepoUrl({ ossEndpoint: 'oss-cn-beijing.aliyuncs.com', ossBucket: 'b', ossRepoPath: 'restic-prod' })).toBe(
      's3:oss-cn-beijing.aliyuncs.com/b/restic-prod',
    )
  })

  it('pruneArgs 一字不差（跟 restic 的实际接受度绑死）', () => {
    expect(
      pruneArgs({ keepWithin: '72h', keepWithinDaily: '14d', keepWeekly: 8, keepMonthly: 12 }),
    ).toEqual(['forget', '--group-by', 'host', '--keep-within', '72h', '--keep-within-daily', '14d', '--keep-weekly', '8', '--keep-monthly', '12', '--prune'])
  })
})

describe('resticEnv', () => {
  it('父 env 打底，只叠 GOMAXPROCS 与 OSS 键；绝不改 base', () => {
    const base = { PATH: 'x' } as NodeJS.ProcessEnv
    const env = resticEnv(2, { AWS_ACCESS_KEY_ID: 'k' }, base)
    expect(env).toMatchObject({ PATH: 'x', GOMAXPROCS: '2', AWS_ACCESS_KEY_ID: 'k', AWS_EC2_METADATA_DISABLED: 'true' })
    expect(base).toEqual({ PATH: 'x' })
  })
})

describe('stdout 解析', () => {
  it('snapshot id 与体量', () => {
    expect(parseSnapshotId('snapshot abc12345 saved')).toBe('abc12345')
    expect(parseSnapshotId('nope')).toBeNull()
    expect(parseProcessedSize('processed 42 files, 4.9 KiB in 0:01')).toBe('4.9 KiB')
    expect(parseProcessedSize('processed 42 files, 120 B in 0:00')).toBe('120 B')
    expect(parseProcessedSize('nope')).toBeNull()
  })
})

describe('parentUnusable', () => {
  it('只认 restic 说父快照找不到的那两句原话', () => {
    expect(parentUnusable('', 'no matching ID found for prefix "abc"')).toBe(true)
    expect(parentUnusable('unable to find snapshot abc', '')).toBe(true)
    expect(parentUnusable('', 'Fatal: unable to open repository')).toBe(false)
  })
})