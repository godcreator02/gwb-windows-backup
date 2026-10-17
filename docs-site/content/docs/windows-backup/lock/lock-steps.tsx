/**
 * 「锁」页：两个参与方 A、B 都要占同一个 backup.lock，一步一步看锁文件的内容怎么变、谁拿着锁。
 * 内容全在 lock-steps.data.mjs；机读版由 lock-steps.ai.mjs 读同一份数据生成。
 */
import { Pane, Pill, Stepper } from '@godcreator/explainer/site'
import { steps } from './lock-steps.data.mjs'
import '../../_shared/backup.css'

type Step = (typeof steps)[number]

const FIELDS = ['pid', 'lease', 'startedAt', 'beatAt'] as const

function LockFileView({ step }: { step: Step }) {
  return (
    <Pane title="<数据目录>/backup.lock" icon="file" role="rose" extra={<Pill tone={step.tone}>{step.verdict}</Pill>}>
      {step.file === null ? (
        <p className="wb-note">（文件不存在）</p>
      ) : (
        <table className="wb-kv">
          <tbody>
            {FIELDS.map((field) => (
              <tr key={field} data-tone={step.changed.includes(field) ? 'good' : undefined}>
                <th>{field}</th>
                <td className="wb-mono">{String(step.file?.[field])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Pane>
  )
}

function Party({ name, doing, holds }: { name: string; doing: string; holds: boolean }) {
  return (
    <div className="wb-party" data-holds={holds ? 'yes' : 'no'}>
      <span className="wb-party-name">{name}</span>
      {holds ? <Pill role="rose">持锁</Pill> : null}
      <span className="wb-small">{doing}</span>
    </div>
  )
}

export function LockSteps() {
  return (
    <div className="not-prose">
      <Stepper steps={steps} label="两个参与方占同一把锁" interval={4200}>
        {(step) => (
          <div className="wb-cols" data-n="2">
            <div className="wb-col">
              <Party name="A" doing={step.a} holds={step.holder === 'A'} />
              <Party name="B" doing={step.b} holds={step.holder === 'B'} />
            </div>
            <LockFileView step={step} />
          </div>
        )}
      </Stepper>
    </div>
  )
}
