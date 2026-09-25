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
    // 首页的接缝图：图本身在机读版里看不见，正文「接缝逐条」按同一套编号把每条接缝写全了
    BackupSeams: (node, h) =>
      h.paragraph(
        '[图] 接缝图：宿主层、域库、窗格三部分，注入的五个工作台插件，restic.exe 与 PowerShell 两个外部程序，数据目录里的四样文件；14 条跨边界的接缝按编号在正文里逐条讲',
      ),
    // 备份管线页的推演：拨条件看哪几段跑，机读版只剩一句话，判据在正文的列表里
    PipelineRound: (node, h) => h.paragraph('[演示] 拨本地备份、今天是否 prune 过、本地 prune、OSS 开关、OSS 备份几个条件，看一轮里哪几段跑、state.json 记下什么、通知说什么'),
  },
}
