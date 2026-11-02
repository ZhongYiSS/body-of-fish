import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences } from './say-split.ts';

test('一句就一句：不拆也不改字', () => {
  assert.deepEqual(splitSentences('哥哥，喝水。'), ['哥哥，喝水。']);
});

test('按句末标点拆：标点跟着前一句，逗号不断', () => {
  assert.deepEqual(splitSentences('本鱼在呢。哥哥忙吗？要不要喝茶！'), [
    '本鱼在呢。',
    '哥哥忙吗？',
    '要不要喝茶！',
  ]);
  // 逗号/顿号只在句中，不该断开
  assert.deepEqual(splitSentences('饭要吃，茶要喝，尾巴要摇。'), ['饭要吃，茶要喝，尾巴要摇。']);
});

test('只有标点的碎片丢掉（连着的省略号不该冒一个空气泡）', () => {
  assert.deepEqual(splitSentences('真的吗……那就好。'), ['真的吗……', '那就好。']);
  assert.deepEqual(splitSentences('……'), ['……']);
});

test('英文与换行也认（模型偶尔混着说）', () => {
  assert.deepEqual(splitSentences('好呀!\nLet me check? 没问题。'), ['好呀!', 'Let me check?', '没问题。']);
});

test('超过上限并进最后一句，一个字都不丢', () => {
  const many = '一。二。三。四。五。六。';
  const out = splitSentences(many, 3);
  assert.equal(out.length, 3);
  assert.equal(out.join(''), many);
  assert.equal(out[2], '三。四。五。六。');
});

test('空串与纯空白：返回空串（调用方按"没话说"处理）', () => {
  assert.deepEqual(splitSentences(''), ['']);
  assert.deepEqual(splitSentences('   \n\t '), ['']);
});
