import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import postcss, { type Rule } from 'postcss'
import tailwind from '@tailwindcss/postcss'

/**
 * 件的样式表构建：Tailwind 4 扫件的 src，出一张只含工具类的表，
 * 整张 scope 到 `[data-gwb-plugin="<完整包名>"]`，落 `dist/style.css`。
 *
 * 件的作者不写 Tailwind 入口——输入 css 由这里拼（见 styleInput）。
 * 正本在基础件仓的 `tools/build-styles.ts`（独立仓各带一份，只差 repoRoot 的算法，
 * 别的改动两边同步）。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..')
const require = createRequire(import.meta.url)

/** css 字符串里的路径统一正斜杠：Windows 的反斜杠在 @import 里会被当转义 */
const slash = (p: string): string => p.replaceAll('\\', '/')

/** at-rule 底下的「规则」不是选择器，别去动它们 */
const NOT_SELECTOR = new Set(['keyframes', '-webkit-keyframes', 'font-face', 'property', 'counter-style', 'page'])

/**
 * 文档根那一族词头：只换词头、不加前缀。
 * 判的是「第一个复合选择器以它起头」而不是整串相等——整串相等的话 `:root.dark` 会被
 * 加成 `:where(scope) :root.dark`，而文档根不可能是 scope 的后代，那条规则从此静默永不匹配。
 */
const ROOT_LIKE = /^(:root|html|body)(?=[.:[\s>+~]|$)/

/**
 * 把一条选择器包进 scope。前缀用 `:where(…)`——**特异性为零**，件的表与页面那张表
 * 同名类规则谁后注谁赢，不靠优先级打架。
 */
function scopeSelector(sel: string, scope: string): string {
  if (ROOT_LIKE.test(sel)) return sel.replace(ROOT_LIKE, scope)
  return `${scope} ${sel}`
}

function inNonSelectorAtRule(rule: Rule): boolean {
  for (let p = rule.parent; p !== undefined; p = p?.parent) {
    if (p?.type === 'atrule' && NOT_SELECTOR.has((p as { name: string }).name.toLowerCase())) return true
    if (p?.type === 'root') return false
  }
  return false
}

/** 件的包目录 → 它的完整包名。scope 名用完整包名，短名不保证跨件唯一 */
function packageName(pkgDir: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { name?: string }
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error(`${pkgDir} 的 package.json 没有 name，算不出 scope`)
  }
  return manifest.name
}

/**
 * 拼给 Tailwind 吃的输入。四行各有各的必要：
 * - 前两行 `theme(reference)`：让类名解析得出来（`bg-primary` → `var(--primary)`），
 *   但**一个变量声明都不输出**——值在运行时取页面那张表的
 * - 只引 utilities，**不引 preflight**：preflight 全局一份，归令牌包那张表
 * - `source(none)` 关掉自动扫描，只认下面那条显式 @source；否则会把 dist/ 里的产物
 *   也扫进来，凭空多出一堆没人用的类，而且不报错
 */
function styleInput(pkgDir: string): string {
  const reference = require.resolve('@team/gwb-tokens/theme.reference.css')
  const lines = [
    `@import 'tailwindcss/theme' theme(reference);`,
    `@import '${slash(reference)}' theme(reference);`,
    `@import 'tailwindcss/utilities' layer(utilities) source(none);`,
    `@source "${slash(path.join(pkgDir, 'src'))}";`,
  ]
  // 件自己的规则追在末尾。这个文件也是 components.json 的 tailwind.css——shadcn CLI
  // 要求那个字段指一个真实路径，正好让件作者有个地方写自己的 css
  const own = path.join(pkgDir, 'src', 'client', 'styles.css')
  if (fs.existsSync(own)) lines.push(`@import '${slash(own)}';`)
  return lines.join('\n')
}

export async function buildStyles(pkgDir: string): Promise<{ scope: string; bytes: number }> {
  const scope = packageName(pkgDir)
  const srcDir = path.join(pkgDir, 'src')
  if (!fs.existsSync(srcDir)) throw new Error(`${pkgDir} 没有 src/，没什么可扫的`)

  // from 落在仓根：Tailwind 据它解析 `tailwindcss/*` 那两个裸名（件自己没装 tailwindcss
  // 的话，那两个裸名就吃它 devDependencies 里的）。扫描基准另给 base，指着件的包目录
  const compiled = await postcss([tailwind({ base: pkgDir, optimize: false })]).process(styleInput(pkgDir), {
    from: path.join(repoRoot, '__gwb_style_input__.css'),
  })

  const scoped = postcss.parse(compiled.css)
  const prefix = `:where([data-gwb-plugin="${scope}"])`
  scoped.walkRules((rule) => {
    if (inNonSelectorAtRule(rule)) return
    rule.selectors = rule.selectors.map((s) => scopeSelector(s, prefix))
  })

  const head = `/* 由 tools/build-styles.ts 生成：${scope} 的工具类表，整张 scope 在 ${prefix} 之下。改样式改源码重新构建，别手改这份 */\n`
  const outFile = path.join(pkgDir, 'dist', 'style.css')
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  const text = head + scoped.toString()
  fs.writeFileSync(outFile, text, 'utf8')
  return { scope, bytes: Buffer.byteLength(text, 'utf8') }
}

// 直接跑时：拿 cwd 当件的包目录（件的 build 脚本在自己的目录里调它）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { scope, bytes } = await buildStyles(process.cwd())
  console.log(`[styles] dist/style.css ← ${scope}（${bytes.toLocaleString()} 字节）`)
}
