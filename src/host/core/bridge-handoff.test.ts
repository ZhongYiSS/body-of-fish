import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { HANDOFF_MAX, HANDOFF_TAIL, handoffHeader, handoffText, imageHandoffText } from './bridge-handoff.ts';

describe('接入 DSH 时的交接信封（11-17 加时间与转述声明）', () => {
  const at = new Date(2026, 10, 17, 14, 32, 0);

  test('三段：动作+时间 / 看到的内容 / 转述声明', () => {
    const out = handoffText('look', '窗口标题是「技术手册.md」 左侧目录树在展开', at);
    assert.equal(out, '（桌宠看了一眼屏幕 · 14:32）\n窗口标题是「技术手册.md」 左侧目录树在展开\n' + HANDOFF_TAIL);
  });

  test('换行/多空格压平（一条消息最干净）', () => {
    assert.equal(handoffText('watch', '刷网页\n\n  又点了一下', at), '（桌宠陪你看了一会儿 · 14:32）\n刷网页 又点了一下\n' + HANDOFF_TAIL);
  });

  test('三种动作各有自己的说法，别混在一起', () => {
    assert.match(handoffHeader('look', at), /看了一眼屏幕/u);
    assert.match(handoffHeader('watch', at), /陪你看了一会儿/u);
    assert.match(handoffHeader('image', at), /看过了这张图/u);
  });

  test('超长封顶，末尾加省略号', () => {
    const out = handoffText('look', '字'.repeat(500), at);
    assert.equal(out.split('\n')[1].length, HANDOFF_MAX + 1);
    assert.equal(out.endsWith('…'), false); // 省略号在正文里，后面还有转述声明
    assert.equal(out.split('\n')[1].endsWith('…'), true);
  });

  test('空描述不投（调用方据此决定这次不说话）', () => {
    assert.equal(handoffText('look', '   ', at), '');
  });

  test('图的描述也走同一封套', () => {
    const out = imageHandoffText('一张报错截图', at);
    assert.equal(out, '（桌宠看过了这张图 · 14:32）\n一张报错截图\n' + HANDOFF_TAIL);
  });
});
