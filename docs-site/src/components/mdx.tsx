/**
 * mdx 里能用的组件：fumadocs 的默认表，加上文件树组件、本站的接缝图与备份管线推演，pre 换成格式包那个会画状态点的。
 * 每个组件在 docfirst.config.mjs 的 components 里另有一条规则，写明它在机读版里变成什么文字。
 */
import defaultMdxComponents from 'fumadocs-ui/mdx'
import { File, Files, Folder } from 'fumadocs-ui/components/files'
import type { MDXComponents } from 'mdx/types'
import { DocfirstPre } from '@godcreator/docfirst-workflow/fumadocs/pre'
import { BackupSeams } from './backup-seams'
import { PipelineRound } from './pipeline-round'

type Loose = MDXComponents[string]

export function getMDXComponents(components: MDXComponents = {}): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...components,
    Files: Files as Loose,
    Folder: Folder as Loose,
    File: File as Loose,
    BackupSeams: BackupSeams as Loose,
    PipelineRound: PipelineRound as Loose,
    pre: DocfirstPre as unknown as NonNullable<MDXComponents['pre']>,
  }
}
