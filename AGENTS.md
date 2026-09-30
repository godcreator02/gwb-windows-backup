# gwb-windows-backup

gwb 工作台的 Windows 备份插件（restic 快照 + OSS 异地副本 + 健康结论 + 备份窗格）。workspace 布局：
插件包 `@godcreator/gwb-windows-backup` 在 `plugins/windows-backup/`，发到团队源（`publishConfig.registry`）；
装进 home 用 `plugin-manager.install`，另要装官方定时器 `@cordisjs/plugin-timer`（见文档站用法页）。
文档站 `docs-site/`，端口 4318，看页面先 `pnpm build` 再 `pnpm start`。

写插件、在隔离 home 里验证读 skill「gwb-devkit」，升版本号、发版读 skill「gwb-release」，
写或改文档站读 skill「docfirst-docs」与「docs-site」。

## 检查与构建

```powershell
pnpm build      # 仓根运行：esbuild 打包浏览器侧 + tsc 输出 node 侧 + tailwindcss 输出样式
pnpm check      # 仓根运行：typecheck ×2 + oxlint --deny-warnings + vitest(!slow)
```

装进隔离 home 验证：`devkit.dev {"home":"<home 名>","dir":"<仓根>","packages":["plugins/windows-backup"]}`；
发版：`devkit.release {"dir":"<仓根>","packages":["plugins/windows-backup"]}`。样式检查（类名前缀、只用主题令牌）
在这两条命令里做，本仓的测试不重复查。

## 硬约束

- **node 侧（`plugins/windows-backup/src/` 下 `client/` 以外）零第三方依赖**，只用 node 内置模块；宿主层只认 `HostContext`，
  不 import 内核运行时。浏览器侧 `src/client/` 用的 react 由页面提供，其余（shadcn 组件与它依赖的 `radix-ui` 等）写在 dev 依赖里、打包进 `client.js`
- **按钮等可点控件用 shadcn 官方组件**：`src/client/components/ui/` 下的文件在插件包目录运行 `pnpm dlx shadcn@latest add <组件>` 生成，
  不手改样式；使用处 `className` 只写布局，颜色与尺寸从组件已有的 `variant` / `size` 里选
- **凭据纪律**：密码只交路径（`--password-file`）、OSS key 只进子进程 env；永不进设置、
  永不进日志、永不进报错消息（凭据文件格式不对时报错只带行号与键名）
- **一轮的结论只看 `state.json`**：日志只给人看，程序不读它来判成败
- **状态每次现算**：`status` 不缓存健康结论，只有读仓库的快照读数留在宿主层
- **只有一个定时器**：每分钟一跳，现读设置、看 `lastRunAt` 判到期；同一时间只有一轮只靠 `backup.lock`，不在宿主层另加标志
- **设置的正本是 `src/config.ts` 的 `SETTINGS`**：值不合法就拒跑并说清是哪个键，不替它换成默认值、不认别的写法
- **本地与 OSS 两次 restic backup 都显式传父快照**（`state.json` 里的 ID → restic `--parent`），
  白名单加路径才不会整份重读；那份 ID 失效时不带父快照重跑一次，只认 restic 的那两句原话
- **顶层 `inject` 只列 gwbCommands / gwbSettings / gwbData / timer**；外壳走局部注入，
  列进顶层，没装外壳的 home 里备份就整个停在等待
- 放到后台的 async 调用（`void …`）自己 catch 并打日志——静默 reject 在日志里什么都不留

## 文档与实验材料

- 仓根 `README.md`、`AGENTS.md`、`CLAUDE.md` 都是生成物，正本在 `docs-site/content/docs/outputs/`，改那边，
  在站目录运行 `pnpm doc:render`；改了被钉的代码，同一个提交里 `pnpm doc` → `pnpm doc:confirm` → 复核黄灯
- 实验与测量的材料放在仓根 `probes/<时间戳>_<目的>/`：一次实验一个目录、自包含（自己的
  package.json 或零依赖）、进 git、不进 pnpm workspace、不进文档检查；evidence 卡用相对
  仓根的路径指过去
