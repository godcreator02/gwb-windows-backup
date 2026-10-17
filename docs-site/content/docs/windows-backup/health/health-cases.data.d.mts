// health-cases.data.mjs 的类型：数据文件保持 .mjs，因为 docfirst.config.mjs 经 health-cases.ai.mjs 在 Node 里直接 import 它

export type ItemStatus = 'ok' | 'problem' | 'unknown'

export type Item = {
  status: ItemStatus
  message: string
}

export type HealthCase = {
  id: string
  label: string
  text: string
  facts: string[]
  refuseReason: string | null
  items: { lastRun: Item; disk: Item; snapshots: Item } | null
  reminders: string[]
}

export declare const ITEM_LABELS: { key: string; label: string }[]
export declare const cases: HealthCase[]
