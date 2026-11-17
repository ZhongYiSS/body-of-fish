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

describe('嘴的账本：logs/speak.log', () => {
  test('noteSpeak 写的是 speak.log，且和 bubble / sense 同一个写法', () => {
    assert.match(code, /const noteSpeak = \(line: string\): void => \{/u);
    assert.match(code, /appendFile\(join\(dir, 'speak\.log'\)/u);
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

  test('原来的两份账本还在（不拿 speak.log 顶替它们）', () => {
    assert.ok(code.includes("'bubble.log'"), 'bubble.log 要保留');
    assert.ok(code.includes("'voice-play.log'"), 'voice-play.log 要保留');
  });
});