import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // 必须留空：`@godcreator/docfirst-workflow` 一个包里同时有服务端代码（读盘、调 git、remark 插件）与客户端组件
  // /fumadocs/pre，serverExternalPackages 按包名匹配、不分子路径，外置之后 Next 用 Node 单独加载它、
  // 和站打包的 React 不是同一份，预渲染报 Cannot read properties of null
  serverExternalPackages: [],
  redirects: async () => [
    // 入口是现状区的系统地图；/docs 与 /trajectory 没有导读页，各自指到第一页
    { source: '/', destination: '/docs/system-map', permanent: false },
    { source: '/docs', destination: '/docs/system-map', permanent: false },
    // 星轨盘没接（卡还少）：/trajectory 指到这条线的根卡
    { source: '/trajectory', destination: '/trajectory/2026-09-08-backup-line', permanent: false },
    // 生成正本挪进了现状区
    { source: '/outputs/:path*', destination: '/docs/outputs/:path*', permanent: false },
  ],
}

export default withMDX(config)
