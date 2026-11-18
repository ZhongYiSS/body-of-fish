import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  THOUGHT_MAX,
  THOUGHT_WINDOW_MS,
  isDuplicateThought,
  recentThoughts,
  shouldRecordThought,
} from './thought';

describe('「想说没说」的记账规则', () => {
  it('只记 high / urgent 的四种离队理由', () => {
    assert.equal(shouldRecordThought('high', 'queue-full'), true);
    assert.equal(shouldRecordThought('urgent', 'interrupted'), true);
    assert.equal(shouldRecordThought('high', 'expired'), true);
    assert.equal(shouldRecordThought('normal', 'queue-full'), false);
    assert.equal(shouldRecordThought('low', 'expired'), false);
    assert.equal(shouldRecordThought('high', 'busy-low'), false);
    assert.equal(shouldRecordThought('high', undefined), false);
  });

  it('只挑 30 分钟内的 thought，最多 3 条，新的在前', () => {
    const now = 1_700_000_000_000;
    const turns = [
      { at: now - THOUGHT_WINDOW_MS - 1, kind: 'thought', text: '太老了' },
      { at: now - 3000, kind: 'thought', text: '第一句' },
      { at: now - 2000, kind: 'said', text: '她说出口的' },
      { at: now - 1000, kind: 'thought', text: '第二句' },
      { at: now - 500, kind: 'thought', text: '第三句' },
      { at: now - 100, kind: 'thought', text: '第四句' },
    ];
    const picked = recentThoughts(turns, now);
    assert.equal(picked.length, THOUGHT_MAX);
    assert.deepEqual(picked, ['第四句', '第三句', '第二句']);
  });

  it('同一句话 3 分钟内只记一次', () => {
    const now = 1_700_000_000_000;
    assert.equal(isDuplicateThought({ text: '一样的话', at: now - 1000 }, '一样的话', now), true);
    assert.equal(isDuplicateThought({ text: '一样的话', at: now - 200_000 }, '一样的话', now), false);
    assert.equal(isDuplicateThought(null, '一样的话', now), false);
  });
});