/**
 * 这个站怎么挂 docfirst：格式包、哪几区进 check、卡目录在哪、产物摆放、组件名册。
 * 命令行和站读的是同一份。
 *
 * 项目根是站目录，钉的源码在仓根（../src…）——引用里的路径相对项目根。
 * 六区里只有 docs（现状）与 outputs（生成正本）进 check——只有这两区对代码说话；
 * 轨迹、交接、未来、反馈四区的草稿记号与卡天然不进门禁，卡不许钉活代码。
 *
 * outputs：仓根 README.md 与 AGENTS.md 都是生成物，正本是 content/outputs/readme.mdx
 * 与 agents.mdx。改 mdx 源，`pnpm docfirst render --target ai` 重摆，一起提交。
 */
import * as fumadocs from '@godcreator/docfirst-workflow/fumadocs'

export default {
  formats: [fumadocs],
  docs: ['content/docs', 'content/outputs'],
  out: 'out',
  comparator: 'git',
  trajectory: 'content/trajectory',
  outputs: {
    'content/outputs/readme.mdx': ['../README.md'],
    'content/outputs/agents.mdx': ['../AGENTS.md'],
  },
  components: {
    ...fumadocs.defaultRoster,
  },
}
