/**
 * 全局接缝图（system.data.mjs）的坐标与图标。从上往下：工作台的五个服务、本插件、数据目录与两个外部程序、两个 restic 仓库。
 * 上下两排的能力对齐成一列，1–5 都是一条竖线；6 在插件下面沿 y=300 分到四个文件；9 从健康结论绕过数据目录右边接本地仓库。
 * 6 只从六条命令与每分钟一跳画线，一轮备份与健康结论那一端固定高亮时照样亮。
 */
import { cap } from '@godcreator/docfirst-explainer'
import type { SeamLayout } from '@godcreator/docfirst-explainer'
import { BotIcon, DatabaseIcon, FolderIcon, LayersIcon, PackageIcon, TerminalIcon, UserIcon } from '../icons'

export const systemLayout: SeamLayout = {
  view: { w: 1200, h: 590 },
  caps: {
    shell: cap(154, 52, 190),
    cmdbus: cap(354, 52, 190),
    'settings-svc': cap(554, 52, 190),
    timer: cap(754, 52, 190),
    'data-svc': cap(954, 52, 212),

    pane: cap(154, 202, 160),
    cmds: cap(324, 202, 160),
    settings: cap(494, 202, 160),
    tick: cap(664, 202, 160),
    health: cap(834, 202, 160),
    round: cap(1004, 202, 162),

    'f-lock': cap(154, 352, 140),
    'f-state': cap(304, 352, 140),
    'f-cred': cap(454, 352, 140),
    'f-log': cap(604, 352, 142),
    'restic-exe': cap(800, 352, 170),
    ps: cap(996, 352, 170),

    local: cap(574, 502, 290),
    oss: cap(874, 502, 292),
  },
  groups: {
    workbench: { x: 140, y: 20, w: 1040, h: 94 },
    plugin: { x: 140, y: 170, w: 1040, h: 94 },
    datadir: { x: 140, y: 320, w: 620, h: 94 },
    restic: null,
    powershell: null,
    repos: { x: 560, y: 470, w: 620, h: 94 },
  },
  seamPaths: {
    '1': { d: 'M449,100 V202', badge: [449, 150] },
    '2': { d: 'M234,100 V202', badge: [234, 150] },
    '3': { d: 'M600,100 V202', badge: [600, 150] },
    '4': { d: 'M790,100 V202', badge: [790, 150] },
    '5': { d: 'M1085,100 V202', badge: [1085, 150] },
    '6': { d: 'M400,250 V300 M700,250 V300 M224,300 H700 M224,300 V352 M374,300 V352 M524,300 V352 M675,300 V352', badge: [470, 300] },
    '7': { d: 'M880,250 V352 M1020,250 V310 H950 V352', badge: [880, 300] },
    '8': { d: 'M1120,250 V352', badge: [1120, 300] },
    '9': { d: 'M850,250 V290 H780 V502', badge: [780, 440] },
    '10': { d: 'M830,400 V502 M930,400 V502', badge: [930, 450] },
  },
  entries: {
    agent: { box: { x: 20, y: 56, w: 100, h: 40 }, arrow: [120, 76, 140, 76] },
    person: { box: { x: 20, y: 206, w: 100, h: 40 }, arrow: [120, 226, 140, 226] },
  },
  moduleIcons: {
    workbench: LayersIcon,
    plugin: PackageIcon,
    datadir: FolderIcon,
    restic: TerminalIcon,
    powershell: TerminalIcon,
    repos: DatabaseIcon,
  },
  entryIcons: { agent: BotIcon, person: UserIcon },
}
