/**
 * 讲解组件与接缝图用的线条图标：24×24 的描边图形，颜色取 currentColor。
 * 接缝图（SeamDiagram）把 className、x、y、width、height、strokeWidth 原样传进来，所以这里只给默认值、不拦任何属性。
 * 站自己画一小套，不为几个图标加一个图标库依赖。
 */
import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function glyph(name: string, shapes: ReactNode) {
  function Icon({ size = 16, ...rest }: IconProps) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
        {shapes}
      </svg>
    )
  }
  Icon.displayName = name
  return Icon
}

export const PuzzleIcon = glyph('PuzzleIcon', <path d="M4 7h4a2 2 0 1 1 4 0h4v4a2 2 0 1 1 0 4v4h-4a2 2 0 1 0-4 0H4v-4a2 2 0 1 0 0-4z" />)
export const LayersIcon = glyph('LayersIcon', <><path d="M12 3 3 8l9 5 9-5z" /><path d="m3 13 9 5 9-5" /></>)
export const GlobeIcon = glyph('GlobeIcon', <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" /></>)
export const FolderIcon = glyph('FolderIcon', <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />)
export const FileIcon = glyph('FileIcon', <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>)
export const TerminalIcon = glyph('TerminalIcon', <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3" /><path d="M12 15h5" /></>)
export const BotIcon = glyph('BotIcon', <><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 4v4" /><circle cx="9" cy="14" r="1" /><circle cx="15" cy="14" r="1" /></>)
export const UserIcon = glyph('UserIcon', <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>)
export const BookIcon = glyph('BookIcon', <><path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2z" /><path d="M4 19V5" /></>)
export const DatabaseIcon = glyph('DatabaseIcon', <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>)
export const BlocksIcon = glyph('BlocksIcon', <><rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="8" rx="1" /><rect x="3" y="13" width="8" height="8" rx="1" /><rect x="13" y="13" width="8" height="8" rx="1" /></>)
export const TagIcon = glyph('TagIcon', <><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" /><circle cx="8" cy="8" r="1.5" /></>)
export const WandIcon = glyph('WandIcon', <><path d="m4 20 12-12" /><path d="m14 4 1-2 1 2 2 1-2 1-1 2-1-2-2-1z" /></>)
export const SearchIcon = glyph('SearchIcon', <><circle cx="11" cy="11" r="7" /><path d="m21 21-5-5" /></>)
export const CheckIcon = glyph('CheckIcon', <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m8 12 3 3 5-6" /></>)
export const ShieldIcon = glyph('ShieldIcon', <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />)
export const CogIcon = glyph('CogIcon', <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></>)
export const LinkIcon = glyph('LinkIcon', <><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1" /><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1" /></>)
export const PanelIcon = glyph('PanelIcon', <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>)
export const DownloadIcon = glyph('DownloadIcon', <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 21h16" /></>)
export const ImageIcon = glyph('ImageIcon', <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></>)
export const ListIcon = glyph('ListIcon', <><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></>)
export const PackageIcon = glyph('PackageIcon', <><path d="M3 7 12 3l9 4v10l-9 4-9-4z" /><path d="m3 7 9 4 9-4" /><path d="M12 11v10" /></>)
