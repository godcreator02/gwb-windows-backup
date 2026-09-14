/**
 * 名册的人看那一半:docfirst.config.mjs 声明压平表,这里给 React 表。
 * 底下铺 fumadocs 的默认表,再把 pre 换成格式包那个会画状态点的——引用还没写,
 * 但接线先在位:哪天某页开始钉源码,那一页直接就能显示状态。
 */
import defaultMdxComponents from 'fumadocs-ui/mdx'
import { File, Files, Folder } from 'fumadocs-ui/components/files'
import type { MDXComponents } from 'mdx/types'
import { DocfirstPre } from '@godcreator/docfirst-workflow/fumadocs/pre'

type Loose = MDXComponents[string]

export function getMDXComponents(components: MDXComponents = {}): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...components,
    Files: Files as Loose,
    Folder: Folder as Loose,
    File: File as Loose,
    pre: DocfirstPre as unknown as NonNullable<MDXComponents['pre']>,
  }
}
