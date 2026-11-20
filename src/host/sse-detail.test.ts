/**
 * SSE 明细事件的契约（2026-11-20 m31853）：状态叶子是 `{counter, data}` 信封。
 *
 * 以前 `push()` 里直接读 `pet.say.text` / `pet.hint.items` —— 永远是 undefined，
 * 于是 `event: say` 永远空文本、`event: hint` 永远空数组；壳只能靠 `event: state`
 * 整份快照更新，副气泡【在看】/【在说】的明细事件形同虚设。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const code = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8').split('\r\n').join('\n');

function sseBlock(): string {
  const start = code.indexOf("if (ssePath === '/v1/events'");
  assert.ok(start > 0, '找不到 SSE 分支');
  const stopAt = code.indexOf('const stop = (): void =>', start);
  assert.ok(stopAt > start, '找不到 SSE 的 stop()');
  return code.slice(start, stopAt);
}

test('SSE 明细事件要解 {counter, data} 信封', () => {
  const block = sseBlock();
  assert.ok(block.includes('const leafData = (leaf: unknown): Record<string, unknown> => {'), '缺 leafData()');
  assert.ok(block.includes('const said = leafData(pet.say);'), 'say 没解信封');
  assert.ok(!block.includes('const said = pet.say ?? {};'), 'say 还在直接读 pet.say');
  assert.ok(block.includes('const hintItems = leafData(pet.hint).items ?? [];'), 'hint 没解信封');
  assert.ok(!block.includes('pet.hint?.items'), 'hint 还在直接读 pet.hint?.items');
});