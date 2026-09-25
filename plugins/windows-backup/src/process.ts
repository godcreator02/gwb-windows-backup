/**
 * 子进程这一层——全仓唯一起外部程序的地方。
 *
 * 四条硬规矩，一条都不许绕：
 * - **`spawn` 传 argv 数组、不经 shell**：备份的参数里有用户口述的路径，走 shell 等于把
 *   `&` `|` `^` 交给命令解释器；
 * - **每次都带超时**：定时器每 30 分钟起一次，一个挂死的 restic 会在后台越堆越多，
 *   直到内存吃光；
 * - **`windowsHide: true`**：定时任务跑起来不许闪黑框；
 * - **不抛**：起不来 / 超时都收敛成 `{ code, stdout, stderr }`，让调用方按业务判——备份
 *   链路上一处异常不该把整条链路炸掉，日志里那行 `FAILED with exit code N` 比栈更有用。
 *
 * `RunProcess` 这个函数类型就是全部注入点：测试传一个假的进去，就能不起真进程跑全流程。
 */

import { spawn } from 'node:child_process'

/** 子进程跑完的三件套。`code` 在被超时杀掉 / 起不来时是约定值，见下。 */
export type RunResult = {
  /** 退出码。信号杀掉记 `-1`，起不来记 `-2`——都是非零，调用方按失败处理即可。 */
  code: number
  stdout: string
  stderr: string
  /** 是否被超时杀的，给日志里说人话用。 */
  timedOut: boolean
}

export type RunOptions = {
  /** 子进程的完整 env（不是叠加）。不传就继承父进程的。 */
  env?: NodeJS.ProcessEnv | undefined
  /** 写进 stdin 的内容。 */
  input?: string | undefined
  /** 超时毫秒数，必给——省了就是默认 2 分钟，不是不限。 */
  timeoutMs?: number | undefined
  cwd?: string | undefined
}

/** 注入点：真跑用 `runProcess`，测试传假的。 */
export type RunProcess = (exe: string, args: string[], options?: RunOptions) => Promise<RunResult>

/** 除 restic 备份外一切子进程的默认超时：2 分钟。 */
export const DEFAULT_TIMEOUT_MS = 120_000
/** restic 备份 / prune 的超时：6 小时。首次全量备份几十 GB 是常态。 */
export const BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000
/** toast 通知的超时：10 秒。弹不出来不值得等。 */
export const TOAST_TIMEOUT_MS = 10_000

/** 真的起一个进程。任何异常都收敛进返回值，不抛。 */
export function runProcess(exe: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        shell: false,
        ...(options.env ? { env: options.env } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      })
    } catch (error) {
      resolve({ code: -2, stdout: '', stderr: describe(error), timedOut: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    // 超时定时器不该把进程钉在事件循环里
    timer.unref?.()

    const finish = (result: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish({ code: -2, stdout, stderr: stderr + describe(error), timedOut })
    })
    child.on('close', (code) => {
      finish({ code: code ?? -1, stdout, stderr, timedOut })
    })

    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    } else {
      child.stdin?.end()
    }
  })
}

/** 异常转人话——**只取 message，不带栈**，栈里可能夹着命令行参数。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
