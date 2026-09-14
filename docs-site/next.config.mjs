import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // **空着,这一行就是那条「不许外置」的账。** `@team/docfirst-workflow` 一个包里
  // 同时住着服务端那半（读盘、调 git、remark 插件）与客户端组件 /fumadocs/pre,
  // serverExternalPackages 按包名匹配、没有子路径粒度,所以它整包不能外置:外置之后 Next
  // 走 Node 单独加载、跟站打包的 React 分了家,预渲染报 Cannot read properties of null
  serverExternalPackages: [],
  redirects: async () => [
    // 入口是现状区的系统地图；/docs 与 /trajectory 没有导读页，各自指到第一页
    { source: '/', destination: '/docs/system-map', permanent: false },
    { source: '/docs', destination: '/docs/system-map', permanent: false },
    // 星轨盘没接（卡还少）：/trajectory 先落到这条线的根卡，卡多起来接盘时撤这条
    { source: '/trajectory', destination: '/trajectory/2026-09-08-backup-line', permanent: false },
  ],
}

export default withMDX(config)
