/**
 * GlossaryList 在机读版里变成什么：跟画面读同一份术语表（站点根的 glossary.json），每个词一段。
 * 这个文件不 import React，docfirst.config.mjs 引它，命令行也能运行。
 */
import glossary from '../../../glossary.json' with { type: 'json' };

export function GlossaryList(_node, { paragraph }) {
  return glossary.map((entry) => paragraph(`${entry.term}：${entry.def}${entry.href === undefined ? '' : ` 详见 ${entry.href}。`}`));
}
