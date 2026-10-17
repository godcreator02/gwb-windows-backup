/**
 * docfirst 配置：命令行 docfirst（check / confirm / render / trajectory）读它，项目根是站点目录。被钉的源码在仓根的
 * `plugins/windows-backup/` 下，引用写 `../plugins/windows-backup/…`，按项目根拼路径，页面在哪个子目录都一样。
 *
 * content：内容根。下面的 future/ 是未来区、不进核对，其余目录都是现状区、都进 check；本站的现状区是 `content/docs/`，
 * 插件包的页在它下面的 `windows-backup/`。讲解组件放在各页的同名文件夹与 `content/docs/_shared/` 里，源码也进 check。
 * outputs：仓根 README.md / AGENTS.md / CLAUDE.md 由 `content/docs/outputs/` 下的三份 mdx 生成。
 * 改了正本运行 `pnpm doc:render`，两份放进同一个提交，`pnpm doc` 检查生成物跟正本是否一致。
 * fumadocsRoster 与 components：组件名册。fumadocsRoster 放进 fumadocs 自带的 Note、Files、Folder、File 的机读规则，
 * components 再加站里的组件：讲解组件的规则各在组件旁边的 .ai.mjs，读组件自己的讲解数据生成文字。
 * trajectory：轨迹卡放在站点根下的 trajectory/，站点的卡集合（app/features/trajectory/mdx.ts）读同一个目录。
 * 术语表不在这里：它是站点根的 glossary.json，由站点的 source.config.ts 交给术语标注插件。
 */
import * as glossaryList from './content/docs/glossary/glossary-list.ai.mjs'
import * as seamMap from './content/docs/_shared/seam-map/seam-map.ai.mjs'
import * as healthCases from './content/docs/windows-backup/health/health-cases.ai.mjs'
import * as lockSteps from './content/docs/windows-backup/lock/lock-steps.ai.mjs'
import * as roundCases from './content/docs/windows-backup/round/round-cases.ai.mjs'
import * as tickTimeline from './content/docs/windows-backup/schedule/tick-timeline.ai.mjs'

export default {
  content: 'content',
  outputs: {
    'content/docs/outputs/readme.mdx': ['../README.md'],
    'content/docs/outputs/agents.mdx': ['../AGENTS.md'],
    'content/docs/outputs/claude.mdx': ['../CLAUDE.md'],
  },
  fumadocsRoster: true,
  components: {
    // 手写的术语标注：机读版里只留术语原词
    Term: 'children',
    SeamMap: seamMap.SeamMap,
    RoundCases: roundCases.RoundCases,
    TickTimeline: tickTimeline.TickTimeline,
    LockSteps: lockSteps.LockSteps,
    HealthCases: healthCases.HealthCases,
    GlossaryList: glossaryList.GlossaryList,
  },
  trajectory: 'trajectory',
}
