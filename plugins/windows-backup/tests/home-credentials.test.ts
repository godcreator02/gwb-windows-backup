import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackupCredentials, decodeResticPassword } from '../src/credentials.js'
import { layout } from '../src/paths.js'
import { resticEnv, runRestic } from '../src/restic.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gwb-backup-credentials-')); dirs.push(dir)
  const paths = layout(dir); mkdirSync(paths.credentialsDir)
  const values = new Map<string, unknown>()
  const settings = {
    define: () => () => {}, get: (key: string) => values.get(key),
    set: vi.fn(async (key: string, value: unknown) => { values.set(key, value) }),
  }
  return { values, settings, paths, create: () => new BackupCredentials(settings, paths) }
}

describe('restic file migration semantics', () => {
  it('matches BOM decoding and Go whitespace trimming, retaining internal whitespace and FEFF', () => {
    expect(decodeResticPassword(Buffer.from('\ufeff \tfirst\nsecond\r\n'))).toBe('first\nsecond')
    expect(decodeResticPassword(Buffer.from('\ufeff \u0085密码 \n', 'utf16le'))).toBe('密码')
    expect(decodeResticPassword(Buffer.from([0xfe, 0xff, 0x00, 0x20, 0x00, 0x61, 0x00, 0x20]))).toBe('a')
    expect(decodeResticPassword(Buffer.from(' \ufeffinner\ufeff '))).toBe('\ufeffinner\ufeff')
    expect(() => decodeResticPassword(Buffer.from([0xff, 0x00]))).toThrow('编码')
    expect(() => decodeResticPassword(Buffer.from('a\0b'))).toThrow('无效')
  })
  it('migrates original values once, retains recovery files, and respects deletion across reload', async () => {
    const f = fixture()
    const old = Buffer.from('\ufeff原仓库密码\r\n', 'utf16le')
    writeFileSync(f.paths.passwordFile, old)
    writeFileSync(f.paths.ossCredentialsFile, 'AWS_ACCESS_KEY_ID=fixture-id\nAWS_SECRET_ACCESS_KEY=fixture-secret\n')
    expect(await f.create().read(true)).toEqual({ password: '原仓库密码', ossEnv: { AWS_ACCESS_KEY_ID: 'fixture-id', AWS_SECRET_ACCESS_KEY: 'fixture-secret' } })
    expect(readFileSync(f.paths.passwordFile)).toEqual(old)
    f.values.delete('restic-password')
    await expect(f.create().read(false)).rejects.toThrow('未配置')
    expect(f.values.has('restic-password')).toBe(false)
  })
  it('does not overwrite a configured value, and does not search another home', async () => {
    const a = fixture(); const b = fixture()
    writeFileSync(a.paths.passwordFile, 'legacy-password')
    a.values.set('restic-password', 'current-password')
    expect((await a.create().read(false)).password).toBe('current-password')
    await expect(b.create().read(false)).rejects.toThrow('未配置')
    writeFileSync(b.paths.passwordFile, 'late-legacy-file')
    await expect(b.create().read(false)).rejects.toThrow('未配置')
  })
  it('failed persistence preserves files and allows a fresh instance to retry', async () => {
    const f = fixture(); writeFileSync(f.paths.passwordFile, 'preserved-password')
    f.settings.set.mockRejectedValueOnce(new Error('fixture-secret-in-backend-error'))
    await expect(f.create().read(false)).rejects.toThrow('迁移未完成')
    expect(f.values.get('restic-password-migrated')).toBeUndefined()
    expect(readFileSync(f.paths.passwordFile, 'utf8')).toBe('preserved-password')
    expect((await f.create().read(false)).password).toBe('preserved-password')
  })
  it('invalid OSS material does not block local credentials', async () => {
    const f = fixture(); writeFileSync(f.paths.passwordFile, 'local-password')
    writeFileSync(f.paths.ossCredentialsFile, 'PATH=attacker-value\n')
    const store = f.create()
    expect((await store.read(false)).password).toBe('local-password')
    await expect(store.read(true)).rejects.toThrow('oss-credentials 迁移未完成')
  })
})

describe('subprocess authentication boundary', () => {
  it('removes inherited credentials and does not mutate the parent environment', () => {
    const base = { PATH: 'bin', AWS_ACCESS_KEY_ID: 'other-home', RESTIC_PASSWORD: 'other-password', RESTIC_PASSWORD_FILE: 'other-file', AWS_PROFILE: 'other-profile', AWS_WEB_IDENTITY_TOKEN_FILE: 'other-token' }
    const env = resticEnv(1, {}, base)
    for (const key of ['AWS_ACCESS_KEY_ID', 'RESTIC_PASSWORD', 'RESTIC_PASSWORD_FILE', 'AWS_PROFILE', 'AWS_WEB_IDENTITY_TOKEN_FILE']) expect(env[key]).toBeUndefined()
    expect(env.AWS_EC2_METADATA_DISABLED).toBe('true')
    expect(env.PATH).toBe('bin'); expect(base.RESTIC_PASSWORD).toBe('other-password')
  })
  it('injects only into the child and redacts echoed credentials before any reply or log', async () => {
    const password = 'fixture-password'; const key = 'fixture-access-secret'
    const run = vi.fn(async (_exe: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      expect(args).not.toContain(password)
      expect(options?.env?.RESTIC_PASSWORD).toBe(password)
      return { code: 1, stdout: `echo ${password}`, stderr: `auth ${key}`, timedOut: false }
    })
    const result = await runRestic('restic', 'repo', ['snapshots'], { password, env: resticEnv(1, { AWS_SECRET_ACCESS_KEY: key }), run })
    expect(JSON.stringify(result)).not.toContain(password); expect(JSON.stringify(result)).not.toContain(key)
    await expect(runRestic('restic', 'repo', ['--password-command=other'], { password, run })).rejects.toThrow('不能覆盖')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
