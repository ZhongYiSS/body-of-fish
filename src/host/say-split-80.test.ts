import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SEGMENT_CHARS, splitSentences } from './say-split.ts';

test('长句按 80 字再切：每段都不超过 80，一个字不丢', () => {
  // 100 个字、中间带逗号：应在逗号后断开
  const line = '一'.repeat(40) + '，' + '二'.repeat(40) + '，' + '三'.repeat(19) + '。';
  const out = splitSentences(line);
  assert.ok(out.every((part) => Array.from(part).length <= MAX_SEGMENT_CHARS), JSON.stringify(out.map((p) => p.length)));
  assert.equal(out.join(''), line);
});

test('200 字没标点：硬截成 3 段，每段 ≤80', () => {
  const line = '泡'.repeat(200);
  const out = splitSentences(line);
  assert.ok(out.length >= 3);
  assert.ok(out.every((part) => Array.from(part).length <= MAX_SEGMENT_CHARS));
  assert.equal(out.join(''), line);
});

test('短句不受影响（不因为新规则变碎）', () => {
  assert.deepEqual(splitSentences('哥哥，喝水。'), ['哥哥，喝水。']);
});