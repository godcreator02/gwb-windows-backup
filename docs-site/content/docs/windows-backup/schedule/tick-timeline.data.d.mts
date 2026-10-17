// tick-timeline.data.mjs 的类型：数据文件保持 .mjs，因为 docfirst.config.mjs 经 tick-timeline.ai.mjs 在 Node 里直接 import 它

export type TickOutcome = 'run' | 'busy' | 'wait' | 'refused'

export type Tick = {
  minute: number
  outcome: TickOutcome
  logged: boolean
  note: string
}

export type Round = {
  start: number
  end: number
}

export type TickChapter = {
  title: string
  text: string
  duration: number
  from: number
  to: number
}

/** 场景里人做的事：第几分钟、把什么设置改成什么（null = 设置不合法） */
export declare const settingChanges: { minute: number; frequency: number | null; label: string }[]
/** 最后一跳在第几分钟 */
export declare const LAST_MINUTE: 30
export declare const chapters: TickChapter[]
export declare function simulate(): { ticks: Tick[]; rounds: Round[] }
