# gwb-windows-backup

gwb 工作台的 Windows 备份插件：restic 打快照 + 阿里云 OSS 异地副本（restic 的 S3 后端，
第二次独立 backup 直接写 `s3:` 仓库）+ 周期自检。

## 现在有什么

- **node 侧**（`plugins/windows-backup/src/`，零第三方依赖，只用 node 内置模块）：
  - 定时备份（默认 30 分钟）+ 加载 30 秒后补跑 + 每日一次 forget+prune + OSS 推送
  - 五项健康检查：上次备份 / 日志尾 / 仓库盘余量 / 快照新鲜度 / 周期维护提醒
  - 跨进程锁（`backup.lock`，持锁方 6 小时没心跳就由新的一轮接管）、凭据永不进日志（`--password-file`）
  - **改白名单不会整份重读**：本地与 OSS 两次备份都显式传上一条成功快照当父快照（`--parent`），
    加路径只读新增那条；父快照在仓库里没了就不带它重跑一次，不算故障
- **命令**（`windows-backup.*`，经 MCP 入口的 `run` 调用）：
  `run` / `check` / `status` / `paths` / `restic`（直通，密钥不出现在参数里）/ `mark`
- **浏览器侧**：备份窗格（`mountPane`）——状态灯、五项、按钮、30 秒轮询；复核到期显示横幅 + 一键复制复核提示词
- **设置**：17 个键经 gwb-settings 声明（kebab-case，如 `frequency-minutes`、`local-repo`、`review-interval-days`；`sources` 与 `exclude` 是 string-list 型一行一项，exclude 追加在内置排除基线之上）

## 怎么跑

```powershell
pnpm build     # 仓根运行：esbuild 构建浏览器侧 + tsc 构建 node 侧 + tailwindcss 按类名前缀输出样式
pnpm check     # 仓根运行：typecheck ×2 + oxlint + vitest（!slow）
```

## 怎么装

在工作台里依次调 `plugin-manager.install {"pkg":"@cordisjs/plugin-timer"}` 与
`plugin-manager.install {"pkg":"@godcreator/gwb-windows-backup"}`。本插件的定时器用官方的
`@cordisjs/plugin-timer`（公共 npm），插件管理不替它装，要单独装；home 里没有 timer 条目时本插件
整个停在等待——宁可等待，不在没有定时器时假装在备份。

## 还没做的

- 四份 AI 手册 + shared 材料
- 不依赖工作台的灾难恢复命令行入口（`node dist/cli.js --data-root`，连带 config.json 快照）与 gwbNodeCli
- 真 OSS 推送的实机验证（单测已覆盖；真跑要专用 repoPath / 独立凭据）

各在等什么前提，见文档站的[路线](/future/roadmap)。

## 文档

文档站在 `docs-site/`：`cd docs-site; pnpm dev`，看 `http://localhost:4318`。

**代码注释只写现状**——为什么这么写、判据怎么来的，都在文档站。

这份 README 是生成物，正本是 `docs-site/content/docs/outputs/readme.mdx`。
