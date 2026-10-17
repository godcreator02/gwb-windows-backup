/**
 * 「一轮备份」页：选一种开局，六段依次标出跑没跑、成没成，右边是这一轮写进 state.json 的键、日志里多的行、通知。
 * 内容全在 round-cases.data.mjs；机读版由 round-cases.ai.mjs 读同一份数据生成。
 */
import { CasePicker, Pane, Pill } from '@godcreator/explainer/site'
import { cases, stages } from './round-cases.data.mjs'
import '../../_shared/backup.css'

type Case = (typeof cases)[number]
type Result = 'ok' | 'fail' | 'skip' | 'none'

const TONE: Record<Result, 'good' | 'bad' | undefined> = { ok: 'good', fail: 'bad', skip: undefined, none: undefined }
const WORD: Record<Result, string> = { ok: '成', fail: '失败', skip: '不跑', none: '没轮到' }

function Stages({ item }: { item: Case }) {
  return (
    <ol className="wb-stages">
      {stages.map((stage) => {
        const result = item.stages[stage.id] as Result
        const note = item.notes[stage.id]
        return (
          <li key={stage.id} className="wb-stage" data-result={result} data-tone={TONE[result]}>
            <span className="wb-stage-name">{stage.name}</span>
            <span className="wb-tag" data-tone={TONE[result]}>
              {WORD[result]}
            </span>
            <code className="wb-mono wb-dim wb-stage-ident">{stage.ident}</code>
            {note === undefined ? null : <span className="wb-stage-note">{note}</span>}
          </li>
        )
      })}
    </ol>
  )
}

function Outcome({ item }: { item: Case }) {
  return (
    <div className="wb-col">
      <Pane title="state.json 这一轮写进的键" icon="file" role="slate">
        {item.writes.length === 0 ? (
          <p className="wb-note">一个键都不动</p>
        ) : (
          <ul className="wb-kvlist">
            {item.writes.map((line) => (
              <li key={line} className="wb-mono">
                {line}
              </li>
            ))}
          </ul>
        )}
      </Pane>
      <Pane title="logs/restic-backup.log 多出的行" icon="terminal" role="slate">
        {item.log.length === 0 ? (
          <p className="wb-note">一行都不写</p>
        ) : (
          <ul className="wb-kvlist">
            {item.log.map((line) => (
              <li key={line} className="wb-mono" data-tone={/FAILED/.test(line) ? 'bad' : undefined}>
                {line}
              </li>
            ))}
          </ul>
        )}
      </Pane>
      {item.toast === null ? (
        <p className="wb-note">不弹通知</p>
      ) : (
        <div className="wb-toast">
          <Pill tone={item.toast.title.includes('OK') ? 'good' : 'bad'} dot>
            {item.toast.title}
          </Pill>
          <span className="wb-mono wb-dim">{item.toast.body}</span>
        </div>
      )}
    </div>
  )
}

export function RoundCases() {
  return (
    <div className="not-prose">
      <CasePicker cases={cases} label="选一种开局">
        {(item) => (
          <div className="wb-cols" data-n="2">
            <Stages item={item} />
            <Outcome item={item} />
          </div>
        )}
      </CasePicker>
    </div>
  )
}
