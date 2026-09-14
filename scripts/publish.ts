import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 把这个包发到本机 registry（Verdaccio）。两条路，同一份分发逻辑：
 *
 * ```powershell
 * pnpm publish:dev       # 开发版：<patch+1>-dev.<到分钟的时间戳>，打 dev 标
 * pnpm publish:release   # 正式版：package.json 里的号原样发，打 latest
 * ```
 *
 * **开发版不动 latest**：本机 registry 上的包同时被别的 home 消费，开发版顶掉 latest
 * 会让它们莫名其妙换了代码。所以装开发版时版本号得写全——脚本把现成的命令打出来。
 *
 * **同一个版本号永不重发**：发之前先 `pnpm view <包>@<号> version` 问一声，已经在
 * registry 上就当场拒。
 *
 * **不改仓里的 package.json**：做法是在临时目录里摆一份分发形态的包（产物 + README +
 * 去掉 scripts/devDependencies 的清单）从那儿发。分发清单去掉 `scripts` 是因为
 * `prepublishOnly` 会在发布目录里跑一次 `pnpm run build`，临时目录里没有 src、没有
 * node_modules，当场就炸。
 *
 * **registry 地址由这儿显式传**，不写进 package.json 的 `publishConfig`。
 *
 * 子进程一律带超时：构建或发布卡在网络上时，没有超时就是无限期挂着。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = process.env.GWB_DEV_REGISTRY ?? 'https://git.tianshen02.online:28377/api/packages/godcreator/npm/'
const BUILD_TIMEOUT_MS = 300_000
const PUBLISH_TIMEOUT_MS = 180_000
const VIEW_TIMEOUT_MS = 60_000

/** 正式版走 latest，开发版走 dev——标是「装的人不写版本号时拿到哪一版」 */
const release = process.argv.slice(2).includes('--release')
const label = release ? 'publish:release' : 'publish:dev'

interface Manifest {
  name: string
  version: string
  files?: string[]
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

function fail(message: string): never {
  console.error(`[${label}] ${message}`)
  process.exit(1)
}

/** `<patch+1>-dev.<yyyyMMddHHmm>`。时间戳到分钟，同一分钟内重发会撞版本号，那时改一行再来 */
function devVersion(version: string): string {
  const [major = '0', minor = '0', patch = '0'] = version.split('.')
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${String(d.getFullYear())}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`
  return `${major}.${minor}.${String(Number(patch) + 1)}-dev.${stamp}`
}

/** 这个号在 registry 上有没有。有回那个号，没有或问不出来回 undefined。 */
function publishedVersion(spec: string): string | undefined {
  try {
    return execFileSync('pnpm', ['view', spec, 'version', '--registry', REGISTRY], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
      timeout: VIEW_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return undefined
  }
}

const manifestPath = path.join(repoRoot, 'package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest
const version = release ? manifest.version : devVersion(manifest.version)
const spec = `${manifest.name}@${version}`
const tag = release ? 'latest' : 'dev'

const already = publishedVersion(spec)
if (already !== undefined) {
  fail(
    `${spec} 已经在 registry 上了（${already}），同一个版本号不重发。` +
      (release ? '要发新的一版就先抬 package.json 里的号。' : '同一分钟内发了两次的话，等一分钟再来。'),
  )
}

console.log(`[${label}] 构建 ${spec}`)
execFileSync('pnpm', ['run', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: true,
  timeout: BUILD_TIMEOUT_MS,
})

/**
 * 要带进分发包的东西**取自 `files` 白名单**，不在这儿另列一份——两份名单必然漂。
 */
const artifacts = (manifest.files ?? []).map((rel) => ({ rel, abs: path.join(repoRoot, rel) }))
if (artifacts.length === 0) fail('package.json 的 files 是空的，不知道该带什么进分发包')
for (const f of artifacts) {
  if (!fs.existsSync(f.abs)) fail(`构建完还是没有产物：${f.abs}`)
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-windows-backup-pub-'))
try {
  for (const f of artifacts) {
    const dest = path.join(stage, f.rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    // **`cpSync` 而不是 `copyFileSync`**：`files` 里可以是目录（`config/` 就是），而
    // `copyFileSync` 撞上目录回的是 `EPERM`——那句错一个字都不提「你拷的是个目录」
    fs.cpSync(f.abs, dest, { recursive: true })
  }
  const readme = path.join(repoRoot, 'README.md')
  if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(stage, 'README.md'))

  const dist: Manifest = { ...manifest, version }
  delete dist.scripts
  delete dist.devDependencies
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(dist, null, 2) + '\n')

  execFileSync('pnpm', ['publish', '--no-git-checks', '--tag', tag, '--registry', REGISTRY], {
    cwd: stage,
    stdio: 'inherit',
    shell: true,
    timeout: PUBLISH_TIMEOUT_MS,
  })
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}

console.log(`\n[${label}] 发好了：${spec}（标 ${tag}）`)
console.log('\n装进隔离 home（gwb-test：一次验证一个新 home，别拿 default 验）：')
console.log(`  $env:GWB_HOME = 'windows-backup-<yyMMddHHmm>'`)
console.log(`  cd $env:APPDATA\\gwb-kernel\\homes\\<那个名>`)
console.log(`  pnpm add ${spec} @cordisjs/plugin-timer`)
console.log('  再往 cordis.yml 手写两条条目：id: windows-backup 与 id: timer（name @cordisjs/plugin-timer；')
console.log('  timer 缺了本件整个挂起等它——宁挂起，不静默不备份）')
