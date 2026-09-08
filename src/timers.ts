/**
 * 宿主里的周期定时器——挂在 fiber 生死上的 setInterval/setTimeout。
 *
 * cordis 4 的核心 Context **没有** `ctx.interval` / `ctx.timeout`（老线那两个来自
 * DSH 宿主自带的 timer 件）。两条路：给每个 home 装 `@cordisjs/plugin-timer` 官方件，
 * 或者在这儿用 `ctx.effect` 包一对裸的 node 定时器。选后者——备份件不该为一个
 * `setInterval` 逼每个 home 多装一件；effect 的 disposer 正是 fiber 撤下时清定时器
 * 的那一钩，裸定时器残留（热重载后双倍触发）的老坑在「包进 effect」之后就没了。
 *
 * 全部定时器住**一个** effect：换频率是「清掉旧的再起一根」，都发生在这一格 effect
 * 的生命周期内，fiber 撤下时一把全收。
 */

import { DEFAULT_FLAT } from './config.js'
import { minutesSince } from './state.js'

/** 只取 cordis Context 上这一层要用到的那一格格。结构化收窄，测试递假的 */
export interface EffectHost {
  effect(setup: () => () => void): void
}

export interface Timers {
  /** 周期那根。回一个「停掉这一根」的函数（幂等）。 */
  interval(callback: () => void, ms: number): () => void
  /** 一次性那个。回一个「还没响就撤掉」的函数（幂等）。 */
  timeout(callback: () => void, ms: number): () => void
}

export function createTimers(host: EffectHost): Timers {
  const live = new Set<ReturnType<typeof setTimeout>>()
  host.effect(() => () => {
    for (const id of live) clearTimeout(id)
    live.clear()
  })

  const closer = (id: ReturnType<typeof setTimeout>): (() => void) => {
    let done = false
    return () => {
      if (done) return
      done = true
      clearTimeout(id)
      live.delete(id)
    }
  }

  return {
    interval(callback, ms) {
      const id = setInterval(callback, ms)
      live.add(id)
      return closer(id)
    },
    timeout(callback, ms) {
      const id = setTimeout(() => {
        live.delete(id)
        callback()
      }, ms)
      live.add(id)
      return closer(id)
    },
  }
}

/**
 * 间隔小时数收成一个能用的毫秒数。
 *
 * 谁都能往设置里写 `0` 或负数（设置件没有校验钩子），那会得到一个每 0 毫秒响一次的
 * 计时器。不合法就退回默认值，**不悄悄夹到边界**。（`pickFlat` 已挡一道，这里再挡一道——
 * 两处的默认值都来自 `DEFAULT_FLAT`，不许第二处写死数字。）
 */
export function intervalMsOf(hours: number): number {
  const safe = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_FLAT.healthCheckIntervalHours
  return safe * 3600 * 1000
}

/** 同上，备份周期那根：分钟 → 毫秒，不合法退回默认 30 分钟。 */
export function backupIntervalMsOf(minutes: number): number {
  const safe = Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_FLAT.frequencyMinutes
  return safe * 60 * 1000
}

/**
 * 该不该在起来 30 秒后补跑一轮。
 *
 * 判据是「上一轮离现在有没有超过一个周期」——宿主停了一夜、或者从没跑过，起来就该补上；
 * 十分钟前刚跑过就别急着再跑一次（周期那根会在一个周期后自然轮到）。
 */
export function shouldCatchUp(lastRunAt: string | undefined, frequencyMinutes: number, now: Date): boolean {
  // 分钟差按 state.ts 的口径算（无时区标记按本地时间解析——跟写进去的口径对得上）
  const age = minutesSince(lastRunAt, now)
  if (age === null) return true
  return age >= frequencyMinutes
}
