/**
 * 数据目录内的布局。
 *
 * 数据目录由宿主给出（`ctx.gwbData.dir`，即 `<home>/data/<条目 id 末段>`）——这就是老仓
 * 说的「格」。全部用户私有数据住格里，代码树里一个字节的用户数据都没有；隔离 home 有
 * 自己的数据目录，开发时碰不到真凭据。
 *
 * 与老仓的差别：老仓自己从 `GOD_DATA_ROOT` 环境变量解析数据根（那扇门留给不认识宿主的
 * CLI），新线宿主层直接把目录递进来，这一层只管往下摊路径。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 目录内布局（全绝对路径）。 */
export type BackupPaths = {
  /** 数据目录本尊，`<home>/data/<条目 id>`。 */
  dir: string
  stateFile: string
  /** 进行中的备份那把锁（`{ pid, startedAt }`），跑完即删。见 `lock.ts`。 */
  lockFile: string
  credentialsDir: string
  /** restic `--password-file` 指的那份，内容任何时候都不读进本进程。 */
  passwordFile: string
  ossCredentialsFile: string
  /** 用户覆盖版 exclude；不存在时回落 `defaultExcludeFile`。 */
  userExcludeFile: string
  /** 插件自带默认 exclude，住代码树 `config/` 里、跟着版本走。 */
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
    userExcludeFile: path.join(dir, 'restic-exclude.txt'),
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
 * 包根的绝对路径——`config/` 从这里往下算。
 *
 * 一层 `..` 在两种形态下都对：源码态本文件住 `<包根>/src/paths.ts`；产物态它被编译进
 * `<包根>/dist/index.js`，`import.meta.url` 的目录是 `<包根>/dist`。
 */
export function pluginRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}
