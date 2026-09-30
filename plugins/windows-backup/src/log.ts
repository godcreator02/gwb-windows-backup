import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { localTimestamp } from './clock.js'

/** 日志超过这么大就轮转。 */
export const ROTATE_WHEN_BYTES = 10_485_760
/** 轮转时留下末尾这么多行。 */
export const KEEP_LAST_LINES = 1000

/** 备份日志：`[YYYY-MM-DD HH:MM:SS] <msg>` 一行一条，子进程输出原样附上，超阈值轮转。给人看，程序不读它。 */
export type Logger = {
  /** 日志文件绝对路径。 */
  file: string
  /** 追加一行带时间戳的日志。 */
  line: (message: string) => void
  /** 追加子进程的 stdout / stderr，原样、不加时间戳。 */
  raw: (text: string) => void
  /** 超过 `ROTATE_WHEN_BYTES` 就只留末 `KEEP_LAST_LINES` 行，并追加一行轮转标记。 */
  rotate: () => void
}

/** `[YYYY-MM-DD HH:MM:SS]` 的那个时间戳，本地时区。 */
export function timestamp(now: Date = new Date()): string {
  return localTimestamp(now).replace('T', ' ')
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
    rotate() {
      if (!existsAndLargerThan(file, ROTATE_WHEN_BYTES)) return
      const lines = readFileSync(file, 'utf8').split('\n')
      if (lines.at(-1) === '') lines.pop()
      writeFileSync(file, `${lines.slice(-KEEP_LAST_LINES).join('\n')}\n`, 'utf8')
      line(`Log rotated (kept last ${String(KEEP_LAST_LINES)} lines)`)
    },
  }
}

function existsAndLargerThan(file: string, bytes: number): boolean {
  try {
    return statSync(file).size > bytes
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
