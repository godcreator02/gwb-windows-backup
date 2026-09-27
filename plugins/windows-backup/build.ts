import { browserImports } from '@godcreator/gwb-shell/browser-imports'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * 浏览器侧打包（node 侧由 tsc 逐个文件输出，见 tsconfig.build.json）。页面 importmap 里的名字不打包，
 * 其余依赖一律打进 client.js。
 */
const here = path.dirname(fileURLToPath(import.meta.url))

// 浏览器模块名与 shell 运行时登记复用同一个代码出口。


// 上一次构建留下的文件会随 files 白名单一起发出去，先清空
fs.rmSync(path.join(here, 'dist'), { recursive: true, force: true })

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'dist/client.js',
  external: Object.keys(browserImports()),
  absWorkingDir: here,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  bundle: true,
  minify: false,
  legalComments: 'none',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})

console.log('[gwb-windows-backup] dist/client.js ← src/client/index.tsx')
