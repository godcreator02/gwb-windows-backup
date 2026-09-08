/**
 * 状态格的身体：一盏灯 + 最近一次备份 + 计划行 + 两颗按钮。
 *
 * 这是老仓挂件的等价物，按状态墙的 `mountCell` 契约挂进去；框（边框、标题、包名脚注）
 * 归状态件画，这儿只画框内的身体。数据自己拉（`args.host.call`），30 秒一轮。
 */

import { useState, type ReactElement } from 'react'
import { Dot, headlineOf, lastRunLine, useStatus, type HostBridge } from './hooks'
import { clockOf, toneOf } from './view'

export function BackupCell({ host }: { host: HostBridge }): ReactElement {
  const { status, refresh } = useStatus(host)
  const [runBusy, setRunBusy] = useState(false)
  const [checkBusy, setCheckBusy] = useState(false)

  const trigger = async (command: 'windows-backup.run' | 'windows-backup.check', set: (busy: boolean) => void): Promise<void> => {
    set(true)
    try {
      await host.call(command)
      refresh()
    } catch {
      // 桥上的失败不炸格：下一轮轮询自然带回最新状态
    } finally {
      set(false)
    }
  }

  if (status === undefined) {
    return <p className="text-muted-foreground m-0 text-xs">还拿不到备份状态……</p>
  }

  const tone = toneOf(status).tone
  const busy = status.backup.running || status.checking
  const last = lastRunLine(status)
  const frequency = status.backup.frequencyMinutes

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Dot tone={tone} pulse={busy} />
        <span className="text-foreground text-sm font-medium">{headlineOf(status)}</span>
        {busy && <span className="text-muted-foreground text-xs">{status.backup.running ? '备份中' : '检查中'}</span>}
      </div>

      <p
        className={`m-0 text-xs ${last.ok === false ? 'text-red-500' : last.ok === true ? 'text-emerald-600' : 'text-muted-foreground'}`}
      >
        上次备份：{last.text}
      </p>
      <p className="text-muted-foreground m-0 text-xs">
        {frequency === null ? '定时器没起' : `每 ${frequency} 分钟一轮 · 下次 ${clockOf(status.backup.nextRunAt)}`}
      </p>

      {status.report !== null && status.report.problems.length > 0 && (
        <ul className="m-0 list-none space-y-1 pl-0 text-xs">
          {status.report.problems.slice(0, 3).map((problem) => (
            <li key={problem} className="text-amber-600">
              · {problem}
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 text-xs disabled:opacity-50"
          disabled={runBusy || status.backup.running}
          onClick={() => void trigger('windows-backup.run', setRunBusy)}
        >
          {status.backup.running ? '备份中…' : runBusy ? '发起中…' : '立即备份'}
        </button>
        <button
          type="button"
          className="border-border text-foreground rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
          disabled={checkBusy || status.checking}
          onClick={() => void trigger('windows-backup.check', setCheckBusy)}
        >
          {status.checking ? '检查中…' : checkBusy ? '发起中…' : '立即检查'}
        </button>
      </div>
    </div>
  )
}
