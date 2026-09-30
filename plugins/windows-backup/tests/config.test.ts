import { describe, expect, it } from 'vitest'
import { readConfig, refuseReason, resolveResticExe, SETTINGS } from '../src/config.js'
import { configOf } from './helpers.js'

/** 模拟设置插件的 `get`：没设过的项回声明时的默认值。 */
const settingsWith = (values: Record<string, unknown>) => (key: string): unknown =>
  key in values ? values[key] : SETTINGS.find((spec) => spec.key === key)?.default

describe('readConfig', () => {
  it('全用默认值 → 读得出，字段名是设置键的 camelCase', () => {
    const config = readConfig(settingsWith({}))
    expect(config.frequencyMinutes).toBe(30)
    expect(config.sources).toEqual([])
    expect(config.ossRepoPath).toBe('restic-prod')
    expect(config.resticExe).toBe('bin/restic.exe')
  })

  it('列表逐行去首尾空白、去空行', () => {
    const config = readConfig(settingsWith({ sources: [' D:/A ', '', 'D:/B'], exclude: ['# 注释', '  ', '*.tmp'] }))
    expect(config.sources).toEqual(['D:/A', 'D:/B'])
    expect(config.exclude).toEqual(['# 注释', '*.tmp'])
  })

  it('值不合法就抛错，一次列出全部不合法的键，不换成默认值', () => {
    expect(() => readConfig(settingsWith({ 'frequency-minutes': 0, sources: 'D:/A;D:/B', 'oss-enabled': 'yes' }))).toThrow(
      /`sources` 要是字符串数组.*`oss-enabled` 要是 true 或 false.*`frequency-minutes` 要是不小于 1 的数，现在是 0/,
    )
  })

  it('整数项不收小数；保留份数可以是 0', () => {
    expect(() => readConfig(settingsWith({ gomaxprocs: 1.5 }))).toThrow(/`gomaxprocs` 要是整数/)
    expect(readConfig(settingsWith({ 'keep-weekly': 0 })).keepWeekly).toBe(0)
  })

  it('必填的字符串项不许是空串', () => {
    expect(() => readConfig(settingsWith({ 'restic-exe': '  ' }))).toThrow(/`restic-exe` 不能是空的/)
  })
})

describe('refuseReason', () => {
  it('sources 空 → 拒跑并指路', () => {
    expect(refuseReason(configOf({ localRepo: 'D:/r' }))).toContain('sources')
  })

  it('localRepo 空 → 拒跑', () => {
    expect(refuseReason(configOf({ sources: ['D:/A'] }))).toContain('local-repo')
  })

  it('OSS 开着缺 bucket / endpoint → 拒跑', () => {
    expect(refuseReason(configOf({ sources: ['D:/A'], localRepo: 'D:/r', ossEnabled: true }))).toContain('oss-bucket')
  })

  it('配齐了 → null', () => {
    const ready = { sources: ['D:/A'], localRepo: 'D:/r' }
    expect(refuseReason(configOf(ready))).toBeNull()
    expect(refuseReason(configOf({ ...ready, ossEnabled: true, ossBucket: 'b', ossEndpoint: 'e' }))).toBeNull()
  })
})

describe('resolveResticExe', () => {
  it('绝对路径原样（规范化）', () => {
    expect(resolveResticExe('D:/tools/restic.exe', 'C:/data')).toMatch(/^D:[\\/]tools[\\/]restic\.exe$/)
  })

  it('相对路径按数据目录拼', () => {
    expect(resolveResticExe('bin/restic.exe', 'C:/data')).toMatch(/data[\\/]bin[\\/]restic\.exe$/)
  })
})
