import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * 浏览器侧打包。react 的四个包名**不打包**——页面的 importmap 把它们解析到同一份 react，各插件共用一个实例；
 * 其余依赖一律**打进 client.js**：本插件的浏览器侧只用到 react，没有别的包名 import。
 */

const here = path.dirname(fileURLToPath(import.meta.url))

/** 这四个名字由内核包 `@godcreator/gwb-kernel-desktop` 提供，跟它 package.json 里的 gwb.shared 一一对应 */
const SHARED = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'dist/client.js',
  external: SHARED,
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
