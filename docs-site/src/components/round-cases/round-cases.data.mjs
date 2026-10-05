/**
 * 「一轮备份」页的选情况组件（RoundCases）的全部内容：画面与机读版都读这一份。
 * 每种情况是一轮的开局条件，画出六段各自跑没跑、成没成，state.json 记下什么，日志里多了哪几行，通知说什么。
 * 段的顺序、日志行的写法、通知的标题与正文照抄 backup.ts。
 */

/**
 * @typedef {'ok' | 'fail' | 'skip' | 'none'} StageResult  ok 跑了且成功 · fail 跑了但失败 · skip 条件不满足、没跑 · none 前面失败了、没轮到
 * @typedef {{ id: string, label: string, text: string, stages: Record<string, StageResult>, notes: Record<string, string>, writes: string[], log: string[], toast: { title: string, body: string } | null }} RoundCase
 */

/** 一轮的六段，按执行顺序 */
export const stages = [
  { id: 'lock', name: '占锁', ident: 'acquire(backup.lock)' },
  { id: 'local', name: '本地备份', ident: 'restic backup --parent <lastLocalSnapshot>' },
  { id: 'prune', name: '本地 prune', ident: 'unlock · forget --prune（每天第一轮）' },
  { id: 'oss', name: 'OSS 备份', ident: 'restic backup --parent <lastOssSnapshot> → s3:' },
  { id: 'ossPrune', name: 'OSS prune', ident: 'unlock · forget --prune（同上）' },
  { id: 'record', name: '写结果与通知', ident: 'state.json · 日志轮转 · toast' },
];

/* ref file="../plugins/windows-backup/src/backup.ts" lines="91-122" hash="1992b3401c6f" blob="5d9d0b9ab136" */
/* ref file="../plugins/windows-backup/src/backup.ts" lines="221-237" hash="6c4283a4103b" blob="5d9d0b9ab136" */
/** @type {RoundCase[]} */
export const cases = [
  {
    id: 'first-today',
    label: '今天第一轮，OSS 关着',
    text: '本地备份成功就立刻把新快照 ID 记下，下一轮拿它当父快照；今天还没 prune 过，本地仓跑一次 forget --prune，真成功才记时间。OSS 关着，那两段不跑。',
    stages: { lock: 'ok', local: 'ok', prune: 'ok', oss: 'skip', ossPrune: 'skip', record: 'ok' },
    notes: { oss: 'oss-enabled 关着' },
    writes: ['lastLocalSnapshot = "d2d507aa"', 'lastPrune = "2026-09-30T08:00:41"', 'lastRunAt = "2026-09-30T08:00:41"', 'lastRunOk = true', 'lastRunSummary = "41.4 GiB | local 2:40"'],
    log: ['Backup started', 'Backup completed successfully', 'Prune started', 'Prune completed successfully'],
    toast: { title: 'Restic Backup OK', body: '41.4 GiB | local 2:40' },
  },
  {
    id: 'oss-later',
    label: '当天后面的一轮，OSS 开着',
    text: '今天已经 prune 过，本地与 OSS 两个仓都不再 prune。OSS 那次是对白名单再独立备份一次，用的是 OSS 仓自己的父快照 ID——两个仓各有一条快照链，ID 不通用。',
    stages: { lock: 'ok', local: 'ok', prune: 'skip', oss: 'ok', ossPrune: 'skip', record: 'ok' },
    notes: { prune: '今天 prune 过了', ossPrune: '今天 prune 过了' },
    writes: ['lastLocalSnapshot = "e41c09b2"', 'lastOssSnapshot = "7a33f0c1"', 'lastRunAt = "2026-09-30T14:34:45"', 'lastRunOk = true', 'lastRunSummary = "41.4 GiB | local 2:30 | OSS 2:42"'],
    log: ['Backup started', 'Backup completed successfully', 'OSS push started (s3:oss-cn-beijing.aliyuncs.com/…)', 'OSS push completed successfully'],
    toast: { title: 'Restic Backup OK', body: '41.4 GiB | local 2:30 | OSS 2:42' },
  },
  {
    id: 'local-fails',
    label: '本地备份失败',
    text: '本地那次退出码非零，后面几段一段都不跑：本地都没备上，prune 与 OSS 没有意义。这一轮的结论照样写进 state.json——只在成功时记的话，连着失败三天看起来会像「三天前刚备过」。',
    stages: { lock: 'ok', local: 'fail', prune: 'none', oss: 'none', ossPrune: 'none', record: 'ok' },
    notes: { local: '退出码 1：Fatal: unable to open repository' },
    writes: ['lastRunAt = "2026-09-30T15:05:02"', 'lastRunOk = false', 'lastRunSummary = "Local backup exit code non-zero - see …\\restic-backup.log"'],
    log: ['Backup started', 'Backup FAILED with exit code 1'],
    toast: { title: 'Restic Backup FAILED', body: 'Local backup exit code non-zero - see …\\restic-backup.log' },
  },
  {
    id: 'oss-fails',
    label: '本地成、OSS 失败',
    text: '本地那次成功，本地仓照常 prune；OSS 那次失败，OSS 仓不 prune。整轮算失败：「这一轮成没成」要求本地成，并且 OSS 关着或 OSS 也成。',
    stages: { lock: 'ok', local: 'ok', prune: 'ok', oss: 'fail', ossPrune: 'none', record: 'ok' },
    notes: { oss: '退出码 1', ossPrune: 'OSS 那次没成' },
    writes: ['lastLocalSnapshot = "f0a91c3d"', 'lastPrune = "2026-09-30T08:02:10"', 'lastRunAt = "2026-09-30T08:05:33"', 'lastRunOk = false', 'lastRunSummary = "41.4 GiB | local 2:31 | OSS FAILED"'],
    log: ['Backup started', 'Backup completed successfully', 'Prune started', 'Prune completed successfully', 'OSS push started (s3:…)', 'OSS push FAILED with exit code 1'],
    toast: { title: 'Restic Backup partial - OSS push FAILED', body: '41.4 GiB | local 2:31 | OSS FAILED' },
  },
  {
    id: 'no-credentials',
    label: 'OSS 凭据文件不在',
    text: 'OSS 开着，但数据目录里没有 credentials/oss-credentials.txt（或缺了必需的键）。不启动 restic，直接把 OSS 那次记成失败，日志里那一行说清缺的是什么；报错里只有文件路径、行号与键名，没有凭据内容。',
    stages: { lock: 'ok', local: 'ok', prune: 'skip', oss: 'fail', ossPrune: 'none', record: 'ok' },
    notes: { prune: '今天 prune 过了', oss: '没启动 restic' },
    writes: ['lastLocalSnapshot = "d2d507aa"', 'lastRunAt = "2026-09-30T22:29:37"', 'lastRunOk = false', 'lastRunSummary = "14 B | local 0:00 | OSS FAILED"'],
    log: ['Backup started', 'Backup completed successfully', 'OSS push FAILED: 没有 OSS 凭据文件：…\\credentials\\oss-credentials.txt'],
    toast: { title: 'Restic Backup partial - OSS push FAILED', body: '14 B | local 0:00 | OSS FAILED' },
  },
  {
    id: 'parent-gone',
    label: '记着的父快照没了',
    text: 'state.json 里的父快照 ID 在仓库里已经不在（被 prune 掉，或换了仓库）。restic 说「no matching ID found for prefix」时丢开它不带父快照重跑一次，这一次要重读全部文件；只认这两句原话，别的失败照旧一次就收。',
    stages: { lock: 'ok', local: 'ok', prune: 'skip', oss: 'skip', ossPrune: 'skip', record: 'ok' },
    notes: { local: '重跑了一次', prune: '今天 prune 过了', oss: 'oss-enabled 关着' },
    writes: ['lastLocalSnapshot = "abc12345"', 'lastRunAt = "2026-09-08T10:00:00"', 'lastRunOk = true', 'lastRunSummary = "4.9 KiB | local 0:01"'],
    log: ['Backup started', 'parent snapshot oldlocal 不可用，丢开父本重跑一轮（本轮没有基准，会重读全部文件）', 'Backup completed successfully'],
    toast: { title: 'Restic Backup OK', body: '4.9 KiB | local 0:01' },
  },
  {
    id: 'locked',
    label: '另一轮正在跑',
    text: '数据目录的 backup.lock 被一轮还活着的备份占着。这一轮占不到锁，一个字都不写：不写日志、不弹通知、不动 state.json——另一轮正在跑不是故障。',
    stages: { lock: 'fail', local: 'none', prune: 'none', oss: 'none', ossPrune: 'none', record: 'none' },
    notes: { lock: '回 { ok: false, skipped: "locked" }' },
    writes: [],
    log: [],
    toast: null,
  },
];
