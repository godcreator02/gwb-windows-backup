/**
 * 名册里给人看的那一半：docfirst.config.mjs 里声明机读规则表，这里给 React 表。
 * 表的类型由 registry.ts 的名单限定：少一个编译不过，多一个也编译不过。
 * 跟机读规则表是否一致，由 scripts/verify-roster.mjs 两边核对。
 * 先放 fumadocs 的默认表，再把 pre 换成 @godcreator/docfirst-workflow/fumadocs 里会画状态点的 DocfirstPre。
 */
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { File, Files, Folder } from 'fumadocs-ui/components/files';
import type { MDXComponents } from 'mdx/types';
import type { ReactNode } from 'react';
import { DocfirstPre } from '@godcreator/docfirst-workflow/fumadocs/pre';
import { Term } from '@godcreator/docfirst-workflow/fumadocs/term';
import { GlossaryList } from './glossary-list/glossary-list';
import { HealthCases } from './health-cases/health-cases';
import { LockSteps } from './lock-steps/lock-steps';
import { RoundCases } from './round-cases/round-cases';
import { SeamMap } from './seam-map/seam-map';
import { TickTimeline } from './tick-timeline/tick-timeline';
import type { ComponentName } from './registry';

export function Note({ children }: { children?: ReactNode }) {
  return <div className="note">{children}</div>;
}

const table: Record<ComponentName, MDXComponents[string]> = {
  Note,
  Files,
  Folder,
  File,
  Term,
  SeamMap,
  RoundCases,
  TickTimeline,
  LockSteps,
  HealthCases,
  GlossaryList,
};

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ...components,
    ...table,
    pre: DocfirstPre,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
