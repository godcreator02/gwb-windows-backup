
import type { HostBridge } from '@godcreator/gwb-shell/pane'
import { useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { Dot, ItemBadge, lastRunLine, useStatus } from './hooks'
import { clockOf, ITEM_LABELS, toneOf } from './view'

/** 「复制复核提示词」放进剪贴板的那段话：贴给能调命令的 agent，照着走一遍就是一次人工复核。 */
const REVIEW_PROMPT = [
  '帮我复核这台机器的 Windows 备份：',
  '1. 调 windows-backup.check 读一次仓库、拿全量状态，把 health.problems 与 reminders 逐条念给我听；',
  '2. 看 backup 里的上次备份时间、成败与下次计划；',
  '3. 用 windows-backup.restic（args: ["snapshots","--latest","3"]）核对最近几个快照的时间与路径；',
  '4. 有问题先解释原因并给处理建议，别动手，报给我；',
  '5. 全绿就回我三行：上次备份时间、最新快照 ID、下次计划时间。',
].join('\n')

export function BackupPane({ host }: { host: HostBridge }): ReactElement {
  const { status, refresh } = useStatus(host)
  const [busy, setBusy] = useState<'run' | 'check' | null>(null)
  const [copied, setCopied] = useState(false)

  const runCommandThenRefresh = async (what: 'run' | 'check'): Promise<void> => {
    setBusy(what)
    try {
      await host.call(what === 'run' ? 'windows-backup.run' : 'windows-backup.check')
      refresh()
    } catch {
      // 调命令失败时窗格照常显示，下一轮轮询带回最新状态
    } finally {
      setBusy(null)
    }
  }

  const copyPrompt = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(REVIEW_PROMPT)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板被拒（焦点不在页面）时什么都不做，横幅还在，可以再点
    }
  }

  if (status === undefined) {
    return <p className="windowsbackup:text-muted-foreground windowsbackup:m-0 windowsbackup:text-sm">还拿不到备份状态——命令总线上没有 windows-backup.status？</p>
  }

  const { tone, label } = toneOf(status)
  const lastRun = lastRunLine(status)
  const health = status.health
  const reviewDue = status.reminders.some((reminder) => reminder.what === 'review')

  return (
    <div className="windowsbackup:flex windowsbackup:flex-col windowsbackup:gap-4 windowsbackup:p-4">
      <div className="windowsbackup:flex windowsbackup:items-center windowsbackup:gap-2">
        <Dot tone={tone} pulse={status.backup.running} />
        <span className="windowsbackup:text-foreground windowsbackup:text-base windowsbackup:font-medium">{label}</span>
        {status.backup.running && <span className="windowsbackup:text-muted-foreground windowsbackup:text-xs">备份中</span>}
        <span className="windowsbackup:text-muted-foreground windowsbackup:ml-auto windowsbackup:text-xs">v{status.version}</span>
      </div>

      {status.refuseReason !== null && (
        <p className="windowsbackup:m-0 windowsbackup:rounded-md windowsbackup:border windowsbackup:border-warning/40 windowsbackup:bg-warning/10 windowsbackup:px-3 windowsbackup:py-2 windowsbackup:text-xs windowsbackup:text-warning">
          不跑备份：{status.refuseReason}
        </p>
      )}

      {/* 复核到期横幅：复制提示词贴给 agent，复核完调 mark review 记下日期 */}
      {reviewDue && (
        <div className="windowsbackup:flex windowsbackup:items-center windowsbackup:gap-2 windowsbackup:rounded-md windowsbackup:border windowsbackup:border-warning/40 windowsbackup:bg-warning/10 windowsbackup:px-3 windowsbackup:py-2">
          <span className="windowsbackup:min-w-0 windowsbackup:flex-1 windowsbackup:text-xs windowsbackup:text-warning">
            该人工复核备份了（读仓库、看快照）——复核完调 windows-backup.mark {"{"}what: "review"{"}"} 记下日期
          </span>
          <Button type="button" variant="outline" size="xs" disabled={copied} onClick={() => void copyPrompt()}>
            {copied ? '已复制' : '复制复核提示词'}
          </Button>
        </div>
      )}

      <div className="windowsbackup:grid windowsbackup:gap-1 windowsbackup:text-sm">
        <p
          className={`windowsbackup:m-0 ${lastRun.ok === false ? 'windowsbackup:text-destructive' : lastRun.ok === true ? 'windowsbackup:text-success' : 'windowsbackup:text-muted-foreground'}`}
        >
          上次备份：{lastRun.text}
        </p>
        {status.backup.lastRunSummary !== null && status.backup.lastRunSummary !== '' && (
          <p className="windowsbackup:text-muted-foreground windowsbackup:m-0 windowsbackup:text-xs">{status.backup.lastRunSummary}</p>
        )}
        {status.backup.frequencyMinutes !== null && (
          <p className="windowsbackup:text-muted-foreground windowsbackup:m-0 windowsbackup:text-xs">
            每 {status.backup.frequencyMinutes} 分钟一轮 · 下次 {clockOf(status.backup.nextRunAt)}
          </p>
        )}
      </div>

      <div className="windowsbackup:flex windowsbackup:gap-2">
        <Button type="button" size="sm" disabled={busy !== null || status.backup.running} onClick={() => void runCommandThenRefresh('run')}>
          {status.backup.running ? '备份中…' : busy === 'run' ? '发起中…' : '立即备份'}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void runCommandThenRefresh('check')}>
          {busy === 'check' ? '检查中…' : '立即检查'}
        </Button>
      </div>

      {health !== null && (
        <ul className="windowsbackup:m-0 windowsbackup:list-none windowsbackup:space-y-1.5 windowsbackup:pl-0 windowsbackup:text-sm">
          {ITEM_LABELS.map(({ key, label: itemLabel }) => {
            const item = health.items[key]
            return (
              <li key={key} className="windowsbackup:flex windowsbackup:items-start windowsbackup:gap-2">
                <ItemBadge status={item.status} />
                <span className="windowsbackup:text-foreground windowsbackup:w-24 windowsbackup:shrink-0">{itemLabel}</span>
                <span className={item.status === 'problem' ? 'windowsbackup:text-warning' : 'windowsbackup:text-muted-foreground'}>{item.message}</span>
              </li>
            )
          })}
        </ul>
      )}

      {status.reminders.length > 0 && (
        <div className="windowsbackup:flex windowsbackup:flex-col windowsbackup:gap-1">
          <p className="windowsbackup:text-muted-foreground windowsbackup:m-0 windowsbackup:text-xs">该做的人工维护（做完调 windows-backup.mark 记下）</p>
          <ul className="windowsbackup:text-muted-foreground windowsbackup:m-0 windowsbackup:list-disc windowsbackup:pl-5 windowsbackup:text-xs">
            {status.reminders.map((reminder) => (
              <li key={reminder.what}>{reminder.message}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="windowsbackup:text-muted-foreground windowsbackup:m-0 windowsbackup:font-mono windowsbackup:text-xs windowsbackup:break-all">
        数据目录：{status.dataDir ?? '—'}（凭据与日志都在这底下，路径细目调 windows-backup.paths）
      </p>
    </div>
  )
}
