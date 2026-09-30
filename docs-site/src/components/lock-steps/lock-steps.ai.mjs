/**
 * LockSteps 在机读版里变成什么：跟画面读同一份数据（lock-steps.data.mjs）。每一步一段说明，再一段写此刻的锁文件与两方各在做什么。
 * 这个文件不 import React，docfirst.config.mjs 引它，命令行也能运行。
 */
import { stepsText } from '@godcreator/docfirst-explainer/text';
import { steps } from './lock-steps.data.mjs';

export function LockSteps(_node, { paragraph }) {
  const texts = stepsText(steps);
  return steps.flatMap((step, i) => [
    paragraph(texts[i]),
    paragraph(
      `此刻 backup.lock：${step.file === null ? '不存在' : JSON.stringify(step.file)}（${step.verdict}）；A：${step.a}；B：${step.b}；持锁的是 ${step.holder ?? '没有人'}。`,
    ),
  ]);
}
