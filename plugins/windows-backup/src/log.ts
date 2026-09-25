/**
 * 备份日志：`[YYYY-MM-DD HH:MM:SS] <msg>` 一行一条 + 子进程输出原样附上 + 超阈值轮转。
 *
 * **这里的行文是契约，不是文案**。健康检查的日志尾判定全靠 grep 下面这几串字：
 *
 *     Backup started / Backup completed successfully / Backup FAILED with exit code N
 *     Prune started  / Prune completed successfully  / Prune FAILED with exit code N
 *     OSS push started (<repo>) / OSS push completed successfully / OSS push FAILED with exit code N
 *     OSS prune started / OSS prune completed successfully / OSS prune FAILED with exit code N
 *     Log rotated (kept last N lines) / Notification failed: ...
 *
 * 改一个词，健康检查就会把「备份早就断了」读成「一切正常」——而这种误报要等到灾后取数据
 * 那天才现形。所以这几串字只在 `messages.ts` 一处拼，别处一律引用。
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type Logger = {
  /** 日志文件绝对路径。 */
  file: string
  /** 追加一行带时间戳的日志。 */
  line: (message: string) => void
  /** 追加子进程的 stdout / stderr，**原样、不加时间戳**——restic 自己的排版有信息量。 */
  raw: (text: string) => void
  /** 超阈值就只留末 N 行，并追加一行轮转标记。 */
  rotate: (logging: { rotateWhenBytes: number; keepLastLines: number }) => void
}

/** `[YYYY-MM-DD HH:MM:SS]` 的那个时间戳，本地时区。 */
export function timestamp(now: Date = new Date()): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ` +
    `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`
  )
}

/**
 * 造一个写到 `file` 的 logger。目录不在就建。
 *
 * 一律同步写：备份链路上一条日志没落盘就崩了，等于没有排查线索；这条链路本来就是 IO
 * 密集的，同步写那点开销看不见。
 */
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
      let size: number
      try {
        size = statSync(file).size
      } catch {
        return // 日志还没生出来，没什么可轮转的
      }
      if (size <= logging.rotateWhenBytes) return
      const lines = readFileSync(file, 'utf8').split('\n')
      if (lines.at(-1) === '') lines.pop()
      const kept = lines.length > logging.keepLastLines ? lines.slice(-logging.keepLastLines) : lines
      writeFileSync(file, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8')
      line(`Log rotated (kept last ${logging.keepLastLines} lines)`)
    },
  }
}

/** 一个什么都不写的 logger，给测试与「只算不写」的场景用。 */
export function nullLogger(): Logger {
  return { file: '', line: () => {}, raw: () => {}, rotate: () => {} }
}
