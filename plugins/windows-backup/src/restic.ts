import type { OssSection, RetentionSection } from './config.js'
import { DEFAULT_TIMEOUT_MS, runProcess } from './process.js'
import type { RunProcess, RunResult } from './process.js'

export type ResticOptions = {
  /** restic 的 `--password-file` 指向哪；内容不读，只传路径。 */
  passwordFile: string
  /** 子进程完整 env（含 GOMAXPROCS 与 OSS 那几键）。 */
  env?: NodeJS.ProcessEnv | undefined
  input?: string | undefined
  timeoutMs?: number | undefined
  /** 注入点：默认真的启动进程，测试传假的。 */
  run?: RunProcess | undefined
}

/** 跑一条 restic 命令，自动补 `--repo` / `--password-file`。 */
export function runRestic(exe: string, repo: string, args: string[], options: ResticOptions): Promise<RunResult> {
  const run = options.run ?? runProcess
  return run(exe, ['--repo', repo, '--password-file', options.passwordFile, ...args], {
    env: options.env,
    input: options.input,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
}

/** OSS 仓库 URL 的唯一拼法，透传命令与 OSS 推送共用。 */
export function ossRepoUrl(oss: Pick<OssSection, 'endpoint' | 'bucket' | 'repoPath'>): string {
  return `s3:${oss.endpoint}/${oss.bucket}/${oss.repoPath}`
}

/** forget+prune 参数的唯一拼法，本地 / OSS prune 共用。 */
export function pruneArgs(retention: RetentionSection): string[] {
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
