/**
 * 嘴的账本（`logs/speak.log`）契约。
 *
 * 为什么钉源码：这七行只在运行时落盘，编译器看不出「忘了一处」——
 * 少记一处，出问题时就是「日志里有 start 没 finish」，只能靠人猜。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const host = read('./index.ts');

/** 只留代码行（注释里也会提到 speak.log，不算实现） */
const codeOnly = (text: string): string =>
  text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');

const code = codeOnly(host.split('\r\n').join('\n'));

describe('嘴的账本：logs/mouth.log 的 [speak] 行', () => {
  test('noteSpeak 写进 mouth.log，tag 是 speak（11-19 八本并三本）', () => {
    assert.match(code, /const noteSpeak = \(line: string\): void => \{/u);
    assert.match(code, /noteLog\('mouth\.log', 'speak', line\)/u);
  });

  test('四类事件都记账：start / finish / drop / interrupt', () => {
    assert.ok(code.includes('noteSpeak(\n      `start key='), '开念要记 start');
    assert.ok(code.includes('`finish key=${spec.key} ok='), '收尾要记 finish');
    assert.ok(code.includes('noteSpeak(`drop key=${key} reason='), '离队要记 drop');
    assert.ok(code.includes('noteSpeak(`interrupt reason='), '打断要记 interrupt');
  });

  test('被仲裁拒收、被保底闸掐掉也各记一行（这两条最容易被漏）', () => {
    assert.match(code, /noteSpeak\(`reject key=\$\{spec\.key\} priority=/u);
    assert.ok(code.includes('noteSpeak(`drop key=${spec.key} reason=stuck'), '保底闸要记 stuck');
  });

  test('气泡与播放也进同一本，用 tag 区分（不再各开一个文件）', () => {
    assert.ok(code.includes("noteLog('mouth.log', 'bubble', line)"), '[bubble] 要在 mouth.log');
    assert.ok(code.includes("noteLog('mouth.log', 'play', line)"), '[play] 要在 mouth.log');
    assert.ok(code.includes("noteLog('mouth.log', 'say-loud', line)"), '[say-loud] 要在 mouth.log');
  });
});