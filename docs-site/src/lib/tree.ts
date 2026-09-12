/**
 * 六区合一棵侧栏树：每区一个 `root: true` 的根节（侧栏分区），URL 仍是六个基座
 * （/docs、/trajectory、/spec、/future、/outputs、/feedback，路由各走各的 loader）。
 * base-ui 版的 Root 只有单槽 fallback，多树切换不稳，根节分区是正路。
 * 区内的顺序由各区 content/<区>/meta.json 定。**content 子目录的 meta.json 里不许再写
 * `"root": true`**——根切换只认这六个根节，子目录多标会被当成额外的根。
 */
import { source, sourceFeedback, sourceFuture, sourceOutputs, sourceSpec, sourceTrajectory } from './source'
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
      zone('轨迹', sourceTrajectory.getPageTree()),
      zone('交接', sourceSpec.getPageTree()),
      zone('未来', sourceFuture.getPageTree()),
      zone('生成正本', sourceOutputs.getPageTree()),
      zone('反馈', sourceFeedback.getPageTree()),
    ],
  }
}
