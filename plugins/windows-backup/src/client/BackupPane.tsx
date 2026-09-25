/**
 * 备份窗格：五项逐项、问题清单、最近结果、路径与节奏——本件唯一的界面。
 * 数据源是 `windows-backup.status`（收窄见 view.ts），30 秒一轮。
 *
 * 类名一律带 `windowsbackup:` 前缀：围栏来自名字唯一，不靠 DOM 祖先关系。样式入口在
 * `styles.css`，那几行 import 每一条都不能省，注释在那边。
 */

import type { HostBridge } from '@godcreator/gwb-shell/pane'
import { useState, type ReactElement } from 'react'
import { Dot, headlineOf, lastRunLine, useStatus } from './hooks'
import { clockOf, ITEM_LABELS, toneOf } from './view'

/**
 * 「复制复核提示词」按钮放进剪贴板的那段话——贴给任何一个能调命令总线的 agent，
 * 照着走一遍就是一次人工复核。命令名写死在提示词里：窗格是观察面，这些命令就是它
 * 的词汇。
 */
const REVIEW_PROMPT = [
  '帮我复核这台机器的 Windows 备份：',
  '1. 调 windows-backup.check 跑一次五项自检，把 problems 逐条念给我听；',
  '2. 调 windows-backup.status 看上次备份时间、自检结论与定时器节奏；',
  '3. 用 windows-backup.restic（args: ["snapshots","--latest","3"]）核对最近几个快照的时间与路径；',
  '4. 有问题先解释原因并给处理建议，别动手，报给我；',
  '5. 全绿就回我三行：上次备份时间、最新快照 ID、下次计划时间。',
].join('\n')

export function BackupPane({ host }: { host: HostBridge }): ReactElement {
  const { status, refresh } = useStatus(host)
  const [busy, setBusy] = useState<'run' | 'check' | null>(null)
  const [copied, setCopied] = useState(false)

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

  const copyPrompt = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(REVIEW_PROMPT)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板被拒（焦点不在页面）不炸窗格：横幅常在，点了没反应下一轮还能再点
    }
  }

  if (status === undefined) {
    return <p className="windowsbackup:text-muted-foreground windowsbackup:m-0 windowsbackup:text-sm">还拿不到备份状态——命令总线上没有 windows-backup.status？</p>
  }

  const tone = toneOf(status).tone
  const busyNow = status.backup.running || status.checking
  const last = lastRunLine(status)
  const report = status.report

  return (
    <div className="windowsbackup:flex windowsbackup:flex-col windowsbackup:gap-4 windowsbackup:p-4">
      {/* 总览 */}
      <div className="windowsbackup:flex windowsbackup:items-center windowsbackup:gap-2">
        <Dot tone={tone} pulse={busyNow} />
        <span className="windowsbackup:text-foreground windowsbackup:text-base windowsbackup:font-medium">{headlineOf(status)}</span>
        {busyNow && (
          <span className="windowsbackup:text-muted-foreground windowsbackup:text-xs">{status.backup.running ? '备份中' : '检查中'}</span>
        )}
        <span className="windowsbackup:text-muted-foreground windowsbackup:ml-auto windowsbackup:text-xs">v{status.version}</span>
      </div>

      {/* 复核到期横幅：复制提示词贴给 agent，复核完 mark review 销账 */}
      {status.reviewDue && (
        <div className="windowsbackup:flex windowsbackup:items-center windowsbackup:gap-2 windowsbackup:rounded-md windowsbackup:border windowsbackup:border-warning/40 windowsbackup:bg-warning/10 windowsbackup:px-3 windowsbackup:py-2">
          <span className="windowsbackup:min-w-0 windowsbackup:flex-1 windowsbackup:text-xs windowsbackup:text-warning">
            该人工复核备份了（跑自检、看快照）——复核完调 windows-backup.mark {"{"}what: "review"{"}"} 销账
          </span>
          <button
            type="button"
            className="windowsbackup:shrink-0 windowsbackup:rounded-md windowsbackup:border windowsbackup:border-warning/40 windowsbackup:px-2.5 windowsbackup:py-1 windowsbackup:text-xs windowsbackup:text-warning windowsbackup:disabled:opacity-50"
            disabled={copied}
            onClick={() => void copyPrompt()}
          >
            {copied ? '已复制' : '复制复核提示词'}
          </button>
        </div>
      )}

      {/* 上次备份与计划 */}
      <div className="windowsbackup:grid windowsbackup:gap-1 windowsbackup:text-sm">
        <p
          className={`windowsbackup:m-0 ${last.ok === false ? 'windowsbackup:text-destructive' : last.ok === true ? 'windowsbackup:text-success' : 'windowsbackup:text-muted-foreground'}`}
        >
          上次备份：{last.text}
        </p>
        {status.backup.lastRunSummary !== null && status.backup.lastRunSummary !== '' && (
          <p className="windowsbackup:text-muted-foreground windowsbackup:m-0 windowsbackup:text-xs">{status.backup.lastRunSummary}</p>
        )}
        <p className="windowsbackup:text-muted-foreground windowsbackup:m-0 windowsbackup:text-xs">
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
      <div className="windowsbackup:flex windowsbackup:gap-2">
        <button
          type="button"
          className="windowsbackup:bg-primary windowsbackup:text-primary-foreground windowsbackup:rounded-md windowsbackup:px-3 windowsbackup:py-1.5 windowsbackup:text-sm windowsbackup:disabled:opacity-50"
          disabled={busy !== null || status.backup.running}
          onClick={() => void trigger('run')}
        >
          {status.backup.running ? '备份中…' : busy === 'run' ? '发起中…' : '立即备份'}
        </button>
        <button
          type="button"
          className="windowsbackup:border-border windowsbackup:text-foreground windowsbackup:rounded-md windowsbackup:border windowsbackup:px-3 windowsbackup:py-1.5 windowsbackup:text-sm windowsbackup:disabled:opacity-50"
          disabled={busy !== null || status.checking}
          onClick={() => void trigger('check')}
        >
          {status.checking ? '检查中…' : busy === 'check' ? '发起中…' : '立即检查'}
        </button>
      </div>

      {/* 自检本身出错（不是「备份有问题」）单独说 */}
      {status.lastError !== null && (
        <p className="windowsbackup:m-0 windowsbackup:rounded-md windowsbackup:border windowsbackup:border-destructive/40 windowsbackup:px-3 windowsbackup:py-2 windowsbackup:text-xs windowsbackup:text-destructive">自检没跑完：{status.lastError}</p>
      )}

      {/* 五项逐项 */}
      {report === null ? (
        <p className="windowsbackup:text-muted-foreground windowsbackup:m-0 windowsbackup:text-sm">还没跑过自检（挂上 30 秒后第一次）。</p>
      ) : (
        <div className="windowsbackup:flex windowsbackup:flex-col windowsbackup:gap-2">
          <p className="windowsbackup:text-muted-foreground windowsbackup:m-0 windowsbackup:text-xs">五项自检（{report.checkedAt.replace('T', ' ')}）</p>
          <ul className="windowsbackup:m-0 windowsbackup:list-none windowsbackup:space-y-1.5 windowsbackup:pl-0 windowsbackup:text-sm">
            {ITEM_LABELS.map(({ key, label }) => {
              const item = report.items[key]
              return (
                <li key={key} className="windowsbackup:flex windowsbackup:items-start windowsbackup:gap-2">
                  <Dot
                    tone={item.status === 'ok' ? 'ok' : item.status === 'problem' ? 'warn' : 'muted'}
                    pulse={false}
                  />
                  <span className="windowsbackup:text-foreground windowsbackup:w-24 windowsbackup:shrink-0">{label}</span>
                  <span className={item.status === 'problem' ? 'windowsbackup:text-warning' : 'windowsbackup:text-muted-foreground'}>
                    {item.message}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* 数据目录 */}
      <p className="windowsbackup:text-muted-foreground windowsbackup:m-0 windowsbackup:font-mono windowsbackup:text-xs windowsbackup:break-all">
        数据目录：{status.dataDir ?? '—'}（凭据与日志都在这底下，路径细目调 windows-backup.paths）
      </p>
    </div>
  )
}
