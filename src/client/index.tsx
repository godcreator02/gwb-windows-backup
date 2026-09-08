/**
 * 浏览器半的入口：`mountPane`（外壳调）。
 *
 * 契约要求**同步**返回 `{ dispose }`——async / 回函数都算违约。
 *
 * 外壳会先注本件的 `style.css` 再 import 这份模块；样式表整张 scope 在
 * `data-gwb-plugin` 之下，工具类（tailwind）只在自己那棵子树里生效。
 */

import { createRoot } from 'react-dom/client'
import { BackupPane } from './BackupPane'
import type { HostBridge } from './hooks'

/** 外壳调 `mountPane` 时给的那几样。按形状收，不牵 shell 那个包的类型。 */
interface PaneArgs {
  host: { call: (command: string, args?: unknown) => Promise<unknown> }
  shell: {
    openPane: (paneId: string, options?: { duplicate?: boolean }) => void
    bus: {
      emit: (type: string, detail?: unknown) => void
      on: (type: string, listener: (detail: unknown) => void) => () => void
    }
  }
  pane: { id: string; instance: string }
}

const MAIN_PANE = 'main'

const hostOf = (value: { call: (command: string, args?: unknown) => Promise<unknown> }): HostBridge => ({ call: value.call })

/** 挂载窗格：按 `pane.id` 分派，未知 id 出一行错而不是白屏。 */
export function mountPane({ host, pane }: PaneArgs, container: HTMLElement): { dispose(): void } {
  if (pane.id !== MAIN_PANE) {
    const line = document.createElement('p')
    line.textContent = `备份件不认识这扇窗：${pane.id}`
    container.appendChild(line)
    return { dispose: () => line.remove() }
  }
  const root = createRoot(container)
  root.render(<BackupPane host={hostOf(host)} />)
  return { dispose: () => root.unmount() }
}
