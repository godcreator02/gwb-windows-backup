/** 日志契约行的唯一出处：写日志的 `backup.ts` 与读日志的 `health.ts` 都从这里取，别处不写字面量。 */

/** 全流程起手。 */
export const BACKUP_STARTED = 'Backup started'
/** 本地备份成功。 */
export const BACKUP_OK = 'Backup completed successfully'
/** OSS 推送成功。 */
export const OSS_PUSH_OK = 'OSS push completed successfully'

/** 本地 prune 那一组的标签。 */
export const PRUNE_LABEL = 'Prune'
/** OSS prune 那一组的标签。 */
export const OSS_PRUNE_LABEL = 'OSS prune'

/** `<label> started`。 */
export function startedLine(label: string): string {
  return `${label} started`
}

/** `<label> completed successfully`。 */
export function completedLine(label: string): string {
  return `${label} completed successfully`
}

/** `<label> FAILED with exit code N`。 */
export function failedLine(label: string, code: number): string {
  return `${label} FAILED with exit code ${code}`
}

/** `OSS push started (<repo>)`——括号里带仓库 URL，事后能看出推的是哪个 bucket。 */
export function ossPushStartedLine(repo: string): string {
  return `OSS push started (${repo})`
}

/** `Notification failed: <原因>`——toast 弹不出来只记这一行，不影响备份结论。 */
export function notificationFailedLine(reason: string): string {
  return `Notification failed: ${reason}`
}

/** 父快照用不了、要丢开它重跑时补的说明行。措辞不许出现 `FAILED` / `Fatal` / `error` / `exit code`：健康检查在日志尾搜这四个词。 */
export function parentDroppedLine(id: string): string {
  return `parent snapshot ${id} 不可用，丢开父本重跑一轮（本轮没有基准，会重读全部文件）`
}

/** restic 0.18.1 对不存在的 `--parent`：stderr 一行 `no matching ID found for prefix "<id>"`、退出码 1、stdout 空。 */
const PARENT_UNUSABLE = /no matching ID found for prefix|unable to find snapshot/i

/** 这一次 restic 是不是在说「父快照用不了」。只认上面那两句原话，别的失败照旧按失败收。 */
export function parentUnusable(stdout: string, stderr: string): boolean {
  return PARENT_UNUSABLE.test(`${stdout}\n${stderr}`)
}

/** `error` 之外那三个失败关键词：出现即算数，大小写不敏感。 */
const HARD_FAILURE = /FAILED|Fatal|exit code/i
/** restic 每轮正常输出里的计数行（`0 errors` / `0 error`），不是失败。 */
const ZERO_ERROR_COUNT = /\b0 errors?\b/gi
/** 整词匹配的 `error` / `errors`。 */
const ERROR_WORD = /\berrors?\b/i

/** 这一行算不算失败迹象：三个硬关键词出现即算；`error` 要整词匹配，并先扣掉 `0 errors` 计数行。 */
export function matchesFailure(line: string): boolean {
  if (HARD_FAILURE.test(line)) return true
  return ERROR_WORD.test(line.replace(ZERO_ERROR_COUNT, ''))
}
