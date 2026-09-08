/**
 * 窗格用的两个小组件与一条取数钩子。
 *
 * 取数走 `host.call('windows-backup.status')`，30 秒一轮——**轮询停不停跟着挂载走**：
 * 格 / 窗被拆掉时 `dispose` 清掉定时器；node 半的定时器（备份与自检本体）跟这边毫无
 * 关系，界面不在备份照跑。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { readStatus, toneOf, type ItemStatus, type StatusView } from './view'

export interface HostBridge {
  call: (command: string, args?: unknown) => Promise<unknown>
}

const POLL_MS = 30_000

/** 取数 + 30 秒轮询。refresh 给「刚点完按钮立刻拉一次」用。 */
export function useStatus(host: HostBridge): { status: StatusView | undefined; refresh: () => void } {
  const [status, setStatus] = useState<StatusView | undefined>(undefined)
  const alive = useRef(true)

  const pull = useCallback(async () => {
    try {
      const reply = await host.call('windows-backup.status')
      if (alive.current) setStatus(readStatus(reply))
    } catch {
      // 桥断了格还在：留上一次的结论，别把界面刷成一片空
    }
  }, [host])

  useEffect(() => {
    alive.current = true
    void pull()
    const timer = setInterval(() => void pull(), POLL_MS)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [pull])

  return { status, refresh: () => void pull() }
}

/** 状态灯。tone 三档；`pulse` 是「正在跑」的呼吸动画——动画归动画，颜色守住上次结论。 */
export function Dot({ tone, pulse }: { tone: 'ok' | 'warn' | 'muted'; pulse: boolean }): ReactElement {
  const color = tone === 'ok' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-muted-foreground'
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${color} ${pulse ? 'gwb-wb-pulse' : ''}`} aria-hidden />
}

/** 五项里每一项的小徽标。unknown / skipped 不是失败，画灰的。 */
export function ItemBadge({ status }: { status: ItemStatus }): ReactElement {
  const tone: 'ok' | 'warn' | 'muted' = status === 'ok' ? 'ok' : status === 'problem' ? 'warn' : 'muted'
  return <Dot tone={tone} pulse={false} />
}

/** 「最近一次备份」那一行：时间 + 成败色 + 没跑过就明说。 */
export function lastRunLine(status: StatusView): { text: string; ok: boolean | null } {
  const backup = status.backup
  if (backup.lastRunAt === null) return { text: '还没备份过', ok: null }
  const tail = backup.lastRunOk === true ? '成功' : backup.lastRunOk === false ? '失败' : '结论未知'
  return { text: `${backup.lastRunAt.replace('T', ' ')} · ${tail}`, ok: backup.lastRunOk }
}

/** 灯的一句话（格的标题行用）。 */
export function headlineOf(status: StatusView): string {
  return toneOf(status).label
}
