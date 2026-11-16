import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPEAK_EXPIRE_MS,
  SPEAK_QUEUE_MAX,
  SPEAK_RANK,
  admitSpeak,
  expirePending,
  jobGuardMs,
  pickNext,
  playGuardMs,
  SYNTH_GUARD_MS,
  speakBudgetMs,
  type SpeakJob,
} from './speak-center.ts';

function job(key: string, priority: SpeakJob['priority'], at = 1_000, text = '你好'): SpeakJob {
  return {
    key,
    priority,
    enqueuedAt: at,
    kind: 'say',
    text,
    chars: Array.from(text).length,
  };
}

test('等级：urgent > high > normal > low', () => {
  assert.ok(SPEAK_RANK.urgent > SPEAK_RANK.high);
  assert.ok(SPEAK_RANK.high > SPEAK_RANK.normal);
  assert.ok(SPEAK_RANK.normal > SPEAK_RANK.low);
});

test('urgent 收下并清空排队的（手动动作大于一切）', () => {
  const pending = [job('a', 'high'), job('b', 'normal')];
  const out = admitSpeak(job('x', 'low'), pending, job('u', 'urgent'));
  assert.equal(out.accepted, true);
  assert.deepEqual(
    out.queue.map((item) => item.key),
    ['u'],
  );
  assert.deepEqual(
    out.dropped.map((item) => item.key),
    ['a', 'b'],
  );
});

test('正在说话时来的 low 直接丢，不排队', () => {
  const out = admitSpeak(job('a', 'normal'), [], job('b', 'low'));
  assert.equal(out.accepted, false);
  assert.equal(out.reason, 'busy-low');
});

test('空闲时 low 可以排', () => {
  const out = admitSpeak(null, [], job('b', 'low'));
  assert.equal(out.accepted, true);
  assert.equal(out.queue.length, 1);
});

test('同一个 key 不重复排', () => {
  const out = admitSpeak(null, [job('a', 'normal')], job('a', 'normal'));
  assert.equal(out.accepted, false);
  assert.equal(out.reason, 'duplicate');
});

test('高等级进来会顺手清掉排着的 low', () => {
  const out = admitSpeak(null, [job('a', 'low'), job('b', 'normal')], job('c', 'high'));
  assert.equal(out.accepted, true);
  assert.deepEqual(
    out.queue.map((item) => item.key),
    ['b', 'c'],
  );
  assert.deepEqual(
    out.dropped.map((item) => item.key),
    ['a'],
  );
});

test('超过上限丢「等级最低、同级最老」', () => {
  const pending = [job('a', 'normal', 1_000), job('b', 'normal', 2_000), job('c', 'normal', 3_000)];
  const out = admitSpeak(null, pending, job('d', 'normal', 4_000));
  assert.equal(out.accepted, true);
  assert.equal(out.queue.length, SPEAK_QUEUE_MAX);
  assert.deepEqual(
    out.queue.map((item) => item.key),
    ['b', 'c', 'd'],
  );
  assert.deepEqual(
    out.dropped.map((item) => item.key),
    ['a'],
  );
});

test('自己就是被挤掉的那条时返回 queue-full-low', () => {
  const pending = [job('a', 'high', 1_000), job('b', 'high', 2_000), job('c', 'high', 3_000)];
  const out = admitSpeak(null, pending, job('d', 'normal', 4_000));
  assert.equal(out.accepted, false);
  assert.equal(out.reason, 'queue-full-low');
  assert.deepEqual(
    out.queue.map((item) => item.key),
    ['a', 'b', 'c'],
  );
});

test('排队老化：超过 12 秒的作废，剩下的保持顺序', () => {
  const pending = [job('old', 'normal', 0), job('new', 'normal', 10_000)];
  const out = expirePending(pending, SPEAK_EXPIRE_MS + 5_000);
  assert.deepEqual(
    out.expired.map((item) => item.key),
    ['old'],
  );
  assert.deepEqual(
    out.keep.map((item) => item.key),
    ['new'],
  );
});

test('排队老化：刚好 12 秒还不算过期', () => {
  const out = expirePending([job('a', 'normal', 0)], SPEAK_EXPIRE_MS);
  assert.equal(out.keep.length, 1);
});

test('pickNext 先挑等级高的，同级挑老的', () => {
  const pending = [job('a', 'normal', 5_000), job('b', 'high', 9_000), job('c', 'normal', 1_000)];
  const picked = pickNext(pending);
  assert.equal(picked.next?.key, 'b');
  assert.deepEqual(
    picked.rest.map((item) => item.key),
    ['a', 'c'],
  );
  const second = pickNext(picked.rest);
  assert.equal(second.next?.key, 'c');
});

test('speakBudgetMs：短句 15 秒起底，长句封顶 60 秒', () => {
  assert.equal(speakBudgetMs(''), 15_000);
  assert.equal(speakBudgetMs('好'), 15_000);
  assert.equal(speakBudgetMs('啊'.repeat(40)), 15_000);
  const mid = speakBudgetMs('啊'.repeat(120));
  assert.ok(mid > 15_000 && mid < 60_000);
  assert.equal(speakBudgetMs('啊'.repeat(1_000)), 60_000);
});

test('jobGuardMs：知道音频时长就按时长 + 5 秒，封顶 60 秒', () => {
  assert.equal(jobGuardMs({ text: '你好', kind: 'say' }, 3_000), 8_000);
  assert.equal(jobGuardMs({ text: '你好', kind: 'say' }, 58_000), 60_000);
  assert.equal(jobGuardMs({ text: '你好', kind: 'say' }, 500), 6_000);
});

test('jobGuardMs：不知道时长按字数估', () => {
  assert.equal(jobGuardMs({ text: '好', kind: 'say' }), 15_000);
  assert.equal(jobGuardMs({ text: '好', kind: 'clip' }), 15_000);
  assert.equal(jobGuardMs({ text: '啊'.repeat(1_000), kind: 'say' }), 60_000);
  assert.equal(jobGuardMs({ text: '好', kind: 'say' }, Number.NaN), 15_000);
});

test('playGuardMs：出声阶段从开始播放算，音频时长 + 3 秒', () => {
  assert.equal(playGuardMs(5_000), 8_000);
  assert.equal(playGuardMs(500), 6_000);
  assert.equal(playGuardMs(120_000), 123_000);
  assert.equal(playGuardMs(), 60_000);
  assert.equal(playGuardMs(Number.NaN), 60_000);
  assert.equal(playGuardMs(10_000_000), 300_000);
});

test('SYNTH_GUARD_MS：合成阶段固定 30 秒，与音频时长无关', () => {
  assert.equal(SYNTH_GUARD_MS, 30_000);
});

test('expirePending：可以传自定义过期时长（设置页的 voice.staleSec）', () => {
  const pending = [job('a', 'normal', 0)];
  assert.equal(expirePending(pending, 10_000, 15_000).expired.length, 0);
  assert.equal(expirePending(pending, 16_000, 15_000).expired.length, 1);
  assert.equal(expirePending(pending, 3_000, 2_000).expired[0].key, 'a');
});
