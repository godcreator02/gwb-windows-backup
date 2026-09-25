'use client'

import { useState, type ReactElement } from 'react'

/**
 * 首页的接缝图：本插件三部分（宿主层、域库、窗格）、它注入的工作台插件、它启动的外部程序、它读写的数据目录，
 * 跨边界的每条线带一个编号，编号与正文「接缝逐条」一一对应。点编号高亮两端并显示契约，点模块名淡化无关的部分。
 */

type ModuleId = 'plugins' | 'host' | 'domain' | 'pane' | 'disk' | 'outside'
type SeamKind = 'call' | 'process' | 'disk'

interface Box {
  id: Exclude<ModuleId, 'outside'>
  x: number
  y: number
  w: number
  h: number
  label: string
  /** 标签放在框的上沿还是下沿：放在没有接缝穿过的那一边 */
  labelAt: 'top' | 'bottom'
}

interface Capability {
  id: string
  module: ModuleId
  x: number
  y: number
  w: number
  h: number
  name: string
  ident: string
}

interface Seam {
  n: number
  from: string
  to: string[]
  kind: SeamKind
  title: string
  contract: string
  /** 折线的各个拐点；有第二段（分叉）时写在 branch 里 */
  points: [number, number][]
  branch?: [number, number][]
  badge: [number, number]
}

const CAP_H = 56
const FILE_H = 46

const BOXES: Box[] = [
  { id: 'plugins', x: 340, y: 24, w: 640, h: 108, label: '工作台里的别的插件', labelAt: 'top' },
  { id: 'pane', x: 20, y: 180, w: 280, h: 120, label: '窗格 src/client/', labelAt: 'bottom' },
  { id: 'host', x: 340, y: 180, w: 640, h: 120, label: '宿主层 src/index.ts', labelAt: 'bottom' },
  { id: 'domain', x: 340, y: 350, w: 640, h: 210, label: '域库 src/*.ts', labelAt: 'top' },
  { id: 'disk', x: 340, y: 600, w: 640, h: 100, label: '数据目录 <home>/data/<条目 id>/', labelAt: 'bottom' },
]

const cap = (id: string, module: ModuleId, x: number, y: number, name: string, ident: string, w = 115, h = CAP_H): Capability => ({
  id,
  module,
  x,
  y,
  w,
  h,
  name,
  ident,
})

const CAPABILITIES: Capability[] = [
  cap('commands', 'plugins', 355, 60, '命令总线', 'gwbCommands'),
  cap('settings', 'plugins', 480, 60, '设置', 'gwbSettings'),
  cap('data', 'plugins', 605, 60, '数据', 'gwbData'),
  cap('timer', 'plugins', 730, 60, '定时器', 'timer'),
  cap('shell', 'plugins', 855, 60, '外壳（可选）', 'gwbShell'),
  cap('regCommands', 'host', 355, 225, '六条命令', 'registerCommands'),
  cap('settingsDecl', 'host', 480, 225, '17 个设置键', 'SETTING_KEYS'),
  cap('dataDir', 'host', 605, 225, '数据目录', 'ensureDataDir'),
  cap('runtime', 'host', 730, 225, '定时备份与自检', 'createBackupRuntime'),
  cap('paneReg', 'host', 855, 225, '注册窗格', 'registerPane'),
  cap('mountPane', 'pane', 35, 225, '挂载', 'mountPane', 120),
  cap('poll', 'pane', 165, 225, '30 秒取状态', 'useStatus', 120),
  cap('toast', 'domain', 355, 385, '结束通知', 'sendToast'),
  cap('pipeline', 'domain', 480, 385, '备份管线', 'runFullBackup'),
  cap('health', 'domain', 605, 385, '五项健康', 'runHealthCheck'),
  cap('config', 'domain', 730, 385, '配置收窄', 'flatToConfig'),
  cap('restic', 'domain', 355, 470, 'restic 与子进程', 'runRestic'),
  cap('log', 'domain', 480, 470, '日志契约行', 'messages.ts'),
  cap('state', 'domain', 605, 470, '动作记录', 'readState'),
  cap('lock', 'domain', 730, 470, '锁', 'acquire'),
  cap('creds', 'domain', 855, 470, '凭据', 'readOssEnv'),
  cap('logFile', 'disk', 480, 635, '备份日志', 'logs/*.log', 115, FILE_H),
  cap('stateFile', 'disk', 605, 635, '动作记录', 'state.json', 115, FILE_H),
  cap('lockFile', 'disk', 730, 635, '锁文件', 'backup.lock', 115, FILE_H),
  cap('credsDir', 'disk', 855, 635, '凭据', 'credentials/', 115, FILE_H),
  cap('agent', 'outside', 190, 60, 'agent', 'MCP 入口 run', 110),
  cap('powershell', 'outside', 20, 385, 'PowerShell 5.1', 'Windows 通知', 280),
  cap('resticExe', 'outside', 20, 470, 'restic.exe', '本地仓 · s3: OSS 仓', 280),
]

const SEAMS: Seam[] = [
  { n: 1, from: 'commands', to: ['regCommands'], kind: 'call', title: '命令总线 ⇄ 六条命令', contract: 'register({ name, description, usage, plugin }, handler)；调用时 handler 回 { ok, data?, error? }', points: [[412, 116], [412, 225]], badge: [412, 170] },
  { n: 2, from: 'settings', to: ['settingsDecl'], kind: 'call', title: '设置插件 ⇄ 17 个设置键', contract: 'define({ key, title, type, description, default })；每轮 get(key) 现读，不缓存', points: [[537, 116], [537, 225]], badge: [537, 170] },
  { n: 3, from: 'data', to: ['dataDir'], kind: 'call', title: '数据插件 → 数据目录', contract: 'gwbData.dir = <home>/data/<条目 id>；layout(dir) 由它算出全部路径', points: [[662, 116], [662, 225]], badge: [662, 170] },
  { n: 4, from: 'timer', to: ['runtime'], kind: 'call', title: '定时器插件 → 定时备份与自检', contract: 'ctx.interval(fn, ms) 回停止函数；ctx.timeout(fn, 30_000) 排首次自检与补跑', points: [[787, 116], [787, 225]], badge: [787, 170] },
  { n: 5, from: 'paneReg', to: ['shell'], kind: 'call', title: '注册窗格 → 外壳', contract: "registerPane({ id: 'main', client, style })，client / style 是 dist/ 下的 file:// 地址", points: [[912, 225], [912, 116]], badge: [912, 170] },
  { n: 6, from: 'shell', to: ['mountPane'], kind: 'call', title: '外壳 → 挂载窗格', contract: 'mountPane(args: PaneArgs, container) 同步回 { dispose }', points: [[912, 60], [912, 12], [95, 12], [95, 225]], badge: [500, 12] },
  { n: 7, from: 'poll', to: ['commands'], kind: 'call', title: '窗格 → 命令总线', contract: "host.call('windows-backup.status') → { ok: true, data: snapshot() }；按钮调 run / check", points: [[225, 225], [225, 150], [375, 150], [375, 116]], badge: [300, 150] },
  { n: 8, from: 'runtime', to: ['pipeline', 'health'], kind: 'call', title: '宿主层 → 域库', contract: 'MountDeps.runBackup / runHealth：runFullBackup({ paths, config, logger }) 与 runHealthCheck(paths, config)，都不抛', points: [[787, 281], [787, 322], [537, 322], [537, 385]], branch: [[662, 322], [662, 385]], badge: [725, 322] },
  { n: 9, from: 'restic', to: ['resticExe'], kind: 'process', title: '域库 → restic.exe', contract: 'argv 数组、不经 shell：--repo <仓> --password-file <路径> <子命令>；OSS 那次的 env 里带 AccessKey', points: [[355, 498], [300, 498]], badge: [327, 498] },
  { n: 10, from: 'toast', to: ['powershell'], kind: 'process', title: '域库 → PowerShell', contract: 'powershell -NoProfile -Command <WinRT 调用>，10 秒超时，失败只记一行 Notification failed', points: [[355, 413], [300, 413]], badge: [327, 413] },
  { n: 11, from: 'log', to: ['logFile'], kind: 'disk', title: '日志契约行 ⇢ 备份日志', contract: '[YYYY-MM-DD HH:MM:SS] <契约行> 加 restic 原始输出；备份管线写，五项健康读尾巴', points: [[537, 526], [537, 635]], badge: [537, 580] },
  { n: 12, from: 'state', to: ['stateFile'], kind: 'disk', title: '动作记录 ⇢ state.json', contract: 'lastRunAt / lastRunOk / lastRunSummary、两份父快照 ID、lastPrune 与三个周期动作日期', points: [[662, 526], [662, 635]], badge: [662, 580] },
  { n: 13, from: 'lock', to: ['lockFile'], kind: 'disk', title: '锁 ⇢ backup.lock', contract: "{ pid, lease, startedAt, beatAt }，flag: 'wx' 创建，每 5 分钟刷一次 beatAt", points: [[787, 526], [787, 635]], badge: [787, 580] },
  { n: 14, from: 'creds', to: ['credsDir'], kind: 'disk', title: '凭据 ⇢ credentials/', contract: 'restic-password.txt 只交路径；oss-credentials.txt 按 KEY=VALUE 解析进子进程 env', points: [[912, 526], [912, 635]], badge: [912, 580] },
]

const CAP_BY_ID = new Map(CAPABILITIES.map((one) => [one.id, one]))

type Selection = { kind: 'seam'; n: number } | { kind: 'module'; id: ModuleId } | null

function endpointsOf(seam: Seam): string[] {
  return [seam.from, ...seam.to]
}

function seamTouchesModule(seam: Seam, module: ModuleId): boolean {
  return endpointsOf(seam).some((id) => CAP_BY_ID.get(id)?.module === module)
}

function polyline(points: [number, number][]): string {
  return points.map(([x, y]) => `${String(x)},${String(y)}`).join(' ')
}

function isCapabilityLit(capability: Capability, selection: Selection): boolean {
  if (selection === null) return true
  if (selection.kind === 'module') {
    return capability.module === selection.id || SEAMS.some((seam) => seamTouchesModule(seam, selection.id) && endpointsOf(seam).includes(capability.id))
  }
  const seam = SEAMS.find((one) => one.n === selection.n)
  return seam !== undefined && endpointsOf(seam).includes(capability.id)
}

function isSeamLit(seam: Seam, selection: Selection): boolean {
  if (selection === null) return true
  if (selection.kind === 'module') return seamTouchesModule(seam, selection.id)
  return seam.n === selection.n
}

function CapabilityBlock({ capability, lit }: { capability: Capability; lit: boolean }): ReactElement {
  const { x, y, w, h, name, ident } = capability
  const outside = capability.module === 'outside'
  const identFits = ident.length * 6.2 <= w - 12
  return (
    <g className="wb-fade" style={{ opacity: lit ? 1 : 0.22 }}>
      <rect x={x} y={y} width={w} height={h} rx={outside ? h / 2 : 6} className={outside ? 'wb-outside' : 'wb-cap'} />
      <text x={x + w / 2} y={y + (h > 50 ? 23 : 19)} textAnchor="middle" className="wb-cap-name">
        {name}
      </text>
      <text
        x={x + w / 2}
        y={y + (h > 50 ? 42 : 36)}
        textAnchor="middle"
        className="wb-cap-ident"
        {...(identFits ? {} : { textLength: w - 12, lengthAdjust: 'spacingAndGlyphs' as const })}
      >
        {ident}
      </text>
    </g>
  )
}

function SeamLine({ seam, lit, selected, onPick }: { seam: Seam; lit: boolean; selected: boolean; onPick: () => void }): ReactElement {
  const className = `wb-seam wb-seam-${seam.kind}${selected ? ' wb-seam-selected' : ''}`
  return (
    <g className="wb-fade" style={{ opacity: lit ? 1 : 0.15 }}>
      <polyline points={polyline(seam.points)} className={className} />
      {seam.branch ? <polyline points={polyline(seam.branch)} className={className} /> : null}
      <g role="button" tabIndex={0} aria-label={`接缝 ${String(seam.n)}：${seam.title}`} className="wb-badge" onClick={onPick} onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && onPick()}>
        <circle cx={seam.badge[0]} cy={seam.badge[1]} r={11} className={`wb-badge-dot wb-badge-${seam.kind}${selected ? ' wb-badge-selected' : ''}`} />
        <text x={seam.badge[0]} y={seam.badge[1] + 4} textAnchor="middle" className="wb-badge-text">
          {seam.n}
        </text>
      </g>
    </g>
  )
}

function ModuleFrame({ box, lit, onPick }: { box: Box; lit: boolean; onPick: () => void }): ReactElement {
  return (
    <g className="wb-fade" style={{ opacity: lit ? 1 : 0.35 }}>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={10} className="wb-module" />
      <text
        x={box.x + 12}
        y={box.labelAt === 'top' ? box.y + 18 : box.y + box.h - 8}
        className="wb-module-label"
        role="button"
        tabIndex={0}
        onClick={onPick}
        onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && onPick()}
      >
        {box.label}
      </text>
    </g>
  )
}

function DetailPanel({ selection }: { selection: Selection }): ReactElement {
  if (selection === null) {
    return <p className="wb-panel-hint">点一个编号看这条接缝的契约，点一个模块名只看和它相连的接缝。实线是函数调用或启动进程，虚线是读写磁盘上的文件。</p>
  }
  if (selection.kind === 'module') {
    const seams = SEAMS.filter((seam) => seamTouchesModule(seam, selection.id))
    const box = BOXES.find((one) => one.id === selection.id)
    return (
      <div>
        <p className="wb-panel-title">{box?.label ?? '模块之外'}</p>
        <p className="wb-panel-body">相连的接缝：{seams.map((seam) => `${String(seam.n)} ${seam.title}`).join('；')}</p>
      </div>
    )
  }
  const seam = SEAMS.find((one) => one.n === selection.n)
  if (seam === undefined) return <p className="wb-panel-hint">没有这条接缝。</p>
  const ends = endpointsOf(seam).map((id) => CAP_BY_ID.get(id)?.name ?? id)
  return (
    <div>
      <p className="wb-panel-title">
        接缝 {seam.n}：{seam.title}
      </p>
      <p className="wb-panel-body">两端：{ends.join(' · ')}</p>
      <p className="wb-panel-contract">{seam.contract}</p>
    </div>
  )
}

export function BackupSeams(): ReactElement {
  const [selection, setSelection] = useState<Selection>(null)
  const toggle = (next: Exclude<Selection, null>): void => {
    setSelection((current) =>
      current !== null && current.kind === next.kind && (current.kind === 'seam' ? current.n === (next as { n: number }).n : current.id === (next as { id: ModuleId }).id) ? null : next,
    )
  }

  return (
    <div className="not-prose wb-seams my-6 rounded-xl border border-fd-border bg-fd-card p-3">
      <style>{STYLES}</style>
      <div className="overflow-x-auto">
        <svg viewBox="0 0 1000 712" className="wb-svg" role="img" aria-label="Windows 备份插件的接缝图">
          {BOXES.map((box) => (
            <ModuleFrame
              key={box.id}
              box={box}
              lit={selection === null || (selection.kind === 'module' ? selection.id === box.id : SEAMS.some((seam) => seam.n === selection.n && seamTouchesModule(seam, box.id)))}
              onPick={() => toggle({ kind: 'module', id: box.id })}
            />
          ))}
          <g className="wb-fade" style={{ opacity: selection === null ? 1 : 0.2 }}>
            <line x1={300} y1={88} x2={353} y2={88} className="wb-entry" markerEnd="url(#wb-arrow)" />
          </g>
          <defs>
            <marker id="wb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="wb-arrow-head" />
            </marker>
          </defs>
          {SEAMS.map((seam) => (
            <SeamLine
              key={seam.n}
              seam={seam}
              lit={isSeamLit(seam, selection)}
              selected={selection?.kind === 'seam' && selection.n === seam.n}
              onPick={() => toggle({ kind: 'seam', n: seam.n })}
            />
          ))}
          {CAPABILITIES.map((capability) => (
            <CapabilityBlock key={capability.id} capability={capability} lit={isCapabilityLit(capability, selection)} />
          ))}
        </svg>
      </div>
      <div className="wb-panel" aria-live="polite">
        <DetailPanel selection={selection} />
      </div>
    </div>
  )
}

const STYLES = `
.wb-seams {
  --wb-call: #2563eb;
  --wb-process: #7c3aed;
  --wb-disk: #b45309;
  --wb-module: color-mix(in srgb, var(--color-fd-foreground) 45%, transparent);
}
.dark .wb-seams {
  --wb-call: #60a5fa;
  --wb-process: #a78bfa;
  --wb-disk: #fbbf24;
}
.wb-svg { width: 100%; min-width: 720px; height: auto; display: block; font-family: inherit; }
.wb-fade { transition: opacity 180ms ease; }
.wb-module { fill: none; stroke: var(--wb-module); stroke-width: 1.2; stroke-dasharray: 6 5; }
.wb-module-label { fill: var(--color-fd-foreground); font-size: 13px; font-weight: 600; cursor: pointer; }
.wb-module-label:hover { text-decoration: underline; }
.wb-cap { fill: var(--color-fd-background); stroke: var(--color-fd-border); stroke-width: 1.2; }
.wb-outside { fill: color-mix(in srgb, var(--color-fd-muted-foreground) 10%, transparent); stroke: var(--color-fd-border); stroke-width: 1.2; }
.wb-cap-name { fill: var(--color-fd-foreground); font-size: 13px; }
.wb-cap-ident { fill: var(--color-fd-muted-foreground); font-size: 10.5px; font-family: ui-monospace, monospace; }
.wb-seam { fill: none; stroke-width: 2; }
.wb-seam-call { stroke: var(--wb-call); }
.wb-seam-process { stroke: var(--wb-process); }
.wb-seam-disk { stroke: var(--wb-disk); stroke-dasharray: 6 4; }
.wb-seam-selected { stroke-width: 3.5; }
.wb-entry { stroke: var(--color-fd-muted-foreground); stroke-width: 1.5; }
.wb-arrow-head { fill: var(--color-fd-muted-foreground); }
.wb-badge { cursor: pointer; }
.wb-badge:focus-visible { outline: none; }
.wb-badge:focus-visible .wb-badge-dot { stroke-width: 3; }
.wb-badge-dot { fill: var(--color-fd-background); stroke-width: 2; }
.wb-badge-call { stroke: var(--wb-call); }
.wb-badge-process { stroke: var(--wb-process); }
.wb-badge-disk { stroke: var(--wb-disk); }
.wb-badge-selected.wb-badge-call { fill: var(--wb-call); }
.wb-badge-selected.wb-badge-process { fill: var(--wb-process); }
.wb-badge-selected.wb-badge-disk { fill: var(--wb-disk); }
.wb-badge-text { fill: var(--color-fd-foreground); font-size: 11px; font-weight: 700; pointer-events: none; }
.wb-badge-selected + .wb-badge-text { fill: var(--color-fd-background); }
.wb-panel { min-height: 4.5rem; padding: 0.75rem 0.5rem 0.25rem; border-top: 1px solid var(--color-fd-border); margin-top: 0.5rem; font-size: 0.875rem; }
.wb-panel-hint { color: var(--color-fd-muted-foreground); margin: 0; }
.wb-panel-title { font-weight: 600; margin: 0 0 0.25rem; }
.wb-panel-body { color: var(--color-fd-muted-foreground); margin: 0 0 0.25rem; }
.wb-panel-contract { font-family: ui-monospace, monospace; font-size: 0.8rem; margin: 0; overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) { .wb-fade { transition: none; } }
`
