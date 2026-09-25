import type { HostBridge } from '@godcreator/gwb-shell/pane'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { readStatus, toneOf, type ItemStatus, type StatusView } from './view'

const POLL_MS = 30_000

/** 取 `windows-backup.status`，30 秒一轮，卸载时停。`refresh` 给「刚点完按钮立刻拉一次」用。 */
export function useStatus(host: HostBridge): { status: StatusView | undefined; refresh: () => void } {
  const [status, setStatus] = useState<StatusView | undefined>(undefined)
  const mounted = useRef(true)

  const pullStatus = useCallback(async () => {
    try {
      const reply = await host.call('windows-backup.status')
      if (mounted.current) setStatus(readStatus(reply))
    } catch {
      // 调命令失败时留着上一次的结论，下一轮轮询再取
    }
  }, [host])

  useEffect(() => {
    mounted.current = true
    void pullStatus()
    const pollTimer = setInterval(() => void pullStatus(), POLL_MS)
    return () => {
      mounted.current = false
      clearInterval(pollTimer)
    }
  }, [pullStatus])

  return { status, refresh: () => void pullStatus() }
}

/** 状态灯。`pulse` 表示「正在跑」，只加呼吸动画，颜色保持上次结论。 */
export function Dot({ tone, pulse }: { tone: 'ok' | 'warn' | 'muted'; pulse: boolean }): ReactElement {
  const color = tone === 'ok' ? 'windowsbackup:bg-success' : tone === 'warn' ? 'windowsbackup:bg-warning' : 'windowsbackup:bg-muted-foreground'
  return <span className={`windowsbackup:inline-block windowsbackup:h-2.5 windowsbackup:w-2.5 windowsbackup:shrink-0 windowsbackup:rounded-full ${color} ${pulse ? 'windowsbackup:animate-breathe' : ''}`} aria-hidden />
}

/** 五项里每一项的小灯。`unknown` / `skipped` 不是失败，画灰的。 */
export function ItemBadge({ status }: { status: ItemStatus }): ReactElement {
  const tone: 'ok' | 'warn' | 'muted' = status === 'ok' ? 'ok' : status === 'problem' ? 'warn' : 'muted'
  return <Dot tone={tone} pulse={false} />
}

/** 「上次备份」那一行：时间 + 成败；没跑过就明说。 */
export function lastRunLine(status: StatusView): { text: string; ok: boolean | null } {
  const backup = status.backup
  if (backup.lastRunAt === null) return { text: '还没备份过', ok: null }
  const verdict = backup.lastRunOk === true ? '成功' : backup.lastRunOk === false ? '失败' : '结论未知'
  return { text: `${backup.lastRunAt.replace('T', ' ')} · ${verdict}`, ok: backup.lastRunOk }
}

/** 状态灯旁边那一句话。 */
export function headlineOf(status: StatusView): string {
  return toneOf(status).label
}
