import { existsSync, readFileSync } from 'node:fs'

/** restic 写 `s3:` 仓库必须有的两个环境变量。 */
export const REQUIRED_OSS_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const

/**
 * 从 OSS 凭据文件文本解析出一组环境变量：每行 `KEY=VALUE`，空行与 `#` 开头的行跳过，值原样取到行尾。
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
