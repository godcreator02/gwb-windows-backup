/**
 * 备份窗格：状态格那份的完整版——五项逐项、问题清单、最近结果、路径与节奏。
 *
 * 与状态格同一条数据源（`windows-backup.status` → 见 view.ts 的收窄），
 * 多出来的只是版面：这里放得下五项的每一项与自检出错那句话。
 */

import { useState, type ReactElement } from 'react'
import { Dot, headlineOf, lastRunLine, useStatus, type HostBridge } from './hooks'
import { clockOf, ITEM_LABELS, toneOf } from './view'

export function BackupPane({ host }: { host: HostBridge }): ReactElement {
  const { status, refresh } = useStatus(host)
  const [busy, setBusy] = useState<'run' | 'check' | null>(null)

  const trigger = async (what: 'run' | 'check'): Promise<void> => {
    setBusy(what)
    try {
      await host.call(what === 'run' ? 'windows-backup.run' : 'windows-backup.check')
      refresh()
    } catch {
      // 桥上的失败不炸窗格：下一轮轮询自然带回最新状态
    } finally {
      setBusy(null)
    }
  }

  if (status === undefined) {
    return <p className="text-muted-foreground m-0 text-sm">还拿不到备份状态——命令总线上没有 windows-backup.status？</p>
  }

  const tone = toneOf(status).tone
  const busyNow = status.backup.running || status.checking
  const last = lastRunLine(status)
  const report = status.report

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* 总览 */}
      <div className="flex items-center gap-2">
        <Dot tone={tone} pulse={busyNow} />
        <span className="text-foreground text-base font-medium">{headlineOf(status)}</span>
        {busyNow && (
          <span className="text-muted-foreground text-xs">{status.backup.running ? '备份中' : '检查中'}</span>
        )}
        <span className="text-muted-foreground ml-auto text-xs">v{status.version}</span>
      </div>

      {/* 上次备份与计划 */}
      <div className="grid gap-1 text-sm">
        <p
          className={`m-0 ${last.ok === false ? 'text-red-500' : last.ok === true ? 'text-emerald-600' : 'text-muted-foreground'}`}
        >
          上次备份：{last.text}
        </p>
        {status.backup.lastRunSummary !== null && status.backup.lastRunSummary !== '' && (
          <p className="text-muted-foreground m-0 text-xs">{status.backup.lastRunSummary}</p>
        )}
        <p className="text-muted-foreground m-0 text-xs">
          {status.backup.frequencyMinutes === null
            ? '定时器没起'
            : `每 ${status.backup.frequencyMinutes} 分钟一轮 · 下次 ${clockOf(status.backup.nextRunAt)}`}
          {' · '}
          {status.intervalHours === null
            ? '自检没排'
            : `每 ${status.intervalHours}h 自检 · 上次 ${clockOf(status.lastCheckedAt)} · 下次 ${clockOf(status.nextCheckAt)}`}
        </p>
      </div>

      {/* 两颗按钮 */}
      <div className="flex gap-2">
        <button
          type="button"
          className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={busy !== null || status.backup.running}
          onClick={() => void trigger('run')}
        >
          {status.backup.running ? '备份中…' : busy === 'run' ? '发起中…' : '立即备份'}
        </button>
        <button
          type="button"
          className="border-border text-foreground rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={busy !== null || status.checking}
          onClick={() => void trigger('check')}
        >
          {status.checking ? '检查中…' : busy === 'check' ? '发起中…' : '立即检查'}
        </button>
      </div>

      {/* 自检本身出错（不是「备份有问题」）单独说 */}
      {status.lastError !== null && (
        <p className="m-0 rounded-md border border-red-500/40 px-3 py-2 text-xs text-red-500">自检没跑完：{status.lastError}</p>
      )}

      {/* 五项逐项 */}
      {report === null ? (
        <p className="text-muted-foreground m-0 text-sm">还没跑过自检（挂上 30 秒后第一次）。</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground m-0 text-xs">五项自检（{report.checkedAt.replace('T', ' ')}）</p>
          <ul className="m-0 list-none space-y-1.5 pl-0 text-sm">
            {ITEM_LABELS.map(({ key, label }) => {
              const item = report.items[key]
              return (
                <li key={key} className="flex items-start gap-2">
                  <Dot
                    tone={item.status === 'ok' ? 'ok' : item.status === 'problem' ? 'warn' : 'muted'}
                    pulse={false}
                  />
                  <span className="text-foreground w-24 shrink-0">{label}</span>
                  <span className={item.status === 'problem' ? 'text-amber-600' : 'text-muted-foreground'}>
                    {item.message}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* 数据目录 */}
      <p className="text-muted-foreground m-0 font-mono text-xs break-all">
        数据目录：{status.dataDir ?? '—'}（凭据与日志都在这底下，路径细目调 windows-backup.paths）
      </p>
    </div>
  )
}
