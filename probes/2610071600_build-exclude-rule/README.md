# 排除规则 build 那一条会不会误伤源文件

## 问什么

基线排除规则里 `**/build*/**` 是否会把 build 开头的源文件一起排除；换成 `build` 加 Qt 影子构建目录的确切写法后，
构建目录是否仍被排除、源文件是否都进了备份。

## 怎么运行

```powershell
pwsh -NoProfile -File .\run.ps1 -Restic "$env:APPDATA\gwb-kernel\homes\default\data\windows-backup\bin\restic.exe"
```

只要一个 restic 可执行文件，不碰任何真实仓库：脚本在系统临时目录里按 `input/samples.txt` 造样例文件、`restic init` 一个用完即删的仓库，
分别用 `input/restic-exclude-0.4.0.txt`（0.4.0 的基线副本）与仓里当前的 `plugins/windows-backup/config/restic-exclude.txt`
做 `backup --dry-run -vv`，按输出里的 `new … saved in` 行判断每个样例进没进备份，与 `samples.txt` 里写的期望比对，
结果写进 `runs/`。`-NewBaseline <路径>` 可以换一份基线来试。

## 结论

0.4.0 的 `**/build*/**` 与期望不一致 6 个：`build.ts`、`build-plugin.ts`、`src/build-katex-css.mjs`、
`memory/build-only-what-was-asked.md`、`builder/x.ts`、`build-logs/l.txt` 都被排除了——restic 的 `/**` 能匹配零层，
这条规则等于排除名字以小写 `build` 开头的任何文件与目录（`Build.md` 因为大小写不同没被排除）。
换成 `build`、`build-*-Debug`、`build-*-Release`、`build-*-Profile` 后不一致 0 个，构建目录照样排除；
代价是名字恰好叫 `build`、没有扩展名的文件（`sub2/build`）也会被排除。见 `runs/01-baseline-0.4.0.txt`、`runs/02-baseline-current.txt`。

## 运行那次的环境

2026-10-07，Windows 11 Pro 10.0.26200，PowerShell 7，restic 0.18.1（go1.25.1，windows/amd64）；
被测对象：本仓 `33f480c` 之上、基线改成新写法的工作区（随 windows-backup 0.4.1 一起提交）。
