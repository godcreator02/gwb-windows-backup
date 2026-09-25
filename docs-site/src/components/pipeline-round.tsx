'use client'

import { useState, type ReactElement } from 'react'

/**
 * 备份管线页的推演：拨几个条件，看一轮里哪几段跑、哪几段跳过、`state.json` 记下什么、通知说什么。
 * 判据照 `src/backup.ts` 的 `runLocked`：本地失败后面全不跑；OSS prune 看「本轮该 prune」与「OSS 备份成功」，不看本地 prune 的成败。
 */

interface Conditions {
  localOk: boolean
  prunedAlreadyToday: boolean
  localPruneOk: boolean
  ossEnabled: boolean
  ossOk: boolean
}

type StepVerdict = { ran: true; ok: boolean } | { ran: false; why: string }

interface Step {
  name: string
  command: string
  verdict: StepVerdict
}

function stepsOf(c: Conditions): Step[] {
  const pruneDue = !c.prunedAlreadyToday
  const localPrune: StepVerdict = !c.localOk
    ? { ran: false, why: '本地备份失败' }
    : !pruneDue
      ? { ran: false, why: '今天已经 prune 过' }
      : { ran: true, ok: c.localPruneOk }
  const ossBackup: StepVerdict = !c.localOk
    ? { ran: false, why: '本地备份失败' }
    : !c.ossEnabled
      ? { ran: false, why: 'OSS 关着' }
      : { ran: true, ok: c.ossOk }
  const ossPrune: StepVerdict = !c.localOk
    ? { ran: false, why: '本地备份失败' }
    : !c.ossEnabled
      ? { ran: false, why: 'OSS 关着' }
      : !pruneDue
        ? { ran: false, why: '今天已经 prune 过' }
        : !c.ossOk
          ? { ran: false, why: 'OSS 备份失败' }
          : { ran: true, ok: true }
  return [
    { name: '本地备份', command: 'restic backup --parent <lastLocalSnapshot>', verdict: { ran: true, ok: c.localOk } },
    { name: '本地 prune', command: 'restic unlock → forget --group-by host --prune', verdict: localPrune },
    { name: 'OSS 备份', command: 'restic backup（s3: 仓库）--parent <lastOssSnapshot>', verdict: ossBackup },
    { name: 'OSS prune', command: 'restic unlock → forget --group-by host --prune（OSS 仓库）', verdict: ossPrune },
    { name: '日志轮转', command: '超 10 MB 只留最后 1000 行', verdict: { ran: true, ok: true } },
  ]
}

function stateWritesOf(c: Conditions, steps: Step[]): string[] {
  const overallOk = c.localOk && (!c.ossEnabled || c.ossOk)
  const writes: string[] = []
  if (c.localOk) writes.push('lastLocalSnapshot ← 本轮本地快照 ID')
  const localPrune = steps[1]!.verdict
  if (localPrune.ran && localPrune.ok) writes.push('lastPrune ← 现在')
  const ossBackup = steps[2]!.verdict
  if (ossBackup.ran && ossBackup.ok) writes.push('lastOssSnapshot ← 本轮 OSS 快照 ID')
  writes.push(`lastRunAt ← 现在，lastRunOk ← ${String(overallOk)}，lastRunSummary ← 通知正文`)
  return writes
}

function notificationOf(c: Conditions): string {
  if (!c.localOk) return 'Restic Backup FAILED（正文带日志路径）'
  if (c.ossEnabled && !c.ossOk) return 'Restic Backup partial - OSS push FAILED'
  return 'Restic Backup OK'
}

function Toggle({ label, value, onText, offText, disabled, onChange }: { label: string; value: boolean; onText: string; offText: string; disabled?: boolean; onChange: (next: boolean) => void }): ReactElement {
  return (
    <div className={`flex items-center justify-between gap-3 ${disabled ? 'opacity-40' : ''}`}>
      <span className="text-sm">{label}</span>
      <div className="flex overflow-hidden rounded-md border border-fd-border text-xs">
        {[true, false].map((option) => (
          <button
            key={String(option)}
            type="button"
            disabled={disabled}
            aria-pressed={value === option}
            onClick={() => onChange(option)}
            className={`px-2.5 py-1 ${value === option ? 'bg-fd-primary text-fd-primary-foreground' : 'bg-fd-background text-fd-muted-foreground'}`}
          >
            {option ? onText : offText}
          </button>
        ))}
      </div>
    </div>
  )
}

function VerdictChip({ verdict }: { verdict: StepVerdict }): ReactElement {
  if (!verdict.ran) return <span className="pr-chip pr-chip-skip">跳过：{verdict.why}</span>
  return verdict.ok ? <span className="pr-chip pr-chip-ok">跑了 · 成功</span> : <span className="pr-chip pr-chip-fail">跑了 · 失败</span>
}

export function PipelineRound(): ReactElement {
  const [conditions, setConditions] = useState<Conditions>({ localOk: true, prunedAlreadyToday: false, localPruneOk: true, ossEnabled: true, ossOk: true })
  const set = (patch: Partial<Conditions>): void => setConditions((current) => ({ ...current, ...patch }))
  const steps = stepsOf(conditions)
  const writes = stateWritesOf(conditions, steps)

  return (
    <div className="not-prose pr-round my-6 grid gap-4 rounded-xl border border-fd-border bg-fd-card p-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <style>{STYLES}</style>
      <div className="grid content-start gap-2.5">
        <Toggle label="本地备份" value={conditions.localOk} onText="成功" offText="失败" onChange={(localOk) => set({ localOk })} />
        <Toggle label="今天 prune 过" value={conditions.prunedAlreadyToday} onText="是" offText="否" disabled={!conditions.localOk} onChange={(prunedAlreadyToday) => set({ prunedAlreadyToday })} />
        <Toggle label="本地 prune" value={conditions.localPruneOk} onText="成功" offText="失败" disabled={!conditions.localOk || conditions.prunedAlreadyToday} onChange={(localPruneOk) => set({ localPruneOk })} />
        <Toggle label="OSS" value={conditions.ossEnabled} onText="开" offText="关" onChange={(ossEnabled) => set({ ossEnabled })} />
        <Toggle label="OSS 备份" value={conditions.ossOk} onText="成功" offText="失败" disabled={!conditions.localOk || !conditions.ossEnabled} onChange={(ossOk) => set({ ossOk })} />
      </div>
      <div className="grid content-start gap-3">
        <ol className="grid gap-1.5">
          {steps.map((step) => (
            <li key={step.name} className={`pr-step ${step.verdict.ran ? '' : 'pr-step-skipped'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{step.name}</span>
                <VerdictChip verdict={step.verdict} />
              </div>
              <code className="text-xs text-fd-muted-foreground">{step.command}</code>
            </li>
          ))}
        </ol>
        <div className="text-sm">
          <p className="mb-1 font-medium">写进 state.json</p>
          <ul className="grid gap-0.5 text-xs text-fd-muted-foreground">
            {writes.map((line) => (
              <li key={line}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm">
          <span className="font-medium">通知：</span>
          <code className="text-xs">{notificationOf(conditions)}</code>
        </p>
      </div>
    </div>
  )
}

const STYLES = `
.pr-round {
  --pr-ok: #15803d;
  --pr-fail: #b91c1c;
}
.dark .pr-round {
  --pr-ok: #4ade80;
  --pr-fail: #f87171;
}
.pr-step { border: 1px solid var(--color-fd-border); border-radius: 0.5rem; padding: 0.4rem 0.6rem; background: var(--color-fd-background); transition: opacity 160ms ease; }
.pr-step-skipped { opacity: 0.55; border-style: dashed; }
.pr-chip { font-size: 0.72rem; border-radius: 999px; padding: 0.05rem 0.5rem; border: 1px solid currentColor; }
.pr-chip-ok { color: var(--pr-ok); background: color-mix(in srgb, var(--pr-ok) 12%, transparent); }
.pr-chip-fail { color: var(--pr-fail); background: color-mix(in srgb, var(--pr-fail) 12%, transparent); }
.pr-chip-skip { color: var(--color-fd-muted-foreground); }
@media (prefers-reduced-motion: reduce) { .pr-step { transition: none; } }
`
