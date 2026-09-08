import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 产物守卫：装进 home 的是 dist 那份，源码这边看着对不算数。三条硬要求——
 * node 半产物给宿主直接加载（相对 import 必须带 .js、裸名只许 node:*）；
 * client 半裸名只许四个共享 react 名（importmap 只认它们）；style.css 带 scope。
 * dist 不在（没 build）就整组跳过——`pnpm check` 不构建，构建后的验证靠发布前的 build。
 */

const dist = 'dist'
const built =
  existsSync(`${dist}/index.js`) && existsSync(`${dist}/client.js`) && existsSync(`${dist}/style.css`)

const COMMAND_NAMES = [
  'windows-backup.run',
  'windows-backup.check',
  'windows-backup.status',
  'windows-backup.paths',
  'windows-backup.restic',
  'windows-backup.mark',
]

describe.skipIf(!built)('产物：node 半', () => {
  const text = readFileSync(`${dist}/index.js`, 'utf8')

  it('命令名六条一个不少', () => {
    for (const command of COMMAND_NAMES) expect(text).toContain(`'${command}'`)
  })

  it('裸名 import 只许 node:* 与词汇表包（真运行时取值 isRecord，它是硬 peer）', () => {
    const specs = [...text.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '')
    const bare = specs.filter((spec) => !spec.startsWith('.') && !spec.startsWith('node:'))
    expect(bare).toEqual(['@godcreator02/gwb-plugin-api'])
  })

  it('相对 import 一律带 .js', () => {
    const specs = [...text.matchAll(/from\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1] ?? '')
    expect(specs.length).toBeGreaterThan(0)
    for (const spec of specs) expect(spec.endsWith('.js')).toBe(true)
  })

  it('插件名与注入清单在（挂载等待语义的锚）', () => {
    expect(text).toContain("export const name = 'gwb-windows-backup'")
    expect(text).toContain("'gwbCommands'")
    expect(text).toContain("'gwbData'")
  })
})

describe.skipIf(!built)('产物：client 半', () => {
  const text = readFileSync(`${dist}/client.js`, 'utf8')

  it('裸名 import 只许四个共享 react 名（用不到的不必出现，判子集）', () => {
    const specs = [...text.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '')
    const bare = specs.filter((spec) => !spec.startsWith('.'))
    const allowed = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']
    for (const spec of bare) expect(allowed).toContain(spec)
    expect(bare.length).toBeGreaterThan(0)
  })

  it('mountPane 与 mountCell 两个导出都在', () => {
    expect(text).toContain('mountPane')
    expect(text).toContain('mountCell')
  })

  it('轮询的那条命令名在', () => {
    expect(text).toContain('windows-backup.status')
  })
})

describe.skipIf(!built)('产物：样式', () => {
  const text = readFileSync(`${dist}/style.css`, 'utf8')

  it('整张 scope 在完整包名之下', () => {
    expect(text).toContain(':where([data-gwb-plugin="@godcreator02/gwb-windows-backup"])')
  })
})
