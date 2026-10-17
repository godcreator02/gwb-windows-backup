/**
 * SeamMap 在机读版里变成什么：跟画面读同一份内容，交给讲解组件包的 seamGraphText 写成一段段文字。
 * 带 module 属性时写的是插件包的内部图。这个文件不 import React，docfirst.config.mjs 引它，命令行也能运行。
 */
import { seamGraphText } from '@godcreator/explainer';
import { innerGraph } from './inner.data.mjs';
import { systemGraph } from './system.data.mjs';

export function SeamMap(node, { paragraph, attr }) {
  const moduleId = attr(node, 'module');
  if (moduleId === undefined) return seamGraphText(systemGraph).map((text) => paragraph(text));
  if (moduleId === 'windows-backup') return seamGraphText(innerGraph).map((text) => paragraph(text));
  throw new Error(`SeamMap 没有「${moduleId}」的内部图，只有 windows-backup`);
}
