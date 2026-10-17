/**
 * 术语页的表：从站点根的术语表 glossary.json 画出每个词、定义与详解页。站上正文自动标注用的是同一份数据。
 * 机读版由 glossary-list.ai.mjs 读同一份数据生成。
 */
import Link from 'fumadocs-core/link'
import glossary from '../../../glossary.json'
import '../_shared/backup.css'

export function GlossaryList() {
  return (
    <div className="dx not-prose">
      <div className="wb-scroll">
        <table className="wb-kv">
          <thead>
            <tr>
              <th>词</th>
              <th>定义</th>
              <th>详见</th>
            </tr>
          </thead>
          <tbody>
            {glossary.map((entry) => (
              <tr key={entry.term} id={`term-${entry.term}`}>
                <td className="wb-term">
                  <b>{entry.term}</b>
                </td>
                <td>{entry.def}</td>
                <td className="wb-mono">{entry.href === undefined ? '—' : <Link href={entry.href}>{entry.href}</Link>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
