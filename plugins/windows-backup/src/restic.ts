/**
 * restic 封装：补 `--repo` / `--password-file`、拼 OSS 仓库 URL、拼 retention 参数。
 *
 * `ossRepoUrl` 与 `pruneArgs` 是 SSOT：透传命令、全流程备份、健康检查都从这两个函数取，
 * 改 retention 字段只改一处。这两串参数跟 restic 的实际接受度绑定，另拼一份就可能再遇到
 * 一次已经解决过的参数问题——参数表与旧实现一字不差。
 */

import type { OssSection, RetentionSection } from './config.js'
import { DEFAULT_TIMEOUT_MS, runProcess } from './process.js'
import type { RunProcess, RunResult } from './process.js'

export type ResticOptions = {
  /** restic 的 `--password-file` 指向哪；内容不读，只传路径。 */
  passwordFile: string
  /** 子进程完整 env（含 GOMAXPROCS 与 OSS 两键）。 */
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

/** SSOT：OSS 仓库 URL 拼法，透传命令与 OSS 推送共用。 */
export function ossRepoUrl(oss: Pick<OssSection, 'endpoint' | 'bucket' | 'repoPath'>): string {
  return `s3:${oss.endpoint}/${oss.bucket}/${oss.repoPath}`
}

/**
 * SSOT：forget+prune 的参数清单，本地 / OSS prune 共用。
 *
 * `--group-by host`：restic 默认按 `host,paths` 分组，白名单每改一次就多一组，每组各自留满
 * 保留窗口、永远删不掉（2026-09-25 实测：1052 个快照按默认分组只删 36 个）。
 */
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

/**
 * restic 跑起来时的 env：**父进程 env 打底，只叠 GOMAXPROCS 与 OSS 那几键**。
 *
 * 造的是一份给这一次子进程用的副本——父进程的 env 从头到尾没碰过，本进程后续启动的
 * 任何子进程都不会带着 OSS 密钥。
 */
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
