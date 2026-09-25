/**
 * 这个站的 docfirst 配置：用哪个格式包、生成文件写到哪、组件规则表是什么。命令行和站读的是同一份。
 *
 * 项目根是这个站目录，引用的代码在 `plugins/windows-backup/`——引用里写 `../plugins/windows-backup/…`，
 * 按项目根拼路径，页面在哪个子目录都一样。
 * 分区按约定：`content/` 下 `trajectory/` 与 `future/` 两个名字固定，其余目录都是现状区、都进 check；
 * 本站的现状区只有 `content/docs`。
 *
 * 生成文件：仓根 README.md、AGENTS.md 与 CLAUDE.md，正本都在 `content/docs/outputs/`。
 * CLAUDE.md 第一行固定是 `@AGENTS.md`，只给 Claude 的指令写在它后面。生成正本按原文渲染，里面不能用 JSX 组件。
 */
import * as fumadocs from '@godcreator/docfirst-workflow/fumadocs'

export default {
  formats: [fumadocs],
  outputs: {
    'content/docs/outputs/readme.mdx': ['../README.md'],
    'content/docs/outputs/agents.mdx': ['../AGENTS.md'],
    'content/docs/outputs/claude.mdx': ['../CLAUDE.md'],
  },
  components: {
    ...fumadocs.defaultRoster,
  },
}
