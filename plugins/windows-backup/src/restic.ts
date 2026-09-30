import type { BackupConfig } from './config.js'
import { DEFAULT_TIMEOUT_MS, runProcess } from './process.js'
import type { RunProcess, RunResult } from './process.js'

export type ResticOptions = {
  /** restic 的 `--password-file` 指向哪；内容不读，只传路径。 */
  passwordFile: string
  /** 子进程完整 env（含 GOMAXPROCS 与 OSS 那几键）。 */
  env?: NodeJS.ProcessEnv | undefined
  timeoutMs?: number | undefined
  /** 默认真的启动进程，测试传假的。 */
  run?: RunProcess | undefined
}

/** 跑一条 restic 命令，自动补 `--repo` / `--password-file`。 */
export function runRestic(exe: string, repo: string, args: string[], options: ResticOptions): Promise<RunResult> {
  const run = options.run ?? runProcess
  return run(exe, ['--repo', repo, '--password-file', options.passwordFile, ...args], {
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
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

/** 这一次 restic 子进程的 env：父进程 env 的副本上叠 GOMAXPROCS 与 OSS 那几键，父进程的 env 不改。 */
export function resticEnv(
  gomaxprocs: number,
  ossEnv: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...base, GOMAXPROCS: String(gomaxprocs), ...ossEnv }
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
