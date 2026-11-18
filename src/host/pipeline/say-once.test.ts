/**
 * 「说一句」的纯函数测试（待办第 4 条，2026-11-18）。
 *
 * 守的是四件事：
 *   1. 时辰分档对（半夜说「还没睡呀」，不会冒「早上好」）；
 *   2. 兜底台词会避开最近说过的；
 *   3. 提示词里带时辰、带上回的摘要、带「刚说过的别重复」；思考过但没出口的不算「他说的」；
 *   4. 模型回的话要清干净（引号、动作括号、多余句子）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { dayPartOf, dayPartWord, pickFallback, RECENT_KEEP, sayOncePrompt, tidySayOnce } from './say-once.ts';

const at = (hour: number): number => new Date(2026, 10, 18, hour, 30, 0).getTime();

test('时辰分档：五个档位边界对', () => {
  assert.equal(dayPartOf(at(0)), 'lateNight');
  assert.equal(dayPartOf(at(4)), 'lateNight');
  assert.equal(dayPartOf(at(5)), 'morning');
  assert.equal(dayPartOf(at(10)), 'morning');
  assert.equal(dayPartOf(at(11)), 'noon');
  assert.equal(dayPartOf(at(12)), 'noon');
  assert.equal(dayPartOf(at(13)), 'afternoon');
  assert.equal(dayPartOf(at(17)), 'afternoon');
  assert.equal(dayPartOf(at(18)), 'evening');
  assert.equal(dayPartOf(at(23)), 'evening');
  assert.match(dayPartWord('lateNight'), /深夜/u);
});

test('兜底台词按时辰挑，且避开最近说过的', () => {
  const late = pickFallback(at(1), [], () => 0);
  assert.ok(['还没睡呀。', '本鱼陪着，别熬太晚。', '灯还亮着呢。', '这个点，泡泡都困了。'].includes(late));
  // 把前三句都标成「刚说过」，再挑就只能剩最后一句
  const remaining = pickFallback(at(1), ['还没睡呀。', '本鱼陪着，别熬太晚。', '灯还亮着呢。'], () => 0.99);
  assert.equal(remaining, '这个点，泡泡都困了。');
  // 全撞了也不许返回空
  const all = ['还没睡呀。', '本鱼陪着，别熬太晚。', '灯还亮着呢。', '这个点，泡泡都困了。'];
  assert.notEqual(pickFallback(at(1), all, () => 0.5), '');
});

test('提示词：带时辰、带上回摘要、带「别重复」，且不把 thought 当他说的', () => {
  const prompt = sayOncePrompt({
    nowMs: at(23),
    summary: '他在改桌宠的嗓子。',
    recent: [
      { kind: 'said', text: '改好了。' },
      { kind: 'thought', text: '想问他累不累（没出口）' },
      { kind: 'heard', text: '今晚收工。' },
    ],
    recentSaid: ['改好了。'],
  });
  assert.match(prompt, /现在是晚上/u);
  assert.match(prompt, /20 字以内/u);
  assert.match(prompt, /【上回说到】他在改桌宠的嗓子。/u);
  assert.match(prompt, /【刚说过的（别重复）】改好了。/u);
  assert.match(prompt, /你：改好了。/u);
  assert.match(prompt, /他：今晚收工。/u);
  assert.ok(!prompt.includes('想问他累不累'), 'thought 不该进「刚才那几句」');
});

test('提示词：没摘要没历史时也能拼出来（不出现空标题）', () => {
  const prompt = sayOncePrompt({ nowMs: at(9), summary: '', recent: [], recentSaid: [] });
  assert.match(prompt, /现在是上午/u);
  assert.ok(!prompt.includes('【上回说到】'));
  assert.ok(!prompt.includes('【刚说过的'));
  assert.ok(!prompt.includes('【刚才那几句】'));
});

test('tidySayOnce：去引号、只留第一句、去掉换行后面的内容', () => {
  assert.equal(tidySayOnce('「本鱼在呢。」'), '本鱼在呢。');
  assert.equal(tidySayOnce('‘早呀。’'), '早呀。');
  assert.equal(tidySayOnce('本鱼在呢。\n（她眨眨眼）'), '本鱼在呢。');
  assert.equal(tidySayOnce('  \n  还没睡呀？  \n'), '还没睡呀？');
  // 超长截到 40 字以内
  const long = tidySayOnce('泡泡'.repeat(60));
  assert.ok(long.length <= 40);
  // 空输入不许抛
  assert.equal(tidySayOnce(''), '');
});

test('RECENT_KEEP 是 3（提示词里最多也只看 3 句）', () => {
  assert.equal(RECENT_KEEP, 3);
  const prompt = sayOncePrompt({
    nowMs: at(15),
    summary: '',
    recent: [],
    recentSaid: ['一。', '二。', '三。', '四。'],
  });
  // slice(-3) 留最新的三句，最早那句不进提示词
  assert.match(prompt, /【刚说过的（别重复）】二。 \/ 三。 \/ 四。/u);
  assert.ok(!prompt.includes('一。'));
});