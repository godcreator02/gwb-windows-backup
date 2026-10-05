import { existsSync, readFileSync } from 'node:fs'
import type { GwbSettingsApi } from '@godcreator/gwb-settings'
import type { BackupPaths } from './paths.js'

/** restic 写 `s3:` 仓库必须有的两个环境变量。 */
export const REQUIRED_OSS_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const
const ALLOWED_OSS_KEYS = new Set<string>([...REQUIRED_OSS_KEYS, 'AWS_SESSION_TOKEN'])
export const CREDENTIAL_KEYS = ['restic-password', 'oss-credentials'] as const
export type BackupSecrets = { password: string; ossEnv: Record<string, string> }

/** Match restic v0.18.1 textfile.Decode + strings.TrimSpace, rather than invent a new password. */
export function decodeResticPassword(bytes: Uint8Array): string {
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)
  let value: string
  try {
    value = new TextDecoder(utf16 ? (bytes[0] === 0xff ? 'utf-16le' : 'utf-16be') : 'utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('旧 restic 密码文件编码无效，未迁移；保留原文件用于恢复')
  }
  value = value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
  validatePassword(value)
  return value
}

function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\0'))
    throw new Error('restic-password 未配置或格式无效；用 credentials.import/copy 或设置界面配置原仓库密码')
}

/** Migrate once per home; retained legacy files are recovery material, never a runtime fallback. */
export class BackupCredentials {
  private pending: Promise<void> | undefined
  private disposers: Array<() => void> = []
  private errors = new Map<string, Error>()
  constructor(private settings: Pick<GwbSettingsApi, 'define' | 'get' | 'set'>, private paths: BackupPaths) {
    for (const key of CREDENTIAL_KEYS) {
      this.disposers.push(settings.define({ key, type: 'secret', title: key === 'restic-password' ? 'Restic 仓库密码' : 'OSS 凭据',
        description: key === 'restic-password' ? '必须与现有仓库一致；迁移不生成新密码。' : 'KEY=VALUE 文本，只含 AWS_ACCESS_KEY_ID、AWS_SECRET_ACCESS_KEY 和可选 AWS_SESSION_TOKEN。' }))
      this.disposers.push(settings.define({ key: `${key}-migrated`, type: 'boolean', default: false, title: `${key} 旧文件迁移已完成`,
        description: '完成后不再读取旧文件，清除凭据不会复活旧值。' }))
    }
  }
  initialize(): Promise<void> {
    return this.pending ??= this.migrate()
  }
  dispose(): void { for (const dispose of this.disposers.splice(0)) dispose() }
  private async migrate(): Promise<void> {
    for (const key of CREDENTIAL_KEYS) {
      try {
        if (this.settings.get(`${key}-migrated`) === true) continue
        if (this.settings.get(key) === undefined) {
          const file = key === 'restic-password' ? this.paths.passwordFile : this.paths.ossCredentialsFile
          if (existsSync(file)) {
            const value = key === 'restic-password' ? decodeResticPassword(readFileSync(file)) : readFileSync(file, 'utf8')
            if (key === 'oss-credentials') parseOssCredentials(value)
            await this.settings.set(key, value)
          }
        }
        await this.settings.set(`${key}-migrated`, true)
      } catch {
        this.errors.set(key, new Error(`${key} 迁移未完成；原文件保留，修复后重新加载插件`))
      }
    }
  }
  async read(includeOss: boolean): Promise<BackupSecrets> {
    await this.initialize()
    const migrationError = this.errors.get('restic-password') ?? (includeOss ? this.errors.get('oss-credentials') : undefined)
    if (migrationError) throw migrationError
    const password = this.settings.get('restic-password')
    validatePassword(password)
    const raw = this.settings.get('oss-credentials')
    if (includeOss && typeof raw !== 'string') throw new Error('oss-credentials 未配置；用 credentials.import/copy 或设置界面配置')
    return { password, ossEnv: includeOss ? parseOssCredentials(raw as string) : {} }
  }
}

/**
 * 从 OSS 凭据文本解析允许的环境变量：每行 `KEY=VALUE`，空行与注释跳过，值沿用旧实现的首尾空白整理。
 * 格式不对就抛错；报错只说第几行、缺哪个键，**不带任何一行的内容**——那会把凭据带进日志。
 */
export function parseOssCredentials(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const equalsAt = line.indexOf('=')
    const key = equalsAt > 0 ? line.slice(0, equalsAt).trim() : ''
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`OSS 凭据文件第 ${String(index + 1)} 行不是 KEY=VALUE`)
    }
    if (!ALLOWED_OSS_KEYS.has(key)) throw new Error(`OSS 凭据文件第 ${String(index + 1)} 行含不支持的环境变量键`)
    env[key] = line.slice(equalsAt + 1).trim()
  }
  const missing = REQUIRED_OSS_KEYS.filter((key) => (env[key] ?? '') === '')
  if (missing.length > 0) throw new Error(`OSS 凭据文件缺 ${missing.join('、')}`)
  return env
}

/** 读 OSS 凭据文件。文件不在、格式不对都抛错，错误消息里没有凭据内容。 */
export function readOssCredentials(file: string): Record<string, string> {
  if (!existsSync(file)) throw new Error(`没有 OSS 凭据文件：${file}`)
  return parseOssCredentials(readFileSync(file, 'utf8'))
}
