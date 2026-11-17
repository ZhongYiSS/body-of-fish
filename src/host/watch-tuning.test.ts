/**
 * 调参与提示词模板的单测（哥哥 m18312：提示词和突变评分都要能在设置里调）。
 *
 * 钉死的语义：
 *   ① 不传/传空 → 原样拿默认，不许变成 0（0 会把识图关死）；
 *   ② 越界要夹住，不能把页面上的手滑值原封不动交给 ffmpeg（0 宽高会直接崩）；
 *   ③ 只给某一档的某一项 → 其余档其余项保持默认，不许整体重置；
 *   ④ 模板占位符：给了就换、没给就原样留着（方便哥哥自己加新占位符试）。
 *
 * 【汐儿 · 11-16 m21304】提示词只剩一套，四套那套断言已删；宫格也删了，`keySpacingSec`
 * 与 `cutWidth/cutHeight` 不再存在（哥哥 m21257：去掉宫格、全力降延迟）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TUNING, normalizeTuning } from './watch-mode';
import { DEFAULT_WATCH_PROMPT, buildWatchPrompt, emptyScene, renderTemplate } from './game-talk';

const BASE_INPUT = {
  scene: emptyScene(0),
  notes: [] as { at: number; note: string; imp: number }[],
  lastSaid: '',
  lastSaidAgoMs: 0,
  idleMs: 12_000,
  persona: '本鱼是钟汐儿，哥哥的妹妹。',
  impNeed: 2,
};

describe('陪伴调参 normalizeTuning', () => {
  test('不给就整份默认', () => {
    const got = normalizeTuning(null);
    assert.deepEqual(got, DEFAULT_TUNING);
    assert.deepEqual(normalizeTuning(undefined), DEFAULT_TUNING);
    assert.deepEqual(normalizeTuning({}), DEFAULT_TUNING);
  });

  test('越界被夹住（不会把 0 宽高交给 ffmpeg）', () => {
    const got = normalizeTuning({
      cutAbs: 9999,
      cutSpike: -5,
      cutMinGapSec: 999,
      settleFrames: 0,
      integralLight: 0,
      stillWidth: 5000,
      stillHeight: 1,
    });
    assert.equal(got.cutAbs, 255);
    assert.equal(got.cutSpike, 1);
    assert.equal(got.cutMinGapSec, 60);
    assert.equal(got.settleFrames, 1);
    assert.equal(got.integralLight, 0.5);
    assert.equal(got.stillWidth, 4096);
    assert.equal(got.stillHeight, 200);
  });

  test('只给一档的一项：别的档、别的项都不动', () => {
    const got = normalizeTuning({ paces: { calm: { minGapSec: 99, integralSec: 8, floorSec: 45 }, normal: DEFAULT_TUNING.paces.normal, dense: DEFAULT_TUNING.paces.dense } });
    assert.equal(got.paces.calm.integralSec, 8);
    assert.equal(got.paces.calm.integralSec, DEFAULT_TUNING.paces.calm.integralSec);
    assert.deepEqual(got.paces.normal, DEFAULT_TUNING.paces.normal);
    assert.deepEqual(got.paces.dense, DEFAULT_TUNING.paces.dense);
  });
});

describe('提示词模板', () => {
  test('占位符：给了就换，没给就原样留着', () => {
    const got = renderTemplate('甲 {{a}} 乙 {{b}}', { a: '1' });
    assert.equal(got, '甲 1 乙 {{b}}');
  });

  test('默认那套是「即时陪伴」口径，说话规矩用共用占位符（11-17 m26171）', () => {
    assert.ok(DEFAULT_WATCH_PROMPT.includes('一边看他屏幕一边随口搭话'));
    assert.ok(DEFAULT_WATCH_PROMPT.includes('{{bili}}'));
    assert.ok(DEFAULT_WATCH_PROMPT.includes('[[web_search:'));
    // 说话规矩从「各写一套 ✗✓ 例子」改成引用共用的一份，两处不再漂
    assert.ok(DEFAULT_WATCH_PROMPT.includes('{{style}}'));
    assert.ok(!DEFAULT_WATCH_PROMPT.includes('✗'));
    assert.ok(!DEFAULT_WATCH_PROMPT.includes('{{story}}'));
  });

  test('默认那套渲染后，说话规矩真的替换进去了', () => {
    const got = buildWatchPrompt({ ...BASE_INPUT, template: DEFAULT_WATCH_PROMPT });
    assert.ok(!got.includes('{{style}}'));
    assert.ok(got.includes('20 字以内'));
    assert.ok(got.includes('闲聊'));
  });

  test('模板留空就用默认那套', () => {
    const got = buildWatchPrompt({ ...BASE_INPUT, template: '   ' });
    assert.ok(got.includes('一边看他屏幕一边随口搭话'));
  });

  test('裁剪过要说清「只截了那个窗口」，整屏要说「整屏」', () => {
    const cropped = buildWatchPrompt({ ...BASE_INPUT, cropped: true });
    assert.ok(cropped.includes('只截了他正在用的那个窗口'));
    const full = buildWatchPrompt({ ...BASE_INPUT, cropped: false });
    assert.ok(full.includes('整屏截图'));
  });

  test('B站梗概：给了就填进 {{bili}}，没给要写明别硬编', () => {
    const without = buildWatchPrompt({ ...BASE_INPUT, template: DEFAULT_WATCH_PROMPT });
    assert.ok(/这轮没有剧情资料/u.test(without));
    const withBili = buildWatchPrompt({
      ...BASE_INPUT,
      template: DEFAULT_WATCH_PROMPT,
      bili: '一个女孩在雨里等人，等到最后也没等到。',
    });
    assert.ok(withBili.includes('一个女孩在雨里等人'));
  });
});
