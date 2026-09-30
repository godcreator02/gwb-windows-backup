/**
 * 三个区合成一棵侧栏树：每个区一个 root: true 的根节点（侧栏分区），URL 仍按区分前缀，路由各用各的 loader。
 * base-ui 版的 Root 只有一个 fallback 槽，多棵树切换不稳定，所以用根节点分区。
 * 轨迹卡页（src/app/(trajectory-cards)/trajectory/layout.tsx）与 src/app/future/layout.tsx 直接用这一份，三个区的页共用同一个侧栏；
 * 整页星轨盘在另一个路由组里，不用侧栏。
 */
import { source, sourceFuture, sourceTrajectory } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import type { Node, Root } from 'fumadocs-core/page-tree';
import type { ReactNode } from 'react';
import '../docfirst.css';

/**
 * 每个区必须带唯一的 $id：fumadocs 给侧栏的区切换下拉找「这个根节点对应哪个选项」时，除了比对象本身还比 $id，
 * 手工拼的节点都没有 $id 的话 undefined === undefined 成立，三个区都会对上第一个选项，下拉里的名字和链接就乱了
 */
function zone(id: string, name: string, root: Root): Node {
  return { $id: `zone:${id}`, type: 'folder', name, root: true, defaultOpen: true, children: root.children };
}

export default function Layout({ children }: { children: ReactNode }) {
  const tree: Root = {
    name: 'Windows 备份',
    children: [
      zone('docs', '现状', source.getPageTree()),
      zone('trajectory', '轨迹', sourceTrajectory.getPageTree()),
      zone('future', '未来', sourceFuture.getPageTree()),
    ],
  };
  return (
    <DocsLayout tree={tree} {...baseOptions()}>
      {children}
    </DocsLayout>
  );
}
