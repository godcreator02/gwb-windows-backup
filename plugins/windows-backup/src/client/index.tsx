/**
 * 浏览器侧的入口：`mountPane`（外壳调）。
 *
 * 契约要求**同步**返回 `{ dispose }`——async / 回函数都算违约。
 *
 * 外壳会先插入本插件的 `style.css` 再 import 这份模块；样式只作用于本插件靠类名前缀（`windowsbackup:`），
 * 工具类只可能匹配本插件画出来的元素，不依赖 DOM 祖先关系。
 */

import type { PaneArgs, PaneHandle } from '@godcreator/gwb-shell/pane'
import { createRoot } from 'react-dom/client'
import { BackupPane } from './BackupPane'

const MAIN_PANE = 'main'

/** 挂载窗格：按 `pane.id` 分派，未知 id 出一行错而不是白屏。 */
export function mountPane({ host, pane }: PaneArgs, container: HTMLElement): PaneHandle {
  if (pane.id !== MAIN_PANE) {
    const line = document.createElement('p')
    line.textContent = `备份插件不认识这个窗格：${pane.id}`
    container.appendChild(line)
    return { dispose: () => line.remove() }
  }
  const root = createRoot(container)
  root.render(<BackupPane host={host} />)
  return {
    dispose: () => {
      root.unmount()
      container.textContent = ''
    },
  }
}
