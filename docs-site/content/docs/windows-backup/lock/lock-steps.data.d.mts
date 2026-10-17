// lock-steps.data.mjs 的类型：数据文件保持 .mjs，因为 docfirst.config.mjs 经 lock-steps.ai.mjs 在 Node 里直接 import 它

export type LockFile = {
  pid: number
  lease: string
  startedAt: string
  beatAt: string
} | null

export type LockStep = {
  title: string
  text: string
  file: LockFile
  changed: string[]
  a: string
  b: string
  holder: 'A' | 'B' | null
  verdict: string
  tone: 'good' | 'bad' | 'warn' | 'info'
}

export declare const steps: LockStep[]
