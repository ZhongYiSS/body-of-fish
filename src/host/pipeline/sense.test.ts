/**
 * 「听和看」出入口的契约测试（第 2 批）：等级必须由事件自带，想和嘴都不许改。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { describeEvent, makeEvent } from './sense';
import { priorityFor } from './level';

describe('事件自带等级', () => {
  it('听到的话是 3 级、看到的是 2 级、手动是 4 级', () => {
    assert.equal(makeEvent({ kind: 'heard', source: 'ear', text: '在吗' }).level, 3);
    assert.equal(makeEvent({ kind: 'seen', source: 'watch', text: '在看代码' }).level, 2);
    assert.equal(makeEvent({ kind: 'command', source: 'menu', text: '看一眼' }).level, 4);
  });

  it('可以显式抬到 5 级（听一句 / 紧急提醒）', () => {
    const ev = makeEvent({ kind: 'heard', source: 'ear', text: '快看', level: 5 });
    assert.equal(ev.level, 5);
    assert.equal(priorityFor(ev.level), 'urgent');
  });

  it('id 不重复、时间戳可注入（便于测试与对账）', () => {
    const a = makeEvent({ kind: 'heard', source: 'ear', text: 'a', at: 1_000 });
    const b = makeEvent({ kind: 'heard', source: 'ear', text: 'a', at: 1_000 });
    assert.notEqual(a.id, b.id);
    assert.equal(a.at, 1_000);
  });

  it('叙述一行给人看：等级和来源都在', () => {
    const ev = makeEvent({ kind: 'seen', source: 'watch', text: '一屏', target: 'chrome' });
    const line = describeEvent(ev);
    assert.match(line, /seen level=2 source=watch/);
    assert.match(line, /target=chrome/);
  });
});
