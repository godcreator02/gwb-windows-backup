/**
 * RoundCases 在机读版里变成什么：跟画面读同一份数据（round-cases.data.mjs）。先一段六段各是什么，再每种情况两段：说明，与六段结果、写了什么、通知。
 * 这个文件不 import React，docfirst.config.mjs 引它，命令行也能运行。
 */
import { casesText } from '@godcreator/explainer';
import { cases, stages } from './round-cases.data.mjs';

const WORD = { ok: '成', fail: '失败', skip: '不跑', none: '没轮到' };

export function RoundCases(_node, { paragraph }) {
  const texts = casesText(cases);
  return [
    paragraph(`一轮按顺序是六段：${stages.map((s) => `${s.name}（${s.ident}）`).join('、')}。`),
    ...cases.flatMap((item, i) => [
      paragraph(texts[i]),
      paragraph(
        `六段：${stages.map((s) => `${s.name}${WORD[item.stages[s.id]]}${item.notes[s.id] === undefined ? '' : `（${item.notes[s.id]}）`}`).join('，')}。` +
          `state.json 写进：${item.writes.length === 0 ? '无' : item.writes.join('；')}。` +
          `日志多出：${item.log.length === 0 ? '无' : item.log.join(' / ')}。` +
          `通知：${item.toast === null ? '不弹' : `${item.toast.title}（${item.toast.body}）`}。`,
      ),
    ]),
  ];
}
