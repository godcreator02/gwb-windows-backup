/**
 * 「定时」页的动画组件（TickTimeline）的全部内容：画面与机读版都读这一份。
 * 同一个场景从加载演到第 30 分钟：定时器每分钟一跳，每一跳先看锁、再现读设置、再看 lastRunAt 到期没有。
 * 每一跳的判断由 simulate() 按这三条规则算出来，不手写结果；规则照抄 index.ts 的 tick 与 state.ts 的 backupIsDue。
 */

/**
 * @typedef {'run' | 'busy' | 'wait' | 'refused'} TickOutcome
 * @typedef {{ minute: number, outcome: TickOutcome, logged: boolean, note: string }} Tick
 * @typedef {{ start: number, end: number }} Round
 * @typedef {{ title: string, text: string, duration: number, from: number, to: number }} TickChapter
 */

/** 场景里人做的事：第几分钟、把什么设置改成什么（null = 设置不合法） */
export const settingChanges = [
  { minute: 0, frequency: 30, label: '周期 30 分钟' },
  { minute: 14.5, frequency: 10, label: '改成 10 分钟' },
  { minute: 18.5, frequency: null, label: 'frequency-minutes 被写成 0' },
  { minute: 24.5, frequency: 10, label: '改回 10 分钟' },
];

/** 一轮跑多久（分钟）：场景里第一轮 3 分钟，之后 2 分钟 */
const ROUND_MINUTES = [3.4, 2.3, 2.3];

/** 最后一跳在第几分钟 */
export const LAST_MINUTE = 30;

function frequencyAt(minute) {
  let current = settingChanges[0].frequency;
  for (const change of settingChanges) if (change.minute <= minute) current = change.frequency;
  return current;
}

/* ref file="../plugins/windows-backup/src/index.ts" lines="190-207" hash="f45031e6aa58" blob="251db8f30ac7" */
/* ref file="../plugins/windows-backup/src/state.ts" lines="46-50" hash="d33e5146d12a" blob="ae9258b3f8b2" */
/** 按规则逐跳算一遍：正在跑就不管；设置读不出就拒跑（同一句理由只写一次日志）；距上一轮结束满一个周期就跑。 */
export function simulate() {
  /** @type {Tick[]} */
  const ticks = [];
  /** @type {Round[]} */
  const rounds = [];
  /** @type {number | null} */
  let lastRunAt = null;
  let lastLoggedRefusal = null;
  for (let minute = 1; minute <= LAST_MINUTE; minute += 1) {
    const running = rounds.find((round) => round.start <= minute && minute < round.end);
    if (running !== undefined) {
      ticks.push({ minute, outcome: 'busy', logged: false, note: `锁被第 ${running.start} 分钟起的那一轮占着，什么都不做` });
      continue;
    }
    const frequency = frequencyAt(minute);
    if (frequency === null) {
      const reason = '设置有误：`frequency-minutes` 要是不小于 1 的数，现在是 0';
      const logged = reason !== lastLoggedRefusal;
      lastLoggedRefusal = reason;
      ticks.push({ minute, outcome: 'refused', logged, note: logged ? '设置不合法：拒跑，这句理由写进日志' : '还是同一句理由：拒跑，不再写日志' });
      continue;
    }
    const since = lastRunAt === null ? null : minute - lastRunAt;
    if (since === null || since >= frequency) {
      lastLoggedRefusal = null;
      const length = ROUND_MINUTES[rounds.length] ?? 2;
      rounds.push({ start: minute, end: minute + length });
      lastRunAt = minute + length;
      ticks.push({
        minute,
        outcome: 'run',
        logged: true,
        note: since === null ? '从没跑过：到期，跑一轮' : `距上一轮结束 ${since.toFixed(1)} 分钟 ≥ ${frequency}：到期，跑一轮`,
      });
      continue;
    }
    ticks.push({ minute, outcome: 'wait', logged: false, note: `距上一轮结束 ${since.toFixed(1)} 分钟 < ${frequency}：没到期` });
  }
  return { ticks, rounds };
}

/** @type {TickChapter[]} */
export const chapters = [
  { title: '加载', from: 0, to: 1, duration: 3, text: '插件加载的当场什么都不跑：那时所有插件都在启动。定时器每 60 秒一跳，第一跳在加载一分钟后。' },
  { title: '第一跳就到期', from: 1, to: 2, duration: 3, text: 'state.json 里没有 lastRunAt（从没跑过），第一跳就跑一轮。工作台关了几天再打开也一样：第一跳看到 lastRunAt 早就过期，马上跑。' },
  { title: '有一轮在跑', from: 2, to: 5, duration: 4, text: '一轮跑着的时候，backup.lock 被它占着。每一跳先看锁，锁在就什么都不做，不会叠一轮上去，也不写日志。' },
  { title: '没到期就等', from: 5, to: 14.5, duration: 5, text: 'lastRunAt 记的是上一轮结束的时刻。距它不满 frequency-minutes 就等下一跳；下一轮最早的时刻就是 lastRunAt 加一个周期。' },
  { title: '改了周期，下一跳生效', from: 14.5, to: 18.5, duration: 4, text: '每一跳都现读设置。周期从 30 改成 10，下一跳就按 10 算：距上一轮结束已经超过 10 分钟，马上跑。' },
  { title: '设置不合法', from: 18.5, to: 24.5, duration: 5, text: '有人把 frequency-minutes 写成了 0。每一跳都拒跑，但同一句理由只在第一次写进日志，不会每分钟刷一行。' },
  { title: '改好之后照常', from: 24.5, to: 30, duration: 4, text: '设置改回合法的值，下一跳照常判断：到期就跑。拒跑的记忆清掉，以后再出同样的问题还会再写一次日志。' },
];
