import { defineConfig } from 'vitest/config'

/**
 * 一仓一包一插件：测试只认仓根的 `tests/`，`src/` 里不放用例。
 *
 * 「slow」标签（vitest 4.1+）：**凡真起子进程的用例必打标**（比如真跑 restic 的那种）。
 * 日常 `pnpm test` 用 `--tags-filter=!slow` 跳过。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.{spec,test}.{ts,tsx}'],
    testTimeout: 20_000,
    fileParallelism: false,
    tags: [
      {
        name: 'slow',
        description: '真起子进程的用例（真 restic / 真构建）',
        timeout: 300_000,
      },
    ],
  },
})
