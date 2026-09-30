import type { BackupConfig } from '../src/config.js'
import { SETTINGS } from '../src/config.js'
import type { Logger } from '../src/log.js'

/** 一个什么都不写的 logger。 */
export function nullLogger(): Logger {
  return { file: '', line: () => {}, raw: () => {}, rotate: () => {} }
}

/** 全部取声明时的默认值，再叠上 `over`。 */
export function configOf(over: Partial<BackupConfig> = {}): BackupConfig {
  const defaults = Object.fromEntries(SETTINGS.map((spec) => [spec.field, spec.default])) as BackupConfig
  return { ...defaults, ...over }
}
