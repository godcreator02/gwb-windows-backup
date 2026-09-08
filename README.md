# gwb-windows-backup

备份件：Windows 个人备份——restic 打快照 + 阿里云 OSS 异地副本（restic 的 S3 后端，
第二次独立 backup 直打 `s3:` 仓）+ 周期自检，跑在 gwb-kernel（单元 `26090705ymz`）线上。
Veeam 整机镜像在老仓里就 100% 归手册、代码零涉及，等手册那轮一起搬。

自 DSH 原生件重做（老仓 `D:\dshfiles\26082800ktb\god-windows-backup` 只作参考）：域逻辑
（锁、备份管线、五项健康判据、restic 参数表、日志契约句、凭据纪律）语义照搬、代码重写；
宿主层整个换新线契约——命令总线、设置件、数据件、外壳窗格、状态墙。

## 现在有什么

- **node 半**（`src/`，零第三方依赖，node 内建 only）：
  - 定时备份（默认 30 分钟）+ 挂载 30 秒后补跑 + 每日一次 forget+prune + OSS 推送
  - 五项健康检查：上次备份 / 日志尾 / 仓库盘余量 / 快照新鲜度 / 周期维护提醒
  - 跨进程锁（`backup.lock`，6h 陈旧接管）、凭据永不进日志（`--password-file`）
- **命令面**（`windows-backup.*`，MCP 件会自动开给 agent）：
  `run` / `check` / `status` / `paths` / `restic`（直通，密钥不出现在参数里）/ `mark`
- **client 半**：状态墙一格（`mountCell`）+ 备份窗格（`mountPane`）——灯、五项、按钮、30s 轮询
- **设置**：15 个键经 gwb-settings 声明（kebab-case，如 `frequency-minutes`、`local-repo`）

## 怎么跑

```powershell
pnpm check     # typecheck ×2 + oxlint + vitest（!slow）
pnpm build     # tsc node 半 + esbuild client 半 + tailwind 样式
pnpm publish:dev   # 发本机 Verdaccio（127.0.0.1:4873），dev 标不动 latest
```

装进隔离 home（正路）：`pnpm add @godcreator02/gwb-windows-backup@<版本>`，cordis.yml 手写
`id: windows-backup` 的条目。

## 还没搬的（后续会话）

- 四份 AI 手册 + shared 材料（skills/ 局部注入口子已留好）
- 宿主无关灾难 CLI 门（`node dist/cli.js --data-root`，连带 config.json 快照）与 gwbNodeCli
- 市场白名单（gwb-base-plugins 的 market catalog，等 release）
- 真 OSS 推送的实机验证（单测已盖；真跑要专用 repoPath / 独立凭据，等接班那轮）
