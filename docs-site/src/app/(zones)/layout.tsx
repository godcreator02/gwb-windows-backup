import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { zoneTree } from '@/lib/tree'
import type { ReactNode } from 'react'

// 带侧栏的那一组：六区的页共用同一棵树（六个根节），URL 基座各是各的。
export default function Layout({ children }: { children: ReactNode }) {
  return <DocsLayout tree={zoneTree()}>{children}</DocsLayout>
}
