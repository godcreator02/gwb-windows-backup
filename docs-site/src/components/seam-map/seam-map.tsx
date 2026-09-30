'use client'
/**
 * 接缝图。不带属性画全局图（入口页）；module="windows-backup" 画插件包内部的接缝图（包首页）。
 * 画法在讲解组件包的 SeamDiagram；每张图的内容在 *.data.mjs，坐标在 *.layout.ts；机读版由 seam-map.ai.mjs 读同一份内容生成。
 */
import { SeamDiagram } from '@godcreator/docfirst-explainer'
import { innerGraph } from './inner.data.mjs'
import { innerLayout } from './inner.layout'
import { systemGraph } from './system.data.mjs'
import { systemLayout } from './system.layout'

export function SeamMap({ module: moduleId }: { module?: string }) {
  if (moduleId === undefined) return <SeamDiagram graph={systemGraph} layout={systemLayout} />
  if (moduleId === 'windows-backup') return <SeamDiagram graph={innerGraph} layout={innerLayout} />
  throw new Error(`SeamMap 没有「${moduleId}」的内部图，只有 windows-backup`)
}
