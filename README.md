# gwb-windows-backup

备份件：Windows 个人备份——restic 打快照 + Veeam Agent Free 整机镜像 + 阿里云 OSS
异地库，跑在 gwb-kernel（单元 `26090705ymz`）线上。

**眼下是骨架**——devkit 模板落盘，功能尚未迁移。老仓
`D:\dshfiles\26082800ktb\god-windows-backup`（DSH 原生件）只作参考，意图与判据在
老仓 `CLAUDE.md`。

怎么走接下来的迁移，见随 devkit 件分发的写件手册（skill `gwb-devkit`）。

```powershell
pnpm install
pnpm build
```
