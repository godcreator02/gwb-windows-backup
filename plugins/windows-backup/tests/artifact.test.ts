import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 产物里本插件自己的约定：命令名、插件名与注入清单、浏览器侧入口与它轮询的命令。
 * 包名 import、相对 import、样式前缀与颜色令牌这些通用规矩由 devkit 查（`devkit.dev` 构建之后、`devkit.release` 发之前）。
 * 缺产物时整组跳过——`pnpm check` 不构建，`pnpm build` 之后才真跑这组。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(here, '../dist')
const built = fs.existsSync(path.join(distDir, 'index.js')) && fs.existsSync(path.join(distDir, 'client.js'))

if (!built) console.warn('[gwb-windows-backup] dist/ 还没构建，产物组跳过（pnpm build 之后再跑）')

const COMMAND_NAMES = [
  'windows-backup.run',
  'windows-backup.check',
  'windows-backup.status',
  'windows-backup.paths',
  'windows-backup.restic',
  'windows-backup.mark',
]

describe.skipIf(!built)('产物：node 侧', () => {
  const indexText = fs.readFileSync(path.join(distDir, 'index.js'), 'utf8')

  it('命令名六条一个不少', () => {
    for (const command of COMMAND_NAMES) expect(indexText).toContain(`'${command}'`)
  })

  it('插件名与注入清单在（cordis 按注入清单决定插件等不等待）', () => {
    expect(indexText).toContain("export const name = 'gwb-windows-backup'")
    expect(indexText).toContain("'gwbCommands'")
    expect(indexText).toContain("'gwbData'")
  })
})

describe.skipIf(!built)('产物：浏览器侧', () => {
  const text = fs.readFileSync(path.join(distDir, 'client.js'), 'utf8')

  it('mountPane 导出在', () => {
    expect(text).toContain('mountPane')
  })

  it('轮询的那条命令名在', () => {
    expect(text).toContain('windows-backup.status')
  })
})
