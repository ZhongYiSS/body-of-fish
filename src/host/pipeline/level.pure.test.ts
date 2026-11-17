/**
 * 五级台阶的纯函数测试 —— 打断台阶一张表、回话等级、排队过期，全部只读常量算出来比对。
 * 跑法：`node --test --experimental-strip-types src/host/pipeline/level.pure.test.ts`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LEVELS,
  LEVEL_EXPIRE_MS,
  LEVEL_WORD,
  MOUTH_QUEUE_MAX,
  canInterrupt,
  droppableWhenBusy,
  replyLevel,
} from './level.ts';
import type { Level } from './types.ts';

/** 期望的 5×5 台阶：'in' 顶掉 / 'next' 只顶没开播 / 'no' 让路 */
const EXPECT: Record<Level, Record<Level, 'in' | 'next' | 'no'>> = {
  5: { 1: 'in', 2: 'in', 3: 'in', 4: 'in', 5: 'in' },
  4: { 1: 'in', 2: 'in', 3: 'in', 4: 'no', 5: 'no' },
  3: { 1: 'in', 2: 'in', 3: 'next', 4: 'no', 5: 'no' },
  2: { 1: 'in', 2: 'no', 3: 'no', 4: 'no', 5: 'no' },
  1: { 1: 'no', 2: 'no', 3: 'no', 4: 'no', 5: 'no' },
};

describe('五级台阶：25 种组合逐个对表', () => {
  for (const incoming of LEVELS) {
    for (const current of LEVELS) {
      it(`${incoming} 对 ${current}`, () => {
        const step = EXPECT[incoming][current];
        const queued = canInterrupt(incoming, current, 'queued');
        const speaking = canInterrupt(incoming, current, 'speaking');
        assert.equal(queued, step !== 'no', `${incoming} 对排队中的 ${current}`);
        assert.equal(speaking, step === 'in', `${incoming} 对正在说的 ${current}`);
      });
    }
  }
});

describe('五级台阶：回话等级不照抄事件等级', () => {
  it('看到的不算他说的话，一律 2 级', () => {
    assert.equal(replyLevel({ kind: 'seen', level: 2 }), 2);
    assert.equal(replyLevel({ kind: 'seen', level: 5 }), 2);
  });

  it('他说话 / 按手动键 → 回话 5 级', () => {
    assert.equal(replyLevel({ kind: 'heard', level: 5 }), 5);
    assert.equal(replyLevel({ kind: 'command', level: 4 }), 5);
  });

  it('打字聊天 → 3 级', () => {
    assert.equal(replyLevel({ kind: 'heard', level: 3 }), 3);
    assert.equal(replyLevel({ kind: 'command', level: 3 }), 3);
  });
});

describe('五级台阶：丢谁、排多久、写什么字', () => {
  it('只有碎碎念会在嘴忙时被丢', () => {
    assert.deepEqual(
      LEVELS.map((level) => droppableWhenBusy(level)),
      [true, false, false, false, false],
    );
  });

  it('5 级不过期，其余 15 秒', () => {
    for (const level of LEVELS) {
      if (level === 5) assert.equal(LEVEL_EXPIRE_MS[level], Number.POSITIVE_INFINITY);
      else assert.equal(LEVEL_EXPIRE_MS[level], 15_000);
    }
  });

  it('队列只留 3 条', () => {
    assert.equal(MOUTH_QUEUE_MAX, 3);
  });

  it('每级都有中文写法', () => {
    assert.deepEqual(
      LEVELS.map((level) => LEVEL_WORD[level]),
      ['碎碎念', '主动', '对话', '手动', '听一句'],
    );
  });
});