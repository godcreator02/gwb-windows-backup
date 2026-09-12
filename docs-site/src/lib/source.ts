import { loader } from 'fumadocs-core/source'
// .source/ 是 fumadocs-mdx 按 source.config.ts 生成的（gitignore），集合从这里拿。
// 六区各一条 loader：URL 基座 /docs、/trajectory、/spec、/future、/outputs、/feedback，
// 路由各走各的 loader（src/app/(zones)/<区>/…），侧栏在 src/lib/tree.ts 合成一棵树。
import { docs, feedback, future, outputs, spec, trajectory } from '../../.source/server'

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
})

export const sourceTrajectory = loader({
  baseUrl: '/trajectory',
  source: trajectory.toFumadocsSource(),
})

export const sourceSpec = loader({
  baseUrl: '/spec',
  source: spec.toFumadocsSource(),
})

export const sourceFuture = loader({
  baseUrl: '/future',
  source: future.toFumadocsSource(),
})

export const sourceOutputs = loader({
  baseUrl: '/outputs',
  source: outputs.toFumadocsSource(),
})

export const sourceFeedback = loader({
  baseUrl: '/feedback',
  source: feedback.toFumadocsSource(),
})
