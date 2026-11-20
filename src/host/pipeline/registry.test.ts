/**
 * 接线表（注册表薄版）的单元测试。
 *
 * 测的是纯函数：注册、去重、describe、按等级找想、事件扇出。
 * 另外把 `sources/` 三个构造器也一起测了——它们只产事件，不该有副作用。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_MIND } from '../minds/chat';
import { SCREEN_MIND } from '../minds/screen';
import { createRegistry } from './registry';
import { earEvent, EAR_SOURCE, urgentEvent } from '../sources/ear';
import { manualEvent, MANUAL_SOURCE } from '../sources/manual';
import { visionEvent, VISION_SOURCE } from '../sources/vision';

test('注册表：注册后 describe 能列出三张表', () => {
  const registry = createRegistry();
  registry.registerSource(EAR_SOURCE);
  registry.registerSource(MANUAL_SOURCE);
  registry.registerSource(VISION_SOURCE);
  registry.registerMind(CHAT_MIND);
  registry.registerMind(SCREEN_MIND);

  assert.deepEqual(registry.describe(), {
    sources: ['ear', 'manual', 'vision'],
    minds: ['chat', 'screen'],
    sinks: [],
  });
});

test('注册表：同一个 id 注册两次要抛错，不能悄悄覆盖', () => {
  const registry = createRegistry();
  registry.registerSource(EAR_SOURCE);
  assert.throws(() => registry.registerSource(EAR_SOURCE), /输入「ear」/u);

  registry.registerMind(CHAT_MIND);
  assert.throws(() => registry.registerMind(CHAT_MIND), /想「chat」/u);

  registry.registerSink({ id: 'mouth', title: '嘴', entry: 'centerSay' });
  assert.throws(() => registry.registerSink({ id: 'mouth', title: '嘴', entry: 'centerSay' }), /输出「mouth」/u);
});

test('注册表：按等级找想——3/5 给主想，2/4 给屏幕想', () => {
  const registry = createRegistry();
  registry.registerMind(CHAT_MIND);
  registry.registerMind(SCREEN_MIND);

  assert.equal(registry.mindFor(3), 'chat');
  assert.equal(registry.mindFor(5), 'chat');
  assert.equal(registry.mindFor(2), 'screen');
  assert.equal(registry.mindFor(4), 'screen');
  assert.equal(registry.mindFor(1), undefined, '碎碎念没有想认领');
});

test('注册表：emitSense 先记账再扇出，顺序不能反', () => {
  const order: string[] = [];
  const registry = createRegistry({
    log: (line) => order.push(`log:${line}`),
    onSense: (event) => order.push(`sense:${event.id}`),
  });
  const event = earEvent('晚上好');
  registry.emitSense(event);

  assert.equal(order.length, 2);
  assert.match(order[0] ?? '', /^log:heard level=3 source=ear/u);
  assert.equal(order[1], `sense:${event.id}`);
});

test('输入 · 耳朵：等级 3；紧急那条显式 5', () => {
  const heard = earEvent('在吗');
  assert.equal(heard.kind, 'heard');
  assert.equal(heard.level, 3);
  assert.equal(heard.source, 'ear');
  assert.equal(heard.text, '在吗');

  assert.equal(urgentEvent('着火了').level, 5);
});

test('输入 · 手动：来源只能是 menu / hotkey / bridge，等级 4', () => {
  for (const origin of ['menu', 'hotkey', 'bridge'] as const) {
    const event = manualEvent(origin, '看一眼');
    assert.equal(event.kind, 'command');
    assert.equal(event.level, 4);
    assert.equal(event.source, origin);
  }
});

test('输入 · 眼睛：等级 2，图片是裸字节、目标窗口单独放', () => {
  const seen = visionEvent({ text: '他在改代码', image: new Uint8Array([1, 2, 3]), target: 'Code' });
  assert.equal(seen.kind, 'seen');
  assert.equal(seen.level, 2);
  assert.equal(seen.source, 'watch');
  assert.equal(seen.target, 'Code');
  assert.deepEqual([...(seen.image ?? [])], [1, 2, 3]);

  // 只给表情包名时不该塞进 image（那是路径/字节的位置）
  const named = visionEvent({ text: '笑', imageName: 'meme-01' });
  assert.equal(named.image, undefined);
  assert.equal(named.imageName, 'meme-01');
});

test('每条事件的 id 不重样（同毫秒也不撞）', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 50; i += 1) ids.add(earEvent('同一句').id);
  assert.equal(ids.size, 50);
});