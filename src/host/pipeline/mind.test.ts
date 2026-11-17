/**
 * 「想」的并发表：同会话新顶旧、4/5 级掐别人、end 之后可以再来一轮。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMind } from './mind';

describe('两个「想」并行与取消', () => {
  it('同一个会话：后来的顶掉先来的（他后来问的那句才要紧）', () => {
    const lines: string[] = [];
    const mind = createMind({ now: () => 1_000, log: (line) => lines.push(line) });
    const first = mind.begin('main', 3);
    assert.equal(first.cancelled(), false);
    const second = mind.begin('main', 3);
    assert.equal(first.cancelled(), true, '旧的必须被 abort');
    assert.equal(second.cancelled(), false);
    assert.ok(lines.some((line) => line.includes('reason=superseded')));
  });

  it('4 级手动动作来：屏幕那边让路，主会话照旧', () => {
    const mind = createMind({ now: () => 1_000 });
    const screen = mind.begin('screen', 2);
    const main = mind.begin('main', 3);
    mind.begin('main', 4);
    assert.equal(screen.cancelled(), true);
    assert.equal(main.cancelled(), true, '同会话也被顶掉');
  });

  it('3 级对话不掐屏幕：陪伴可以照常想', () => {
    const mind = createMind({ now: () => 1_000 });
    const screen = mind.begin('screen', 2);
    mind.begin('main', 3);
    assert.equal(screen.cancelled(), false);
  });

  it('end 之后能再来一轮，running 也会清干净', () => {
    const mind = createMind({ now: () => 1_000 });
    const run = mind.begin('main', 3);
    assert.deepEqual(mind.running().map((item) => item.session), ['main']);
    run.end();
    assert.deepEqual(mind.running(), []);
    const again = mind.begin('main', 3);
    assert.equal(again.cancelled(), false);
  });

  it('cancel(all) 把在跑的全掐掉，并报数量', () => {
    const mind = createMind({ now: () => 1_000 });
    mind.begin('main', 3);
    mind.begin('screen', 2);
    assert.equal(mind.cancel('all', 'shutdown'), 2);
    assert.deepEqual(mind.running(), []);
  });
});
