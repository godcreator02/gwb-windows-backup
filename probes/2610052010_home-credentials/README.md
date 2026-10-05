# 每 home 凭据迁移验收

2026-10-05，隔离 home `stores-cred-2610052010`。只使用本目录脚本生成的假凭据与 hello.txt；真实账号和远端仓库不参与。

准备顺序：`devkit.home.new` 建 home；安装本次 settings/MCP 开发包；运行 `node prepare.mjs <home名> <restic.exe绝对路径>` 写入旧文件 fixture；经 `devkit.dev` 装 Sources 与 Windows Backup；运行 `node verify.mjs <home名>`。

验收涵盖：

- UTF-16LE/BOM/CRLF 旧密码文件和 OSS 文本真实迁入当前 home 的两个 secret；凭据列表不带值，普通设置不列 secret。
- 仓库由旧 `--password-file` 初始化，新凭据环境变量可备份、列快照、恢复并验证 hello.txt。旧文件仍能读取同仓快照，证明原密码有效性未变。
- Sources 通过 import → connect → status 完成关联；绑定地址改变被拒绝；disconnect 删除当前 home 凭据。
- 删除 restic-password 后停用/启用备份插件；旧文件仍在，但新值保持删除，调用明确失败。
- 全部命令回执与 home 日志不含注入的 fixture 凭据原文。脚本结果只记录命令名称和成功状态。

恢复 fixture 使用 `latest:/<快照内子目录>`，只还原测试源目录。Windows 整路径恢复会尝试恢复 C:/Users 祖先属性并可能被 ACL 拒绝，与凭据无关；本验收选择实际需要的子树并开启 `--verify`。

结果在 `result.json`。初次安装开发版：settings `0.3.11-dev.20261005200943`，MCP `0.11.8-dev.20261005200943`，Sources `0.1.1-dev.20261005201337`，Backup `0.3.1-dev.20261005201352`；正式版本由集成会话统一发布。
