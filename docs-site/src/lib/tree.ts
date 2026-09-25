/**
 * 三个区合成一棵侧栏树：每区一个 `root: true` 的根节点（侧栏里的分区），地址仍是三个前缀
 * （/docs、/trajectory、/future，路由各用各的 loader）。
 * base-ui 版的 Root 只有一个 fallback 位置，多棵树切换不稳，所以用根节点分区。
 * 区内的顺序由各区 content/<区>/meta.json 定。**content 子目录的 meta.json 里不许再写
 * `"root": true`**——根切换只认这三个根节点，子目录多标会被当成额外的根。
 */
import { source, sourceFuture, sourceTrajectory } from './source'
import type { Node, Root } from 'fumadocs-core/page-tree'

function zone(name: string, root: Root): Node {
  return {
    type: 'folder',
    name,
    root: true,
    defaultOpen: true,
    children: root.children,
  }
}

export function zoneTree(): Root {
  return {
    name: 'gwb-windows-backup',
    children: [
      zone('现状', source.getPageTree()),
      zone('未来', sourceFuture.getPageTree()),
      zone('轨迹', sourceTrajectory.getPageTree()),
    ],
  }
}
