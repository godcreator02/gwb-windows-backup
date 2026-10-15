/**
 * 「健康结论」页的选情况组件（HealthCases）的全部内容：画面与机读版都读这一份。
 * 每种情况是一刻的 state.json、磁盘与最近一次读仓库的结果，画出 status 现算出的三项、状态灯、到期的人工维护。
 * 判据与各句话的写法照抄 health.ts；周期按默认 30 分钟，容忍上限是两个周期 60 分钟。
 */

/**
 * @typedef {'ok' | 'problem' | 'unknown'} ItemStatus
 * @typedef {{ status: ItemStatus, message: string }} Item
 * @typedef {{ id: string, label: string, text: string, facts: string[], refuseReason: string | null, items: { lastRun: Item, disk: Item, snapshots: Item } | null, reminders: string[] }} HealthCase
 */

export const ITEM_LABELS = [
  { key: 'lastRun', label: '上次备份' },
  { key: 'disk', label: '磁盘余量' },
  { key: 'snapshots', label: '快照新鲜度' },
];

/* ref file="../plugins/windows-backup/src/health.ts" lines="133-221" hash="f427be05da76" blob="5fcdbde1354d" */
/** @type {HealthCase[]} */
export const cases = [
  {
    id: 'green',
    label: '一切正常',
    text: '上一轮 12 分钟前成功，今天 prune 过，最新快照也是 12 分钟前，盘还剩 23%。三项都是 ok，状态灯是绿的；USB 离机副本 9 天没做只是到期提醒，不算故障，灯照样是绿的。',
    facts: ['lastRunAt 12 分钟前、lastRunOk true', 'lastPrune 今天', '最近一次读仓库：最新快照 12 分钟前', 'D: 剩 23%', 'lastUsbCopy 9 天前'],
    refuseReason: null,
    items: {
      lastRun: { status: 'ok', message: '上次备份 12 分钟前成功' },
      disk: { status: 'ok', message: 'D: 还剩 23%' },
      snapshots: { status: 'ok', message: '最新快照 12 分钟前' },
    },
    reminders: ['USB 离机副本：已经 9 天没做了'],
  },
  {
    id: 'oss-failed',
    label: '上一轮 OSS 失败',
    text: '上一轮本地成、OSS 失败，state.json 里 lastRunOk 是 false。status 每次现算，这一轮一写完，下一次 status 就是黄灯，不用等哪个定时器。',
    facts: ['lastRunAt 2 分钟前、lastRunOk false', 'lastRunSummary "41.4 GiB | local 2:31 | OSS FAILED"', '最新快照 4 分钟前'],
    refuseReason: null,
    items: {
      lastRun: { status: 'problem', message: '上一轮备份失败了（2026-09-30T22:29:37：41.4 GiB | local 2:31 | OSS FAILED）' },
      disk: { status: 'ok', message: 'D: 还剩 23%' },
      snapshots: { status: 'ok', message: '最新快照 4 分钟前' },
    },
    reminders: [],
  },
  {
    id: 'stalled',
    label: '两个多小时没成功',
    text: '工作台开着，但备份一直没成功（比如 restic.exe 被删了、每轮都失败），或者工作台关了很久刚打开。距上次成功超过两个周期就报问题；刚打开的那种，第一跳就会跑一轮，跑完这一项自己变回 ok。',
    facts: ['lastRunAt 137 分钟前、lastRunOk true', '最新快照 139 分钟前'],
    refuseReason: null,
    items: {
      lastRun: { status: 'problem', message: '已经 137 分钟没成功备份了（超过两个周期 60 分钟）' },
      disk: { status: 'ok', message: 'D: 还剩 23%' },
      snapshots: { status: 'problem', message: '最新快照已经是 139 分钟前的了（超过两个周期 60 分钟）' },
    },
    reminders: [],
  },
  {
    id: 'prune-stuck',
    label: 'prune 两天没成功',
    text: '备份照常成功，但 forget --prune 连着两个日历日没成功（多半是仓库被别的进程锁着）。旧快照删不掉，仓库只涨不减，所以单独报：备份没问题时才看这一条。',
    facts: ['lastRunAt 8 分钟前、lastRunOk true', 'lastPrune 两天前'],
    refuseReason: null,
    items: {
      lastRun: { status: 'problem', message: '上次备份 8 分钟前成功，但 forget+prune 已经 2 天没成功了（上次 2026-09-28T00:01:57）' },
      disk: { status: 'ok', message: 'D: 还剩 23%' },
      snapshots: { status: 'ok', message: '最新快照 8 分钟前' },
    },
    reminders: [],
  },
  {
    id: 'disk-full',
    label: '盘快满了',
    text: '本地仓库那块盘只剩 8%。不到 20% 就报「该清一清了」，不到 10% 报「快满了」，两种都算问题。读的是 local-repo 所在那块盘，不启动子进程。',
    facts: ['D: 剩 8%'],
    refuseReason: null,
    items: {
      lastRun: { status: 'ok', message: '上次备份 20 分钟前成功' },
      disk: { status: 'problem', message: 'D: 只剩 8%，快满了' },
      snapshots: { status: 'ok', message: '最新快照 20 分钟前' },
    },
    reminders: [],
  },
  {
    id: 'just-loaded',
    label: '刚加载，还没读过仓库',
    text: '读仓库要启动 restic，所以不在每次 status 时读：每轮备份结束读一次、check 命令读一次、加载后第一跳没到期时读一次。还没读过时快照这一项是灰的 unknown——判不了不算失败，灯不会因此变黄。',
    facts: ['lastRunAt 6 分钟前、lastRunOk true', '宿主层还没有快照读数'],
    refuseReason: null,
    items: {
      lastRun: { status: 'ok', message: '上次备份 6 分钟前成功' },
      disk: { status: 'ok', message: 'D: 还剩 23%' },
      snapshots: { status: 'unknown', message: '还没读过仓库（加载后第一分钟读一次，之后每轮备份结束读一次）' },
    },
    reminders: [],
  },
  {
    id: 'bad-setting',
    label: '设置不合法',
    text: '有人把 frequency-minutes 写成了 0。连周期都读不出，容忍上限没法算，health 就是 null（判不了，不是没问题）；refuseReason 说出是哪个键、现在是什么值，备份也停着。',
    facts: ['设置 frequency-minutes = 0'],
    refuseReason: '设置有误：`frequency-minutes` 要是不小于 1 的数，现在是 0',
    items: null,
    reminders: [],
  },
];
