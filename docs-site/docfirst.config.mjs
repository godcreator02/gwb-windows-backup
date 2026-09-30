/**
 * docfirst 配置：命令行和站读的是同一份。项目根是这个站目录，被钉的源码在仓根的 `plugins/windows-backup/` 下，
 * 引用写 `../plugins/windows-backup/…`，按项目根拼路径，页面在哪个子目录都一样。
 *
 * content 是各区的上一级目录。它下面只有两个名字是固定的：`trajectory/` 是轨迹卡目录，
 * `future/` 是未来区（路线、别的仓投来的反馈 `future/inbox/`）。其余目录都是现状区，全部进 check；
 * 本站的现状区是 `content/docs/`，插件包的页在它下面的 `windows-backup/`。`src/components/` 下讲解组件的源码也进 check。
 *
 * outputs 把正本映射到生成物：仓根 README.md / AGENTS.md / CLAUDE.md 由 `content/docs/outputs/` 下的
 * 三份 mdx 生成。改正本后运行 `pnpm doc:render`，正本与生成物放进同一个提交，check 检查两者一致。
 *
 * components 是组件名册：fumadocsRoster 给 fumadocs 自带文件树 Files / Folder / File 与 Note 的机读规则，站里自己的组件追加在后面；
 * React 那一半在 src/components/mdx.tsx，名单在 src/components/registry.ts，两边由 scripts/verify-roster.mjs 核对。
 * 讲解组件的规则各在组件目录里的 .ai.mjs，读组件自己的讲解数据生成文字。
 */
import { fumadocsRoster } from '@godcreator/docfirst-workflow/fumadocs/roster'
import * as glossaryList from './src/components/glossary-list/glossary-list.ai.mjs'
import * as healthCases from './src/components/health-cases/health-cases.ai.mjs'
import * as lockSteps from './src/components/lock-steps/lock-steps.ai.mjs'
import * as roundCases from './src/components/round-cases/round-cases.ai.mjs'
import * as seamMap from './src/components/seam-map/seam-map.ai.mjs'
import * as tickTimeline from './src/components/tick-timeline/tick-timeline.ai.mjs'

export default {
  content: 'content',
  outputs: {
    'content/docs/outputs/readme.mdx': ['../README.md'],
    'content/docs/outputs/agents.mdx': ['../AGENTS.md'],
    'content/docs/outputs/claude.mdx': ['../CLAUDE.md'],
  },
  components: {
    ...fumadocsRoster,
    // 术语标注：自动标出的是构建时加的，不在源文件里；这条管作者手写的 <Term>，机读版只留原词
    Term: 'children',
    SeamMap: seamMap.SeamMap,
    RoundCases: roundCases.RoundCases,
    TickTimeline: tickTimeline.TickTimeline,
    LockSteps: lockSteps.LockSteps,
    HealthCases: healthCases.HealthCases,
    GlossaryList: glossaryList.GlossaryList,
  },
}
