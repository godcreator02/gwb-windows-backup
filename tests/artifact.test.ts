import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 产物检查：装进 home 的是 dist 那份，源码这边看着对不算数。这个插件的产物分三部分：node 侧
 * 由 tsc 输出（index.js 一族），浏览器侧由 esbuild 打包（client.js），样式由 tailwindcss 输出（style.css）。
 * 分别检查三条规矩：相对 import 带 .js、包名 import 只有 node 内置模块、`electron` 与 `cordis`，样式的类名
 * 一律带本插件前缀且 var() 不带字面量 fallback。缺产物时整组跳过——`pnpm check` 不构建，发版前构建之后才真跑这组。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(here, '../dist')
const built =
  fs.existsSync(path.join(distDir, 'index.js')) &&
  fs.existsSync(path.join(distDir, 'client.js')) &&
  fs.existsSync(path.join(distDir, 'style.css'))

if (!built) console.warn('[gwb-windows-backup] dist/ 还没造出来，产物组跳过（pnpm build 之后再跑）')

const CLIENT = 'client.js'
/**
 * node 侧产物里允许出现的包名 import（除 `node:` 开头的内置模块外）：home 根上与运行环境里有的只有这两个。
 * 别的插件与词汇表包都只 import type，编译后整句消失
 */
const ALLOWED_BARE = new Set(['electron', 'cordis'])
/** 正则锚行首：字符串字面量里的 import 总带着缩进，顶格的才是真的顶层 import */
const RELATIVE = /^import\s+(?:[^'"]*from\s*)?['"](\.[^'"]*)['"]/gm
const BARE = /^import\s+(?:[^'"]*from\s*)?['"]([^'".][^'"]*)['"]/gm

const COMMAND_NAMES = [
  'windows-backup.run',
  'windows-backup.check',
  'windows-backup.status',
  'windows-backup.paths',
  'windows-backup.restic',
  'windows-backup.mark',
]

/** css 注释 */
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g
/**
 * 一条规则的选择器：`{` 之前那段。**只在这一段里找类**——全文搜 `.xxx` 会把声明值里的
 * 小数（`0.25rem` 的 `.25rem`）也当成类选择器
 */
const PRELUDE = /(?:^|[{};])([^{};]*)\{/g
/** 一个类选择器。转义序列（`.windowsbackup\:flex` 里那个 `\:`）算作类名的一部分 */
const CLASS_SELECTOR = /\.(?:\\.|[A-Za-z0-9_-])+/g
/** 唯一放行的非前缀类：`.dark` 是页面级亮暗标志，只以祖先身份出现 */
const DARK_FLAG = new Set(['.dark'])

function classSelectors(css: string): string[] {
  const found = new Set<string>()
  for (const rule of css.replaceAll(CSS_COMMENT, '').matchAll(PRELUDE)) {
    const prelude = rule[1]!.trim()
    if (prelude.startsWith('@')) continue
    for (const cls of prelude.matchAll(CLASS_SELECTOR)) found.add(cls[0])
  }
  return [...found]
}

/** 把 @property 与 @supports 的整块换成空白：这两类块是 tailwind 自己生成的，不参与字面量 fallback 检查 */
function blankMechanism(css: string): string {
  const chars = css.split('')
  for (const name of ['@property', '@supports']) {
    let at = css.indexOf(name)
    while (at !== -1) {
      const open = css.indexOf('{', at)
      if (open === -1) break
      let depth = 1
      let j = open + 1
      while (j < css.length && depth > 0) {
        const c = css[j] ?? ''
        if (c === '{') depth++
        else if (c === '}') depth--
        j++
      }
      for (let k = at; k < j; k++) if (chars[k] !== '\n') chars[k] = ' '
      at = css.indexOf(name, j)
    }
  }
  return chars.join('')
}

/** 每个 var() 调用的完整文本（按括号配对找到闭合括号，嵌套的各自也算一条） */
function varCalls(css: string): string[] {
  const out: string[] = []
  let i = css.indexOf('var(')
  while (i !== -1) {
    let depth = 0
    let end = -1
    for (let j = i; j < css.length; j++) {
      const c = css[j] ?? ''
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) {
        end = j
        break
      }
    }
    if (end === -1) break
    out.push(css.slice(i, end + 1))
    i = css.indexOf('var(', i + 4)
  }
  return out
}

/** 调用自己那层括号内的第一个逗号之后的内容——没有 fallback 时是 undefined */
function fallbackOf(call: string): string | undefined {
  let depth = 0
  for (let i = 0; i < call.length; i++) {
    const c = call[i] ?? ''
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 1) return call.slice(i + 1, -1).trim()
  }
  return undefined
}

/**
 * **字面量 fallback 检查**：本插件用到的 tailwind 出厂主题键，全部经外壳的 theme.reference.css
 * 换成页面上的主题令牌变量，`var(--x, 0.25rem)` 这类写死在本插件样式里的 fallback 应当一个都没有。
 * var() 的 fallback 是字面量就红——原因是升了主题令牌没重新构建、或有人手写了默认值，两种都不报错，
 * 但页面上主题令牌改了样式不动。放行：var() 引用、currentcolor、空。
 *
 * 唯一的例外：emerald 一族（成功色）。主题令牌里没有 `--success` 这个语义色（只有
 * destructive / warning），状态灯的绿是语义信息不能丢；带前缀时 tailwind 出厂调色板编译成本插件私有的
 * 变量加出厂值 fallback，不随主题变。这是已知缺口——主题令牌有了成功色那天，
 * 类名换成语义色、删掉这条放行。
 */
const BAKED_EMERALD = /^var\(--windowsbackup-color-emerald-\d+,/

function literalFallbacks(css: string): string[] {
  const bad: string[] = []
  for (const call of varCalls(blankMechanism(css.replaceAll(CSS_COMMENT, '')))) {
    const fallback = fallbackOf(call)
    if (fallback === undefined) continue
    if (fallback === '') continue
    if (fallback === 'currentcolor') continue
    if (BAKED_EMERALD.test(call)) continue
    if (fallback.replaceAll(/var\([^()]*\)/g, ' ').trim() === '') continue
    bad.push(call)
  }
  return bad
}

describe.skipIf(!built)('产物：node 侧', () => {
  const all = fs.readdirSync(distDir).filter((f) => f.endsWith('.js'))
  const nodeSideFiles = all.filter((f) => f !== CLIENT)
  const indexText = fs.readFileSync(path.join(distDir, 'index.js'), 'utf8')

  it('两侧产物都在——node 侧至少有 index.js，浏览器侧有 client.js，外加 style.css', () => {
    // node 侧＝所有 .js 减掉 client.js；以后拆出新文件也算在内
    expect(nodeSideFiles).toContain('index.js')
    expect(all).toContain(CLIENT)
    expect(fs.existsSync(path.join(distDir, 'style.css'))).toBe(true)
  })

  it('命令名六条一个不少', () => {
    for (const command of COMMAND_NAMES) expect(indexText).toContain(`'${command}'`)
  })

  it('包名 import 只许 node 内置模块、electron 与 cordis', () => {
    const bare = new Set<string>()
    for (const file of nodeSideFiles) {
      const text = fs.readFileSync(path.join(distDir, file), 'utf8')
      for (const m of text.matchAll(BARE)) {
        const spec = m[1]!
        if (!spec.startsWith('node:')) bare.add(spec)
      }
    }
    expect([...bare].filter((s) => !ALLOWED_BARE.has(s))).toEqual([])
  })

  it('相对 import 一律带 .js——产物给 node 直接加载，ESM 不做补全', () => {
    const bad: string[] = []
    for (const file of nodeSideFiles) {
      const text = fs.readFileSync(path.join(distDir, file), 'utf8')
      for (const m of text.matchAll(RELATIVE)) {
        if (!m[1]!.endsWith('.js')) bad.push(`${file}: ${m[1]!}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('插件名与注入清单在（cordis 按注入清单决定插件等不等待）', () => {
    expect(indexText).toContain("export const name = 'gwb-windows-backup'")
    expect(indexText).toContain("'gwbCommands'")
    expect(indexText).toContain("'gwbData'")
  })
})

describe.skipIf(!built)('产物：浏览器侧', () => {
  const text = fs.readFileSync(path.join(distDir, CLIENT), 'utf8')

  it('包名 import 只许内核包 importmap 里 react 的四个名字（用不到的不必出现，判子集）', () => {
    const specs = [...text.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '')
    const bare = specs.filter((spec) => !spec.startsWith('.'))
    const allowed = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']
    for (const spec of bare) expect(allowed).toContain(spec)
    expect(bare.length).toBeGreaterThan(0)
  })

  it('mountPane 导出在', () => {
    expect(text).toContain('mountPane')
  })

  it('轮询的那条命令名在', () => {
    expect(text).toContain('windows-backup.status')
  })
})

describe.skipIf(!built)('产物：样式', () => {
  const css = fs.readFileSync(path.join(distDir, 'style.css'), 'utf8')

  it('类选择器一律 .windowsbackup\\: 开头——靠前缀和别的插件的样式隔开', () => {
    const bad = classSelectors(css)
      .filter((s) => !s.startsWith('.windowsbackup\\:') && !DARK_FLAG.has(s))
      .sort()
    expect(bad).toEqual([])
  })

  it('没有 data-gwb-plugin——样式隔离只靠类名前缀，不依赖任何祖先元素', () => {
    expect(css).not.toContain('data-gwb-plugin')
  })

  it('var() fallback 不带字面量——主题值整页一份，由主题令牌提供', () => {
    expect(literalFallbacks(css).sort()).toEqual([])
  })
})
