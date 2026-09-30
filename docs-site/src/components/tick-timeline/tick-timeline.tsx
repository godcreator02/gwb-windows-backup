'use client'
/**
 * 「定时」页：同一个场景从加载演到第 30 分钟。上面一条是设置里的周期，中间一条是锁被哪一轮占着，下面一排点是每一跳的判断；
 * 竖线是此刻。图下面写这一跳为什么这么判、此刻的 lastRunAt 与下一轮最早什么时候。
 * 画面是「时刻 → 画面」的函数；每一跳的判断由 tick-timeline.data.mjs 的 simulate() 算出，机读版由 tick-timeline.ai.mjs 读同一份数据生成。
 */
import { Pill, Timeline } from '@godcreator/docfirst-explainer'
import { chapters, LAST_MINUTE, settingChanges, simulate } from './tick-timeline.data.mjs'

const { ticks, rounds } = simulate()

const LEFT = 58
const RIGHT = 700
const x = (minute: number): number => LEFT + (minute / LAST_MINUTE) * (RIGHT - LEFT)

const TICK_TONE = { run: 'good', busy: undefined, wait: 'info', refused: 'warn' } as const
const TICK_WORD = { run: '跑一轮', busy: '有一轮在跑', wait: '没到期', refused: '拒跑' } as const

function settingSegments() {
  return settingChanges.map((change, index) => ({
    ...change,
    end: settingChanges[index + 1]?.minute ?? LAST_MINUTE,
  }))
}

function Legend() {
  return (
    <div className="wb-legend">
      {(['run', 'busy', 'wait', 'refused'] as const).map((outcome) => (
        <span key={outcome} className="wb-legend-item">
          <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden>
            <circle cx={6} cy={6} r={4.5} className="wb-svg-tick" data-tone={TICK_TONE[outcome]} />
          </svg>
          {TICK_WORD[outcome]}
        </span>
      ))}
      <span className="wb-legend-item">
        <span className="wb-legend-lock" />
        锁被占着
      </span>
    </div>
  )
}

function Picture({ minute }: { minute: number }) {
  const seen = ticks.filter((tick) => tick.minute <= minute)
  const latest = seen.at(-1)
  const finished = rounds.filter((round) => round.end <= minute)
  const lastRunAt = finished.at(-1)?.end ?? null
  const running = rounds.find((round) => round.start <= minute && minute < round.end)
  const frequency = [...settingChanges].reverse().find((change) => change.minute <= minute)?.frequency ?? null
  const nextAt = lastRunAt === null || frequency === null ? null : lastRunAt + frequency
  const logLines = seen.filter((tick) => tick.logged).length

  return (
    <div className="wb-col">
      <div className="wb-scroll">
      <svg viewBox="0 0 720 176" className="wb-svg wb-svg-wide" role="img" aria-label="每分钟一跳的时间轴">
        <text x={4} y={33} className="wb-svg-label">周期</text>
        {settingSegments().map((segment) => (
          <g key={segment.minute} data-tone={segment.frequency === null ? 'warn' : undefined}>
            <rect x={x(segment.minute)} y={18} width={x(segment.end) - x(segment.minute) - 2} height={22} rx={5} className="wb-svg-band" />
            <text x={x(segment.minute) + 7} y={33} className="wb-svg-band-text">
              {segment.frequency === null ? '不合法' : `${segment.frequency} 分钟`}
            </text>
          </g>
        ))}

        <text x={4} y={73} className="wb-svg-label">锁</text>
        {rounds
          .filter((round) => round.start <= minute)
          .map((round) => (
            <rect key={round.start} x={x(round.start)} y={60} width={Math.max(2, x(Math.min(round.end, minute)) - x(round.start))} height={18} rx={4} className="wb-svg-lock" />
          ))}

        <text x={4} y={112} className="wb-svg-label">每一跳</text>
        {ticks.map((tick) => (
          <circle
            key={tick.minute}
            cx={x(tick.minute)}
            cy={107}
            r={tick === latest ? 8 : 5.5}
            className="wb-svg-tick"
            data-tone={tick.minute <= minute ? TICK_TONE[tick.outcome] : undefined}
            data-seen={tick.minute <= minute ? 'yes' : 'no'}
          />
        ))}

        {lastRunAt === null ? null : (
          <g className="wb-svg-marker" data-tone="good">
            <line x1={x(lastRunAt)} x2={x(lastRunAt)} y1={126} y2={146} />
            <text x={x(lastRunAt)} y={160} textAnchor="middle">lastRunAt</text>
          </g>
        )}
        {nextAt === null || nextAt > LAST_MINUTE ? null : (
          <g className="wb-svg-marker" data-tone="info">
            <line x1={x(nextAt)} x2={x(nextAt)} y1={126} y2={146} strokeDasharray="3 3" />
            <text x={x(nextAt)} y={174} textAnchor="middle">下一轮最早</text>
          </g>
        )}

        <line x1={x(minute)} x2={x(minute)} y1={10} y2={122} className="wb-svg-cursor" />
        {[0, 5, 10, 15, 20, 25, 30].map((m) => (
          <text key={m} x={x(m)} y={136} textAnchor="middle" className="wb-svg-axis">
            {m}
          </text>
        ))}
      </svg>
      </div>
      <Legend />

      <div className="wb-cols" data-n="2">
        <div className="wb-col wb-tight">
          <span className="wb-note">第 {minute.toFixed(1)} 分钟</span>
          {latest === undefined ? (
            <span className="wb-small">还没到第一跳</span>
          ) : (
            <>
              <span>
                <Pill tone={TICK_TONE[latest.outcome]} dot>
                  第 {latest.minute} 跳 · {TICK_WORD[latest.outcome]}
                </Pill>
              </span>
              <span className="wb-small">{latest.note}</span>
            </>
          )}
        </div>
        <table className="wb-kv">
          <tbody>
            <tr>
              <th>正在跑</th>
              <td>{running === undefined ? '没有' : `第 ${running.start} 分钟起的那一轮（持着锁）`}</td>
            </tr>
            <tr>
              <th>lastRunAt</th>
              <td>{lastRunAt === null ? '（从没跑过）' : `第 ${lastRunAt.toFixed(1)} 分钟`}</td>
            </tr>
            <tr>
              <th>下一轮最早</th>
              <td>{nextAt === null ? '—' : `第 ${nextAt.toFixed(1)} 分钟`}</td>
            </tr>
            <tr>
              <th>写了日志的跳</th>
              <td>{logLines}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function TickTimeline() {
  return (
    <div className="not-prose">
      <Timeline chapters={chapters} label="每分钟一跳">
        {(frame) => <Picture minute={frame.chapter.from + frame.progress * (frame.chapter.to - frame.chapter.from)} />}
      </Timeline>
    </div>
  )
}
