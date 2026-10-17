// round-cases.data.mjs 的类型：数据文件保持 .mjs，因为 docfirst.config.mjs 经 round-cases.ai.mjs 在 Node 里直接 import 它

/** ok 跑了且成功 · fail 跑了但失败 · skip 条件不满足、没跑 · none 前面失败了、没轮到 */
export type StageResult = 'ok' | 'fail' | 'skip' | 'none'

export type RoundCase = {
  id: string
  label: string
  text: string
  stages: Record<string, StageResult>
  notes: Record<string, string>
  writes: string[]
  log: string[]
  toast: { title: string; body: string } | null
}

/** 一轮的六段，按执行顺序 */
export declare const stages: { id: string; name: string; ident: string }[]
export declare const cases: RoundCase[]
