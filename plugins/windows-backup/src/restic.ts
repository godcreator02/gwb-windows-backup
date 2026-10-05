import type { BackupConfig } from './config.js'
import { DEFAULT_TIMEOUT_MS, runProcess } from './process.js'
import type { RunProcess, RunResult } from './process.js'

export type ResticOptions = {
  /** 当前 home 的仓库密码，仅注入子进程环境。 */
  password: string
  /** 子进程完整 env（含 GOMAXPROCS 与 OSS 那几键）。 */
  env?: NodeJS.ProcessEnv | undefined
  timeoutMs?: number | undefined
  /** 默认真的启动进程，测试传假的。 */
  run?: RunProcess | undefined
  /** 仅供插件内部提取结构化事实；先解析再遮挡，避免短密码误伤快照 ID 或日期。不得记录原文。 */
  inspectOutput?: ((stdout: string, stderr: string) => void) | undefined
}

/** 跑一条 restic 命令；回执在离开这一层前遮掉本次注入的凭据。 */
export async function runRestic(exe: string, repo: string, args: string[], options: ResticOptions): Promise<RunResult> {
  if (!options.password || options.password.includes('\0')) throw new Error('restic-password 未配置或无效')
  if (args.some((arg) => /^-[rp]/.test(arg) || /^(?:--repo|--repository-file|--password-file|--password-command|--insecure-no-password)(?:=|$)/.test(arg)))
    throw new Error('restic 参数不能覆盖当前 home 的仓库或凭据')
  const run = options.run ?? runProcess
  const env = { ...options.env, RESTIC_PASSWORD: options.password }
  const secrets = [options.password, ...Object.entries(env).filter(([key]) => /^AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$/.test(key)).map(([, value]) => value ?? '')].filter(Boolean)
  const scrub = (text: string): string => secrets.reduce((out, value) => out.split(value).join('[credential]'), text)
  let result: RunResult
  try {
    result = await run(exe, ['--repo', repo, ...args], {
      env,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    options.inspectOutput?.(result.stdout, result.stderr)
  } catch {
    throw new Error('restic 子进程调用失败；未输出认证信息')
  }
  return { ...result, stdout: scrub(result.stdout), stderr: scrub(result.stderr) }
}

/** OSS 仓库 URL 的唯一拼法，透传命令与 OSS 推送共用。 */
export function ossRepoUrl(config: Pick<BackupConfig, 'ossEndpoint' | 'ossBucket' | 'ossRepoPath'>): string {
  return `s3:${config.ossEndpoint}/${config.ossBucket}/${config.ossRepoPath}`
}

/** forget+prune 参数的唯一拼法，本地 / OSS prune 共用。 */
export function pruneArgs(retention: Pick<BackupConfig, 'keepWithin' | 'keepWithinDaily' | 'keepWeekly' | 'keepMonthly'>): string[] {
  return [
    'forget',
    '--group-by',
    'host',
    '--keep-within',
    retention.keepWithin,
    '--keep-within-daily',
    retention.keepWithinDaily,
    '--keep-weekly',
    String(retention.keepWeekly),
    '--keep-monthly',
    String(retention.keepMonthly),
    '--prune',
  ]
}

/** 保留进程运行所需环境，清除继承的认证来源，再注入本 home 的 OSS 键。 */
export function resticEnv(
  gomaxprocs: number,
  ossEnv: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !/^(?:AWS_|RESTIC_|MINIO_)/i.test(key)))
  const emptyFile = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return { ...env, GOMAXPROCS: String(gomaxprocs), AWS_EC2_METADATA_DISABLED: 'true', AWS_SHARED_CREDENTIALS_FILE: emptyFile, AWS_CONFIG_FILE: emptyFile, ...ossEnv }
}

/** restic 备份成功时 stdout 里那句 `snapshot abc12345 saved`。 */
export function parseSnapshotId(stdout: string): string | null {
  return /snapshot ([a-f0-9]{8}) saved/.exec(stdout)?.[1] ?? null
}

/** restic 备份成功时 stdout 里那句 `processed 123 files, 1.5 GiB`。只写 `B` 的单位（小文件）也要认。 */
export function parseProcessedSize(stdout: string): string | null {
  return /processed \d+ files, ([\d.]+\s+\w*B)/.exec(stdout)?.[1] ?? null
}

/** restic 0.18.1 对不存在的 `--parent`：stderr 一行 `no matching ID found for prefix "<id>"`、退出码 1、stdout 空。 */
const PARENT_UNUSABLE = /no matching ID found for prefix|unable to find snapshot/i

/** 这一次 restic 是不是在说「父快照用不了」。只认上面那两句原话，别的失败照旧按失败收。 */
export function parentUnusable(stdout: string, stderr: string): boolean {
  return PARENT_UNUSABLE.test(`${stdout}\n${stderr}`)
}
