/**
 * 站侧的接线都在这一个文件：六区六个集合，外加全局的 mdxOptions（格式包给——remark 链、
 * meta 白名单）。
 *
 * 六区各一个 defineDocs（自带 docs + meta 双集合，meta.json 的侧栏排序天然支持）：
 *   docs        现状：只有现状、散文、钉码只在这一区；进 check
 *   trajectory  轨迹：卡只增不改；卡的 frontmatter 由 cardSchema 认（label 派生 title），
 *               正文冻结历史、不钉活代码——docfirst 自己的 remarkHost 不跑到这个集合上，
 *               集合级 mdxOptions 用 applyMdxPreset 把默认 preset 加回来、再挂关系边插件；不进 check
 *   spec        交接：在途 spec 与实施方案，做完拆解归梁删页
 *   future      未来：愿景 + not-doing + roadmap，常改
 *   outputs     生成正本：readme、agents，render 摆到仓根；进 check
 *   feedback    反馈：只有 hatch（本仓反复做的操作候选）——跨仓反馈集中投总控台，不落站里
 * 只有 docs 与 outputs 开 processed markdown——命令行按名字找集合只对进 check 的两区有意义
 * （集合名 = 文档目录的最后一截）。集合定义在这里而不是 src/lib/source.ts 里，
 * 是为了让命令行也能按名字找到它：fumadocs 的 Node loader 只认 source.config 里的集合。
 */
import { applyMdxPreset, defineConfig, defineDocs } from 'fumadocs-mdx/config'
import { docfirstMarkdownOptions, docfirstMdxOptions } from '@godcreator02/docfirst-workflow/fumadocs'
import { cardSchema, remarkTrajectoryLinks } from '@godcreator02/docfirst-trajectory/server'

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    postprocess: { includeProcessedMarkdown: docfirstMarkdownOptions() },
  },
})

export const trajectory = defineDocs({
  dir: 'content/trajectory',
  docs: {
    schema: cardSchema,
    mdxOptions: applyMdxPreset({
      remarkPlugins: (v) => [...v, [remarkTrajectoryLinks, { hrefBase: '/trajectory' }]],
    }),
  },
})

export const spec = defineDocs({
  dir: 'content/spec',
})

export const future = defineDocs({
  dir: 'content/future',
})

export const outputs = defineDocs({
  dir: 'content/outputs',
  docs: {
    postprocess: { includeProcessedMarkdown: docfirstMarkdownOptions() },
  },
})

export const feedback = defineDocs({
  dir: 'content/feedback',
})

export default defineConfig({
  mdxOptions: docfirstMdxOptions({ root: process.cwd() }) as never,
})
