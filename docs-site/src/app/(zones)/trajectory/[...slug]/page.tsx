import { sourceTrajectory } from '@/lib/source'
import { DocsBody, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page'
import { getMDXComponents } from '@/components/mdx'
import { notFound } from 'next/navigation'

// 卡页：标题下一行元信息（born-at、type、domain、parent 链到父卡页）。
// slug 必选——/trajectory 那个根没有导读页（星轨盘没接，next.config 里先重定向到根卡；
// 卡多起来接盘时，盘是那条独立的整页路由）。
export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params
  const page = sourceTrajectory.getPage(slug)
  if (!page) notFound()

  const { type, domain, parent, ['born-at']: bornAt } = page.data
  const MDX = page.data.body
  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      {bornAt ? (
        <div style={{ fontSize: 13, opacity: 0.7, margin: '-8px 0 4px' }}>
          {String(bornAt)}
          {type ? ` · ${type}` : ''}
          {domain ? ` · ${domain}` : ''}
          {parent && parent.length > 0 ? (
            <>
              {' · 父卡：'}
              {parent.map((id: string, i: number) => (
                <span key={id}>
                  {i > 0 ? '、' : ''}
                  <a href={`/trajectory/${encodeURIComponent(id)}`}>{id}</a>
                </span>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  )
}

// 只出卡，不出空 slug——/trajectory 那个根归重定向（将来归星轨盘那条路由）
export function generateStaticParams() {
  return sourceTrajectory.generateParams().filter((p) => p.slug.length > 0)
}
