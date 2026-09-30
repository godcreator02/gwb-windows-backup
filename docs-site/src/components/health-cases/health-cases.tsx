'use client'
/**
 * 「健康结论」页：选一刻的情形，左边是那一刻的事实，右边是 status 现算出的状态灯、三项与到期的人工维护——跟窗格上看到的一一对应。
 * 内容全在 health-cases.data.mjs；机读版由 health-cases.ai.mjs 读同一份数据生成。
 */
import { CasePicker, Dot, Pane, Pill } from '@godcreator/docfirst-explainer'
import { cases, ITEM_LABELS } from './health-cases.data.mjs'

type Case = (typeof cases)[number]
type Status = 'ok' | 'problem' | 'unknown'

const TONE = { ok: 'good', problem: 'warn', unknown: 'pending' } as const

function headline(item: Case): { tone: 'good' | 'warn'; label: string } {
  if (item.refuseReason !== null) return { tone: 'warn', label: '备份停着' }
  if (item.items === null) return { tone: 'warn', label: '判不了' }
  const problems = ITEM_LABELS.filter(({ key }) => item.items?.[key as keyof NonNullable<Case['items']>].status === 'problem').length
  return problems === 0 ? { tone: 'good', label: '一切正常' } : { tone: 'warn', label: `${String(problems)} 项问题` }
}

function Verdict({ item }: { item: Case }) {
  const head = headline(item)
  return (
    <Pane title="windows-backup.status 现算的结论" icon="server" role="amber" extra={<Pill tone={head.tone} dot>{head.label}</Pill>}>
      <div className="wb-col wb-tight">
        {item.refuseReason === null ? null : <p className="wb-alert">不跑备份：{item.refuseReason}</p>}
        {item.items === null ? (
          <p className="wb-note">health: null——判不了，不是没问题</p>
        ) : (
          <ul className="wb-items">
            {ITEM_LABELS.map(({ key, label }) => {
              const entry = item.items?.[key as keyof NonNullable<Case['items']>]
              if (entry === undefined) return null
              return (
                <li key={key} data-status={entry.status}>
                  <Dot tone={TONE[entry.status as Status]} />
                  <span className="wb-item-label">{label}</span>
                  <span className="wb-small">{entry.message}</span>
                </li>
              )
            })}
          </ul>
        )}
        {item.reminders.length === 0 ? null : (
          <div className="wb-reminders">
            <span className="wb-note">该做的人工维护（不算故障）</span>
            {item.reminders.map((reminder) => (
              <span key={reminder} className="wb-small">
                · {reminder}
              </span>
            ))}
          </div>
        )}
      </div>
    </Pane>
  )
}

export function HealthCases() {
  return (
    <div className="not-prose">
      <CasePicker cases={cases} label="选一刻的情形">
        {(item) => (
          <div className="wb-cols" data-n="2-wide">
            <Pane title="这一刻的事实" icon="file" role="slate">
              <ul className="wb-kvlist">
                {item.facts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            </Pane>
            <Verdict item={item} />
          </div>
        )}
      </CasePicker>
    </div>
  )
}
