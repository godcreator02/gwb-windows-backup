# 探针：白名单加路径的代价（父快照为什么会丢）

2026-09-20 实测。**目的**：量出「往 `sources` 里加一条路径」在 restic 那一层到底发生什么、
代价多大，并给「减路径不中招」找一个可对照的实例。

## 结论一句话

restic 的父快照默认按 `--group-by host,paths` 那一组挑，**加路径 = 新组 = 没有候选父本 =
整份重读重算**；减路径不会（候选快照只要「包含当前全部路径」即可，老快照是超集）。

## 怎么复现

前提：一个配好 restic 仓的 home（本机 default），日志与快照元数据都从插件这边读。

```powershell
# 1. 看下一轮有没有父本——restic 自己会把它说穿
#    有父本：`using parent snapshot <id>`；没有：`no parent snapshot found, will read all files`
Get-Content <home>\data\windows-backup\logs\restic-backup.log -Tail 12

# 2. 快照元数据里看路径集与 parent 字段（两条对照：加路径 / 减路径）
restic --repo <repo> --password-file <pw> cat snapshot <短ID>

# 3. 量一次全量的绝对速度：跑着的时候采这个进程的两个计数
$p = Get-CimInstance Win32_Process -Filter "Name='restic.exe'"
$p.ReadTransferCount   # 字节
$p.UserModeTime        # 100ns 单位的用户态 CPU
```

## 读数（2026-09-20，本机 Windows 11 / UMIS 1TB NVMe / 16 核 / GOMAXPROCS=1）

| 什么 | 值 | 出自 |
| --- | --- | --- |
| 数据源总量 | 51.0 GiB / 452k 个文件 | 日志 `processed 452347 files, 51.021 GiB` |
| 常规轮（有父本） | 4-5 分钟，只读 300 来个变动的文件 | 日志 `Files: 204 new, 101 changed, 452042 unmodified` |
| 加两条路径那一轮 | 没有父本，全读；跑到第 37 分钟读了 25.3 GB 被叫停 | `readings.txt` |
| 读取速度 | 7.4-15 MB/s（波动到 40） | `readings.txt` |
| restic CPU | 单核 19% | 同上 |
| MsMpEng（Defender 实时防护） | 1.18 核 | 同上 |
| 全机读速 / 磁盘 | 15.6 MB/s、NVMe 远未饱和 | 同上 |
| 折算 | ~64 文件/秒 ≈ 每文件 12-15 ms | 452k × 15 ms ≈ 90 分钟/趟，本地 + OSS 两趟 |

对照实例（同一仓库的历史快照元数据）：

| 快照 | 时间 | paths | parent 字段 | files_unmodified |
| --- | --- | --- | --- | --- |
| `179b3086` | 05-11 07:24 | 10（+4） | **无** | **0**（全读） |
| `19ddb78f` | 05-11 07:44 | 13（+3） | **无** | **0**（全读） |
| `fae07220` | 05-11 08:00 | 13（不变） | 有 | 111,960 |
| `1277c92f` | 09-19 08:15 | 8（**减**） | 有（父本 `1d339612` 是 10 条） | 446,715 |

## 顺手量到的两条（不在本探针结论里，但记下来）

- `--parent <不存在的 ID>` 的表现：stderr 一行 `no matching ID found for prefix "00000000"`、
  退出码 1、stdout 空（0.18.1）
- 显式 `--parent` 给一份**路径集不同**的快照是可行的：父本 8 条路径、这一轮 10 条，输出
  `Files: 380 new, 133 changed, 452152 unmodified`，4:03 跑完——只有新路径被真读

## 材料

- `readings.txt`：当时采的进程计数、日志片段、快照元数据摘录（原样粘贴）
