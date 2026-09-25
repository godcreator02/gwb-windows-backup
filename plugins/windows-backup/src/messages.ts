/**
 * 日志契约行的唯一出处。
 *
 * 写日志的一头（`backup.ts`）和读日志的一头（`health.ts`、将来手册的验收步骤）必须认同一
 * 串字。让两头各自写字面量，迟早有一天改了一头忘了另一头，而症状是「健康检查报一切正常，
 * 其实备份三个月前就断了」。所以两头都从这里取。
 *
 * 英文不是随手写的：这几串字是从老仓逐字搬来的**既有契约**——用户的存量日志里躺着的
 * 就是它们，翻成中文等于把存量日志作废。
 */

/** 全流程起手。 */
export const BACKUP_STARTED = 'Backup started'
/** 本地备份成功——验收步骤 + 健康检查日志尾判定的锚。 */
export const BACKUP_OK = 'Backup completed successfully'
/** OSS 推送成功——同上，OSS 开着时日志末两行要同时有它和上面那条。 */
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

/** `<label> FAILED with exit code N`——失败诊断与健康检查搜的就是 `FAILED`。 */
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

/** 健康检查在日志尾里搜的失败关键词，照老仓 cc 版 `docs/restic/commands.md` 那张表。 */
export const LOG_FAILURE_KEYWORDS = ['FAILED', 'Fatal', 'error', 'exit code'] as const

/**
 * 父快照用不了时补的那句说明。
 *
 * **措辞刻意避开 `FAILED` / `Fatal` / `error` / `exit code` 四个词**：这不是失败，是自我
 * 修复的第一步——紧接着还要丢开父本重跑一次，先落一行失败关键词，日志尾判定会把一次正常
 * 的重试记成故障（那四个词正是健康检查在搜的）。
 */
export function parentDroppedLine(id: string): string {
  return `parent snapshot ${id} 不可用，丢开父本重跑一轮（本轮没有基准，会重读全部文件）`
}

/**
 * restic 说「你给我的这份父快照找不到」的样子。
 *
 * 实测（0.18.1，`backup --parent <不存在的 ID>`）：**stderr 一行、退出码 1、stdout 空**：
 *
 * ```
 * no matching ID found for prefix "00000000"
 * ```
 *
 * 为什么会走到这一步：ID 记在 `state.json` 里，正常情况下最近一份快照永远在保留窗口内；
 * 但仓库被重建、或者 state 从更早的备份里恢复回来时，那个 ID 在仓库里已经没了。
 */
const PARENT_UNUSABLE = /no matching ID found for prefix|unable to find snapshot/i

/** 这一次 restic 是不是在说「父快照用不了」。只认上面那两句原话，别的失败照旧按失败收。 */
export function parentUnusable(stdout: string, stderr: string): boolean {
  return PARENT_UNUSABLE.test(`${stdout}\n${stderr}`)
}

/** `error` 之外那三个词：出现即算数，大小写不敏感。 */
const HARD_FAILURE = /FAILED|Fatal|exit code/i
/** restic 每轮正常输出里的计数行（`0 errors` / `0 error`）——这不是错，是「一个错都没有」。 */
const ZERO_ERROR_COUNT = /\b0 errors?\b/gi
/** 整词匹配的 `error` / `errors`。 */
const ERROR_WORD = /\berrors?\b/i

/**
 * 这一行算不算失败迹象。
 *
 * `error` 这个词单拎出来收窄了两道，都是为了不误报——**误报比漏报更伤**，天天喊有问题，
 * 人就不看告警了，真出事那次也一起被忽略：
 * - **整词匹配**：不然 `terror` / `errored-out.txt` 这种也算数；
 * - **先扣掉 `0 errors` 这种计数行**：restic 每轮正常输出里就带着它，不扣的话每一轮都命中。
 *
 * 另外三个词（`FAILED` / `Fatal` / `exit code`）照旧，出现即算数。
 */
export function matchesFailure(line: string): boolean {
  if (HARD_FAILURE.test(line)) return true
  return ERROR_WORD.test(line.replace(ZERO_ERROR_COUNT, ''))
}
