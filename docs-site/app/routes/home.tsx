import { Link, useLoaderData } from 'react-router'
import { siteHomeData } from '@godcreator/god-docsite/server'
import { SiteHomeLayout } from '@godcreator/god-docsite/react'
import { site } from '@/lib/site.server'
import { featureRuntime } from '@/features/runtime.generated'

// 站点的首页：建站器只在建站时写这一份，之后归站点自己改

export function loader() {
  return siteHomeData(site)
}

export default function Home() {
  const data = useLoaderData<typeof loader>()
  return (
    <SiteHomeLayout data={data} sidebarLinks={featureRuntime.sidebarLinks}>
      <title>{data.siteName}</title>
      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-6 px-4 py-24 text-center">
        <h1 className="text-4xl font-bold">{data.siteName}</h1>
        <p className="text-fd-muted-foreground">
          gwb 工作台的 Windows 备份插件：定时把白名单目录做成 restic 快照，再独立备份一份到阿里云 OSS，随时回答「备份还在正常运行吗」。
        </p>
        <Link to={data.docsUrl} className="rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground">
          看文档
        </Link>
      </section>
    </SiteHomeLayout>
  )
}
