import { defineConfig } from 'vitest/config'

/** 测试只在本包的 `tests/` 里。真启动子进程的用例（真跑 restic 那种）打 `slow` 标签，日常 `pnpm test` 跳过。 */
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
