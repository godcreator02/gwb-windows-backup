/**
 * HealthCases 在机读版里变成什么：跟画面读同一份数据（health-cases.data.mjs）。每种情况两段：说明，与那一刻的事实和现算的结论。
 * 这个文件不 import React，docfirst.config.mjs 引它，命令行也能运行。
 */
import { casesText } from '@godcreator/explainer';
import { cases, ITEM_LABELS } from './health-cases.data.mjs';

export function HealthCases(_node, { paragraph }) {
  const texts = casesText(cases);
  return cases.flatMap((item, i) => [
    paragraph(texts[i]),
    paragraph(
      `事实：${item.facts.join('；')}。` +
        (item.refuseReason === null ? '' : `拒跑理由：${item.refuseReason}。`) +
        (item.items === null
          ? 'health 为 null。'
          : `三项：${ITEM_LABELS.map(({ key, label }) => `${label} ${item.items[key].status}（${item.items[key].message}）`).join('；')}。`) +
        (item.reminders.length === 0 ? '' : `到期的人工维护：${item.reminders.join('；')}。`),
    ),
  ]);
}
