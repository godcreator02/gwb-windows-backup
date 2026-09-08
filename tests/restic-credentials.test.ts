import { describe, expect, it } from 'vitest'
import { parseOssCredentials, readOssEnv } from '../src/credentials.js'
import { ossRepoUrl, parseProcessedSize, parseSnapshotId, pruneArgs, resticEnv, runRestic } from '../src/restic.js'
import type { RunProcess } from '../src/process.js'

describe('parseOssCredentials', () => {
  it('KEY=VALUE 逐行收，空行与 # 注释跳过', () => {
    const env = parseOssCredentials('AWS_ACCESS_KEY_ID=abc\n# 注释\n\nAWS_SECRET_ACCESS_KEY=def')
    expect(env).toEqual({ AWS_ACCESS_KEY_ID: 'abc', AWS_SECRET_ACCESS_KEY: 'def' })
  })

  it('export 前缀剥掉', () => {
    expect(parseOssCredentials('export AWS_ACCESS_KEY_ID=abc')).toEqual({ AWS_ACCESS_KEY_ID: 'abc' })
  })

  it('单双引号与反斜杠转义照 shlex 规矩', () => {
    expect(parseOssCredentials("AWS_SECRET_ACCESS_KEY='a b'")).toEqual({ AWS_SECRET_ACCESS_KEY: 'a b' })
    expect(parseOssCredentials('K="va\\"lue"')).toEqual({ K: 'va"lue' })
  })

  it('坏行静默跳过——报错本身就是泄漏面', () => {
    expect(parseOssCredentials('没有等号\n"引号不闭合\n=空键')).toEqual({})
  })

  it('readOssEnv 文件不存在回空对象（部署途中的正常中间态）', () => {
    expect(readOssEnv('/definitely/not/here.txt')).toEqual({})
  })
})

describe('runRestic', () => {
  it('自动补 --repo 与 --password-file，用户参数原样在后', async () => {
    let seen: { exe: string; args: string[] } | undefined
    const fake: RunProcess = async (exe, args) => {
      seen = { exe, args }
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    await runRestic('restic.exe', 'D:/repo', ['snapshots', '--json'], { passwordFile: 'p.txt', run: fake })
    expect(seen?.exe).toBe('restic.exe')
    expect(seen?.args).toEqual(['--repo', 'D:/repo', '--password-file', 'p.txt', 'snapshots', '--json'])
  })
})

describe('参数表 SSOT', () => {
  it('ossRepoUrl 拼法', () => {
    expect(ossRepoUrl({ endpoint: 'oss-cn-beijing.aliyuncs.com', bucket: 'b', repoPath: 'restic-prod' })).toBe(
      's3:oss-cn-beijing.aliyuncs.com/b/restic-prod',
    )
  })

  it('pruneArgs 一字不差（跟 restic 的实际接受度绑死）', () => {
    expect(
      pruneArgs({ keepWithin: '72h', keepWithinDaily: '14d', keepWeekly: 8, keepMonthly: 12 }),
    ).toEqual(['forget', '--keep-within', '72h', '--keep-within-daily', '14d', '--keep-weekly', '8', '--keep-monthly', '12', '--prune'])
  })
})

describe('resticEnv', () => {
  it('父 env 打底，只叠 GOMAXPROCS 与 OSS 键；绝不改 base', () => {
    const base = { PATH: 'x' } as NodeJS.ProcessEnv
    const env = resticEnv(2, { AWS_ACCESS_KEY_ID: 'k' }, base)
    expect(env).toEqual({ PATH: 'x', GOMAXPROCS: '2', AWS_ACCESS_KEY_ID: 'k' })
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
