import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { HANDOFF_MAX, handoffText } from './bridge-handoff.ts';

describe('接入 DSH 时的交接文案（哥哥 11-09 选 A：身体只看、会话来说）', () => {
  test('看一眼的描述包成一句，换行/多空格压平', () => {
    assert.equal(
      handoffText('look', '  窗口标题是「技术手册.md」\n\n左侧目录树在展开 '),
      '（桌宠看了一眼屏幕：窗口标题是「技术手册.md」 左侧目录树在展开）',
    );
  });

  test('陪伴用另一句开头，别和手动看一眼混在一起', () => {
    assert.equal(handoffText('watch', '刷网页'), '（桌宠陪你看了一会儿：刷网页）');
  });

  test('空描述（识图没说出来）→ 空串，调用方据此不投', () => {
    assert.equal(handoffText('look', ''), '');
    assert.equal(handoffText('watch', '   \n  '), '');
  });

  test('超长描述封顶，末尾加省略号（不把整屏文字灌进会话）', () => {
    const long = '字'.repeat(HANDOFF_MAX + 50);
    const out = handoffText('look', long);
    assert.equal(out.startsWith('（桌宠看了一眼屏幕：字'.slice(0, 10)), true);
    assert.equal(out.endsWith('…）'), true);
    assert.equal(out.length, '（桌宠看了一眼屏幕：'.length + HANDOFF_MAX + 2);
  });

  test('刚好等于上限时不加省略号', () => {
    const exact = '字'.repeat(HANDOFF_MAX);
    assert.equal(handoffText('look', exact).endsWith('…）'), false);
  });
});