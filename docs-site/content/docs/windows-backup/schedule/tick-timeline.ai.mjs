/**
 * TickTimeline 在机读版里变成什么：跟画面读同一份数据（tick-timeline.data.mjs）。每段一句，再把 simulate() 算出的每一跳列成一段。
 * 这个文件不 import React，docfirst.config.mjs 引它，命令行也能运行。
 */
import { chaptersText } from '@godcreator/explainer';
import { chapters, settingChanges, simulate } from './tick-timeline.data.mjs';

const WORD = { run: '跑一轮', busy: '有一轮在跑', wait: '没到期', refused: '拒跑' };

export function TickTimeline(_node, { paragraph }) {
  const { ticks } = simulate();
  return [
    ...chaptersText(chapters).map((text) => paragraph(text)),
    paragraph(`场景里的设置：${settingChanges.map((c) => `第 ${c.minute} 分钟${c.label}`).join('，')}。`),
    paragraph(`每一跳的判断：${ticks.map((t) => `第 ${t.minute} 分钟${WORD[t.outcome]}${t.logged ? '（写日志）' : ''}`).join('；')}。`),
  ];
}
