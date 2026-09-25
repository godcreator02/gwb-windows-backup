import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 数据目录内的布局（全绝对路径）。 */
export type BackupPaths = {
  /** 数据目录本身，`<home>/data/<条目 id>`，由宿主的 `ctx.gwbData.dir` 给出。 */
  dir: string
  stateFile: string
  /** 进行中的备份那把锁，跑完即删。见 `lock.ts`。 */
  lockFile: string
  credentialsDir: string
  /** restic `--password-file` 指的那份，内容任何时候都不读进本进程。 */
  passwordFile: string
  ossCredentialsFile: string
  /** 内置基线 exclude，在插件包的 `config/` 里、跟着版本走；用户的追加规则走设置键 `exclude`。 */
  defaultExcludeFile: string
  binDir: string
  logsDir: string
  logFile: string
}

/** 由数据目录摊开全部路径。只算路径，目录的创建归调用方。 */
export function layout(dir: string): BackupPaths {
  const credentialsDir = path.join(dir, 'credentials')
  const logsDir = path.join(dir, 'logs')
  return {
    dir,
    stateFile: path.join(dir, 'state.json'),
    lockFile: path.join(dir, 'backup.lock'),
    credentialsDir,
    passwordFile: path.join(credentialsDir, 'restic-password.txt'),
    ossCredentialsFile: path.join(credentialsDir, 'oss-credentials.txt'),
    defaultExcludeFile: defaultExcludeFile(),
    binDir: path.join(dir, 'bin'),
    logsDir,
    logFile: path.join(logsDir, 'restic-backup.log'),
  }
}

/** 插件自带那份默认 exclude 的绝对路径——从本文件位置算，不依赖 cwd。 */
export function defaultExcludeFile(): string {
  return path.resolve(pluginRoot(), 'config', 'restic-exclude.txt')
}

/**
 * 插件包根的绝对路径。一层 `..` 在两种形态下都对：源码在 `<包根>/src/paths.ts`，
 * 构建产物在 `<包根>/dist/paths.js`。
 */
export function pluginRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}
