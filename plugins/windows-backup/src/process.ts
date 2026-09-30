import { spawn } from 'node:child_process'

/** 子进程跑完的结果。 */
export type RunResult = {
  /** 退出码。被信号杀掉记 `-1`，启动不了记 `-2`——都是非零，调用方按失败处理即可。 */
  code: number
  stdout: string
  stderr: string
  /** 是否是超时杀掉的。 */
  timedOut: boolean
}

export type RunOptions = {
  /** 子进程的完整 env（不是叠加）。不传就继承父进程的。 */
  env?: NodeJS.ProcessEnv | undefined
  /** 超时毫秒数；不给就是 `DEFAULT_TIMEOUT_MS`，没有「不限」。 */
  timeoutMs?: number | undefined
}

/** 注入点：真跑用 `runProcess`，测试传假的。 */
export type RunProcess = (exe: string, args: string[], options?: RunOptions) => Promise<RunResult>

/** 除 restic 备份 / prune 外一切子进程的默认超时：2 分钟。 */
export const DEFAULT_TIMEOUT_MS = 120_000
/** restic 备份 / prune 的超时：6 小时。 */
export const BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000
/** toast 通知的超时：10 秒。 */
export const TOAST_TIMEOUT_MS = 10_000

/**
 * 启动一个子进程：argv 数组、不经 shell（参数里有用户给的路径），不弹窗口，到时限就杀。
 * 不抛：启动失败、超时都收进返回值，由调用方按业务判成败。
 */
export function runProcess(exe: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        shell: false,
        ...(options.env ? { env: options.env } : {}),
      })
    } catch (error) {
      resolve({ code: -2, stdout: '', stderr: messageWithoutStack(error), timedOut: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const killTimer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    killTimer.unref?.()

    const finish = (result: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
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
      finish({ code: -2, stdout, stderr: stderr + messageWithoutStack(error), timedOut })
    })
    child.on('close', (code) => {
      finish({ code: code ?? -1, stdout, stderr, timedOut })
    })

    child.stdin?.end()
  })
}

/** 只取 message 不带栈：栈里可能夹着命令行参数。 */
function messageWithoutStack(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
