/**
 * 凭据——**只算路径、只解析 KEY=VALUE，不往日志 / stdout / 异常消息里漏一个字节**。
 *
 * 两份凭据的待遇不一样：
 * - `restic-password.txt`：内容**永不进本进程**，只把路径交给 restic 的 `--password-file`。
 *   读进内存就有机会被某条 `console.log` 或某个异常的 `error.message` 带出去。
 * - `oss-credentials.txt`：非读不可（restic 的 S3 后端认环境变量），但解析结果只往子进程的
 *   env 里塞，绝不落任何日志。**解析失败的行静默跳过**——报错就得说清哪一行坏了，那句话
 *   本身就是泄漏面。
 *
 * 解析规则照老仓从 shlex 复刻来的那套：`export ` 前缀、单双引号、反斜杠转义、
 * 空行与 `#` 注释行。
 */

import { existsSync, readFileSync } from 'node:fs'

/** 从凭据文件文本解析出一组环境变量。任何一行坏了只跳过那一行。 */
export function parseOssCredentials(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const tokens = splitPosix(line)
    if (tokens === null) continue // 引号不闭合等格式错误——静默跳过
    let head = tokens[0]
    if (head === 'export') head = tokens[1]
    if (head === undefined) continue
    const eq = head.indexOf('=')
    if (eq <= 0) continue // 没有 `=` 或 `=` 开头（空键）都不算数
    const key = head.slice(0, eq).trim()
    if (key === '') continue
    env[key] = head.slice(eq + 1)
  }
  return env
}

/**
 * 读 OSS 凭据文件，返回环境变量对象。
 *
 * **文件不存在返回 `{}` 而不是抛**：OSS 开着但凭据没落地，是新机部署途中的正常中间态。
 * 让它继续往下走，restic 会以非零码失败，日志里留下标准的
 * `OSS push FAILED with exit code N` 契约行——比在这里抛一个不进日志的异常有用得多。
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
 * POSIX 风格分词，复刻 `shlex.split(line, comments=False, posix=True)`。
 * 引号不闭合返回 `null`（对应 Python 那边的 `ValueError`）。
 */
function splitPosix(line: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string
    if (quote === "'") {
      // 单引号里什么都不转义，连反斜杠都是字面量
      if (char === "'") quote = null
      else current += char
      continue
    }
    if (quote === '"') {
      // 双引号里反斜杠只对 `"` 与 `\` 生效，其余原样留着反斜杠
      if (char === '\\') {
        const next = line[index + 1]
        if (next === '"' || next === '\\') {
          current += next
          index += 1
        } else {
          current += char
        }
        continue
      }
      if (char === '"') quote = null
      else current += char
      continue
    }
    if (char === '\\') {
      const next = line[index + 1]
      if (next === undefined) return null // 行尾裸反斜杠 = 续行，单行解析里当格式错
      current += next
      index += 1
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }

  if (quote !== null) return null
  if (started) tokens.push(current)
  return tokens
}
