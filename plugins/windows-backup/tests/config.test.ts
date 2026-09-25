import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FLAT,
  flatToConfig,
  pickFlat,
  resolveSlotPath,
  splitSources,
  toExcludeList,
  toSourceList,
} from '../src/config.js'

describe('pickFlat', () => {
  it('空值吃全套默认', () => {
    expect(pickFlat(undefined)).toEqual(DEFAULT_FLAT)
    expect(pickFlat('不是一个对象')).toEqual(DEFAULT_FLAT)
    expect(pickFlat(null)).toEqual(DEFAULT_FLAT)
  })

  it('类型不对的一律吃默认', () => {
    const flat = pickFlat({ sources: 123, ossEnabled: 'yes', frequencyMinutes: '30' })
    expect(flat.sources).toEqual([])
    expect(flat.ossEnabled).toBe(false)
    expect(flat.frequencyMinutes).toBe(30)
  })

  it('非正数退回默认，不悄悄夹到边界', () => {
    expect(pickFlat({ frequencyMinutes: 0 }).frequencyMinutes).toBe(30)
    expect(pickFlat({ frequencyMinutes: -5 }).frequencyMinutes).toBe(30)
    expect(pickFlat({ healthCheckIntervalHours: 0 }).healthCheckIntervalHours).toBe(8)
    expect(pickFlat({ keepWeekly: 0 }).keepWeekly).toBe(8)
    expect(pickFlat({ gomaxprocs: 0 }).gomaxprocs).toBe(1)
    expect(pickFlat({ reviewIntervalDays: 0 }).reviewIntervalDays).toBe(7)
  })

  it('合法值原样过（sources 是数组）', () => {
    const flat = pickFlat({ sources: ['D:/Notes', ' D:/Projects '], localRepo: 'D:/Backup/restic-repo', frequencyMinutes: 15, reviewIntervalDays: 14 })
    expect(flat.sources).toEqual(['D:/Notes', 'D:/Projects'])
    expect(flat.localRepo).toBe('D:/Backup/restic-repo')
    expect(flat.frequencyMinutes).toBe(15)
    expect(flat.reviewIntervalDays).toBe(14)
  })
})

describe('splitSources / toSourceList', () => {
  it('分号切开、去空白、去空项', () => {
    expect(splitSources('D:/Notes; ;D:/Projects ')).toEqual(['D:/Notes', 'D:/Projects'])
    expect(splitSources('')).toEqual([])
    expect(splitSources(';;;')).toEqual([])
  })

  it('legacy 的分号串也收得下——旧版设置搬过来的值不用先迁', () => {
    expect(toSourceList('D:/A; ;D:/B')).toEqual(['D:/A', 'D:/B'])
  })

  it('数组逐条 trim 去空，非字符串项丢弃；别的形状吃空表', () => {
    expect(toSourceList([' D:/A ', '', 42, 'D:/B'])).toEqual(['D:/A', 'D:/B'])
    expect(toSourceList(undefined)).toEqual([])
    expect(toSourceList({})).toEqual([])
  })

  it('toExcludeList 收窄：注释行留着、空行去掉、legacy 分号串也认', () => {
    expect(toExcludeList(['# 分区', ' *.tmp ', '', 42, '.venv'])).toEqual(['# 分区', '*.tmp', '.venv'])
    expect(toExcludeList('a;b')).toEqual(['a', 'b'])
    expect(toExcludeList(undefined)).toEqual([])
  })
})

describe('flatToConfig', () => {
  it('sources（数组或 legacy 串）进嵌套形状都是数组，oss 四格归位', () => {
    const config = flatToConfig({ sources: ['D:/A', 'D:/B'], ossEnabled: true, ossBucket: 'b', ossEndpoint: 'e', ossRepoPath: 'p' })
    expect(config.sources).toEqual(['D:/A', 'D:/B'])
    expect(config.repositories.oss).toEqual({ enabled: true, bucket: 'b', repoPath: 'p', endpoint: 'e' })
    expect(config.repositories.local.repo).toBe('')
    expect(config.schedule.frequencyMinutes).toBe(30)
    expect(config.retention).toEqual({ keepWithin: '72h', keepWithinDaily: '14d', keepWeekly: 8, keepMonthly: 12 })
    expect(config.reviewIntervalDays).toBe(7)

    const legacy = flatToConfig({ sources: 'D:/A;D:/B' })
    expect(legacy.sources).toEqual(['D:/A', 'D:/B'])
  })

  it('日志轮转的固定值跟着走（不上设置表）', () => {
    const config = flatToConfig({})
    expect(config.logging).toEqual({ rotateWhenBytes: 10_485_760, keepLastLines: 1000 })
  })
})

describe('resolveSlotPath', () => {
  it('绝对路径原样（规范化）', () => {
    expect(resolveSlotPath('D:/Backup/restic-repo', 'C:/slot')).toMatch(/[\\/]Backup[\\/]restic-repo$/)
  })

  it('相对路径按格拼', () => {
    const resolved = resolveSlotPath('bin/restic.exe', 'C:/slot')
    expect(resolved).toMatch(/slot[\\/]bin[\\/]restic\.exe$/)
  })

  it('空串回空串', () => {
    expect(resolveSlotPath('', 'C:/slot')).toBe('')
    expect(resolveSlotPath('  ', 'C:/slot')).toBe('')
  })
})
