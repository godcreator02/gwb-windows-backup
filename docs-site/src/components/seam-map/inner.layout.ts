/**
 * 包内部接缝图（inner.data.mjs）的坐标与图标。从上往下五排：窗格与工作台服务、宿主层、配置 · 一轮备份 · 健康结论、
 * 锁 · 状态 · 凭据 · 日志与通知 · 子进程、数据目录与两个外部程序。
 * 1 在第一排下面沿 y=136 汇成一条；第三、四排之间的通道（y 在 414 与 470 之间）里：6 从宿主层左边沿 x=130 下来、沿 y=428 分给锁与状态，
 * 7 沿 y=444 分给锁与状态（与 6 交叉一处），8 沿 y=456，10 沿 y=444，9 从备份与 prune 沿 y=428 往右、从六条命令沿右边 x=1188 下来汇到子进程；
 * 进锁的两条线落在 x≥285，避开「锁」框的标题。最下面 11–16 都是直线。
 */
import { cap } from '@godcreator/docfirst-explainer'
import type { SeamLayout } from '@godcreator/docfirst-explainer'
import {
  BotIcon,
  CheckIcon,
  CogIcon,
  FileIcon,
  FolderIcon,
  LayersIcon,
  ListIcon,
  PackageIcon,
  PanelIcon,
  ShieldIcon,
  TagIcon,
  TerminalIcon,
  UserIcon,
} from '../icons'

export const innerLayout: SeamLayout = {
  view: { w: 1200, h: 720 },
  caps: {
    'pane-ui': cap(154, 52, 180),
    poll: cap(344, 52, 162),
    cmdbus: cap(574, 52, 140),
    settings: cap(724, 52, 140),
    timer: cap(874, 52, 140),
    shell: cap(1024, 52, 142),

    tick: cap(154, 202, 240),
    run: cap(404, 202, 250),
    snap: cap(664, 202, 250),
    cmds: cap(924, 202, 242),

    cfg: cap(154, 352, 242),
    full: cap(444, 352, 160),
    stages: cap(614, 352, 162),
    assess: cap(824, 352, 170),
    readsnap: cap(1004, 352, 162),

    'lock-fn': cap(154, 502, 168),
    'state-fn': cap(365, 502, 168),
    'cred-fn': cap(576, 502, 168),
    'log-fn': cap(787, 502, 168),
    'run-fn': cap(998, 502, 168),

    'f-lock': cap(154, 652, 180),
    'f-state': cap(344, 652, 180),
    'f-cred': cap(534, 652, 180),
    'f-log': cap(724, 652, 182),
    ps: cap(944, 652, 106),
    'restic-exe': cap(1060, 652, 106),
  },
  groups: {
    client: { x: 140, y: 20, w: 380, h: 94 },
    workbench: { x: 560, y: 20, w: 620, h: 94 },
    index: { x: 140, y: 170, w: 1040, h: 94 },
    config: { x: 140, y: 320, w: 270, h: 94 },
    backup: { x: 430, y: 320, w: 360, h: 94 },
    health: { x: 810, y: 320, w: 370, h: 94 },
    lock: { x: 140, y: 470, w: 196, h: 94 },
    state: { x: 351, y: 470, w: 196, h: 94 },
    cred: { x: 562, y: 470, w: 196, h: 94 },
    log: { x: 773, y: 470, w: 196, h: 94 },
    restic: { x: 984, y: 470, w: 196, h: 94 },
    datadir: { x: 140, y: 620, w: 780, h: 94 },
    powershell: null,
    resticexe: null,
  },
  seamPaths: {
    '1': { d: 'M644,100 V136 M794,100 V136 M944,100 V136 M1095,100 V136 M274,136 H1095 M274,136 V202 M1045,136 V202', badge: [460, 136] },
    '2': { d: 'M506,76 H574', badge: [540, 76] },
    '3': { d: 'M270,250 V352', badge: [270, 300] },
    '4': { d: 'M520,250 V352', badge: [520, 300] },
    '5': { d: 'M880,250 V352 M880,300 H1085 V352', badge: [980, 300] },
    '6': { d: 'M154,238 H130 V428 H410 V502 M285,428 V502', badge: [130, 340] },
    '7': { d: 'M500,400 V444 M310,444 H500 M310,444 V502 M470,444 V502', badge: [375, 444] },
    '8': { d: 'M590,400 V456 H735 V502', badge: [660, 456] },
    '9': { d: 'M700,400 V428 H1188 M1085,400 V502 M1150,250 V290 H1188 V428', badge: [930, 428] },
    '10': { d: 'M630,400 V444 H870 V502', badge: [760, 444] },
    '11': { d: 'M1110,550 V652', badge: [1110, 600] },
    '12': { d: 'M950,550 V652', badge: [950, 600] },
    '13': { d: 'M240,550 V652', badge: [240, 600] },
    '14': { d: 'M440,550 V652', badge: [440, 600] },
    '15': { d: 'M650,550 V652', badge: [650, 600] },
    '16': { d: 'M850,550 V652', badge: [850, 600] },
  },
  entries: {
    person: { box: { x: 20, y: 56, w: 100, h: 40 }, arrow: [120, 76, 140, 76] },
    agent: { box: { x: 20, y: 206, w: 100, h: 40 }, arrow: [120, 226, 140, 226] },
  },
  moduleIcons: {
    client: PanelIcon,
    workbench: LayersIcon,
    index: PackageIcon,
    config: CogIcon,
    backup: ShieldIcon,
    health: CheckIcon,
    lock: TagIcon,
    state: FileIcon,
    cred: TagIcon,
    log: ListIcon,
    restic: TerminalIcon,
    datadir: FolderIcon,
    powershell: TerminalIcon,
    resticexe: TerminalIcon,
  },
  entryIcons: { person: UserIcon, agent: BotIcon },
}
