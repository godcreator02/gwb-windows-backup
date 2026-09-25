import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 备份日志：`[YYYY-MM-DD HH:MM:SS] <msg>` 一行一条，子进程输出原样附上，超阈值轮转。契约行在 `messages.ts`。 */
export type Logger = {
  /** 日志文件绝对路径。 */
  file: string
  /** 追加一行带时间戳的日志。 */
  line: (message: string) => void
  /** 追加子进程的 stdout / stderr，原样、不加时间戳。 */
  raw: (text: string) => void
  /** 超阈值就只留末 N 行，并追加一行轮转标记。 */
  rotate: (logging: { rotateWhenBytes: number; keepLastLines: number }) => void
}

/** `[YYYY-MM-DD HH:MM:SS]` 的那个时间戳，本地时区。 */
export function timestamp(now: Date = new Date()): string {
  const twoDigits = (value: number): string => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())} ` +
    `${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}:${twoDigits(now.getSeconds())}`
  )
}

/** 造一个写到 `file` 的 logger，目录不在就建。一律同步写：链路中途崩了，已经写的行都在盘上。 */
export function createLogger(file: string, now: () => Date = () => new Date()): Logger {
  mkdirSync(path.dirname(file), { recursive: true })

  const raw = (text: string): void => {
    if (text === '') return
    appendFileSync(file, text, 'utf8')
  }
  const line = (message: string): void => {
    appendFileSync(file, `[${timestamp(now())}] ${message}\n`, 'utf8')
  }

  return {
    file,
    line,
    raw,
    rotate(logging) {
      let sizeBytes: number
      try {
        sizeBytes = statSync(file).size
      } catch {
        return // 日志还没生成，没什么可轮转的
      }
      if (sizeBytes <= logging.rotateWhenBytes) return
      const lines = readFileSync(file, 'utf8').split('\n')
      if (lines.at(-1) === '') lines.pop()
      const keptLines = lines.length > logging.keepLastLines ? lines.slice(-logging.keepLastLines) : lines
      writeFileSync(file, keptLines.length === 0 ? '' : `${keptLines.join('\n')}\n`, 'utf8')
      line(`Log rotated (kept last ${logging.keepLastLines} lines)`)
    },
  }
}

/** 一个什么都不写的 logger，给测试与「只算不写」的场景用。 */
export function nullLogger(): Logger {
  return { file: '', line: () => {}, raw: () => {}, rotate: () => {} }
}
