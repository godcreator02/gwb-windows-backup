/**
 * 「锁」页的分步组件（LockSteps）的全部内容：画面与机读版都读这一份。
 * 两个参与方 A、B 都要占同一个 backup.lock：每一步画出锁文件此刻的内容、A 与 B 各在做什么、谁拿着锁。
 * 锁文件的字段、陈旧的两条判据、只删自己租约的规矩照抄 lock.ts。
 */

/**
 * @typedef {{ pid: number, lease: string, startedAt: string, beatAt: string } | null} LockFile
 * @typedef {{ title: string, text: string, file: LockFile, changed: string[], a: string, b: string, holder: 'A' | 'B' | null, verdict: string, tone: 'good' | 'bad' | 'warn' | 'info' }} LockStep
 */

/* ref file="../plugins/windows-backup/src/lock.ts" lines="4-10" hash="8c792f6df514" blob="31525a2f0aec" */
/* ref file="../plugins/windows-backup/src/lock.ts" lines="38-52" hash="02027b692c52" blob="31525a2f0aec" */
/* ref file="../plugins/windows-backup/src/lock.ts" lines="62-141" hash="076d30a2d4fb" blob="8c03b6c0f6a4" */
/** @type {LockStep[]} */
export const steps = [
  {
    title: 'A 占锁',
    text: 'A 用 flag: "wx" 创建 backup.lock：文件不存在才建得出来，两个人同时来只有一个成功。先读、再判、再写的三步写法在跨进程时两边都会以为自己占到了。',
    file: { pid: 4120, lease: '4120-mg1x-a7c2', startedAt: '08:00:00', beatAt: '08:00:00' },
    changed: ['pid', 'lease', 'startedAt', 'beatAt'],
    a: '占到了，开始跑一轮',
    b: '—',
    holder: 'A',
    verdict: '新建成功',
    tone: 'good',
  },
  {
    title: 'A 每 5 分钟跳一次心跳',
    text: '持锁的一方每 5 分钟把 beatAt 刷到现在。一轮可以合法地跑好几个小时（第一次整份备份几十 GB），判「还活着」看的是心跳停了多久，不是这一轮跑了多久。',
    file: { pid: 4120, lease: '4120-mg1x-a7c2', startedAt: '08:00:00', beatAt: '09:35:00' },
    changed: ['beatAt'],
    a: '还在跑，renew()',
    b: '—',
    holder: 'A',
    verdict: '心跳',
    tone: 'info',
  },
  {
    title: 'B 来了，锁有主',
    text: 'B（可能是手动的 run 命令，也可能是重新加载后的新一跳）建文件时得到 EEXIST（文件已在），读出锁：pid 4120 还活着、心跳 5 分钟内跳过，不是陈旧锁。B 占不到，回 skipped: "locked"，一个字都不写。',
    file: { pid: 4120, lease: '4120-mg1x-a7c2', startedAt: '08:00:00', beatAt: '09:35:00' },
    changed: [],
    a: '还在跑',
    b: '占不到：另一轮正在跑',
    holder: 'A',
    verdict: '有主，不动',
    tone: 'warn',
  },
  {
    title: 'A 崩了，锁没人删',
    text: '机器断电或进程被杀，锁文件留在盘上。B 下一次来读到 pid 4120：process.kill(pid, 0) 报 ESRCH，进程不在了——陈旧锁。不认这一条，一次崩溃就让备份永远停住，而且没有任何症状。',
    file: { pid: 4120, lease: '4120-mg1x-a7c2', startedAt: '08:00:00', beatAt: '09:35:00' },
    changed: [],
    a: '已经不在了',
    b: '读锁：pid 不在 → 陈旧',
    holder: null,
    verdict: '陈旧',
    tone: 'bad',
  },
  {
    title: 'B 删掉陈旧锁、重新占锁',
    text: '确认无主才删掉旧文件，再用 wx 建自己的。重建时又得到 EEXIST，说明第三个人刚占到，B 回「占不到」。pid 被系统回收给了别的进程时，靠另一条判据接管：心跳停了超过 6 小时。',
    file: { pid: 5236, lease: '5236-mg2b-19fe', startedAt: '10:02:00', beatAt: '10:02:00' },
    changed: ['pid', 'lease', 'startedAt', 'beatAt'],
    a: '已经不在了',
    b: '占到了，开始跑一轮',
    holder: 'B',
    verdict: '接管',
    tone: 'good',
  },
  {
    title: '被接管的一方晚一步来释放',
    text: '同一个进程里，重新加载前的那一轮可能还在跑、晚一步才结束来删锁。释放只删租约对得上的那一份：lease 不一样，一个字都不动，删不掉新主人的锁。同一个 pid 的前后两轮靠租约分得清。',
    file: { pid: 5236, lease: '5236-mg2b-19fe', startedAt: '10:02:00', beatAt: '10:07:00' },
    changed: ['beatAt'],
    a: 'release()：lease 对不上，不动',
    b: '还在跑',
    holder: 'B',
    verdict: '只删自己的',
    tone: 'info',
  },
  {
    title: 'B 跑完释放',
    text: 'lease 对得上，删掉锁文件。删不掉也不抛：这一轮已经跑完，为一个锁文件把结论弄坏不值得，下一个来的人会按陈旧锁接管它。',
    file: null,
    changed: [],
    a: '—',
    b: 'release()：删掉',
    holder: null,
    verdict: '空闲',
    tone: 'good',
  },
];
