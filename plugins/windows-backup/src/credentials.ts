import { existsSync, readFileSync } from 'node:fs'

/**
 * 从 OSS 凭据文件文本解析出一组环境变量（`KEY=VALUE`，认 `export ` 前缀、引号、反斜杠转义、`#` 注释行）。
 * 坏行只跳过那一行、不报错：报错就要说出哪一行坏了，那句话会把凭据带进日志。
 */
export function parseOssCredentials(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const tokens = splitPosix(line)
    if (tokens === null) continue
    const assignment = tokens[0] === 'export' ? tokens[1] : tokens[0]
    if (assignment === undefined) continue
    const equalsAt = assignment.indexOf('=')
    if (equalsAt <= 0) continue
    const key = assignment.slice(0, equalsAt).trim()
    if (key === '') continue
    env[key] = assignment.slice(equalsAt + 1)
  }
  return env
}

/**
 * 读 OSS 凭据文件，返回环境变量对象。文件不存在或读不动都返回 `{}`：
 * 往下走 restic 会以非零码失败，日志里留下 `OSS push FAILED with exit code N` 契约行。
 */
export function readOssEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {}
  try {
    return parseOssCredentials(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * POSIX 风格分词，照 Python `shlex.split(line, comments=False, posix=True)` 的语义。
 * 引号不闭合、行尾裸反斜杠返回 `null`（对应 Python 那边的 `ValueError`）。
 */
function splitPosix(line: string): string[] | null {
  const tokens: string[] = []
  let currentToken = ''
  let tokenStarted = false
  let openQuote: '"' | "'" | null = null

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string
    if (openQuote === "'") {
      // 单引号里什么都不转义，反斜杠也是字面量
      if (char === "'") openQuote = null
      else currentToken += char
      continue
    }
    if (openQuote === '"') {
      // 双引号里反斜杠只对 `"` 与 `\` 生效，其余原样留着反斜杠
      if (char === '\\') {
        const next = line[index + 1]
        if (next === '"' || next === '\\') {
          currentToken += next
          index += 1
        } else {
          currentToken += char
        }
        continue
      }
      if (char === '"') openQuote = null
      else currentToken += char
      continue
    }
    if (char === '\\') {
      const next = line[index + 1]
      if (next === undefined) return null
      currentToken += next
      index += 1
      tokenStarted = true
      continue
    }
    if (char === '"' || char === "'") {
      openQuote = char
      tokenStarted = true
      continue
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(currentToken)
        currentToken = ''
        tokenStarted = false
      }
      continue
    }
    currentToken += char
    tokenStarted = true
  }

  if (openQuote !== null) return null
  if (tokenStarted) tokens.push(currentToken)
  return tokens
}
