/**
 * 一个喇叭的单测（`src/host/core/speaker.ts`）。
 *
 * 这几条全是哥哥 11-09 晚口述的规矩，钉住它们，以后谁改都不能悄悄改掉：
 * 不叠音、碎碎念可丢、高等级插队、队列有上限。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  SPEAK_QUEUE_MAX,
  admitSpeak,
  pickNext,
  type SpeakRequest,
} from './speaker';

const req = (key: string, priority: SpeakRequest['priority'] = 'normal'): SpeakRequest => ({ key, priority });

describe('admitSpeak：谁能进来', () => {
  test('空闲时直接放行，队列就它一条', () => {
    const result = admitSpeak(false, [], req('a', 'high'));
    assert.equal(result.admit, true);
    if (!result.admit) return;
    assert.deepEqual(result.pending.map((item) => item.key), ['a']);
    assert.deepEqual(result.evicted, []);
  });

  test('正在说话时碎碎念被丢掉，不排队', () => {
    const result = admitSpeak(true, [], req('whisper', 'low'));
    assert.equal(result.admit, false);
    if (result.admit) return;
    assert.equal(result.reason, 'busy-low');
  });

  test('同一句已经在排着：不重复念', () => {
    const result = admitSpeak(false, [req('same', 'high')], req('same', 'high'));
    assert.equal(result.admit, false);
    if (result.admit) return;
    assert.equal(result.reason, 'duplicate');
  });

  test('高等级进来时，排着的碎碎念被清掉', () => {
    const result = admitSpeak(false, [req('w1', 'low'), req('w2', 'low')], req('look', 'high'));
    assert.equal(result.admit, true);
    if (!result.admit) return;
    assert.deepEqual(result.pending.map((item) => item.key), ['look']);
    assert.equal(result.evicted.length, 2);
  });

  test('低等级不挤掉正在等的高等级', () => {
    const result = admitSpeak(false, [req('look', 'high')], req('chat', 'normal'));
    assert.equal(result.admit, true);
    if (!result.admit) return;
    assert.deepEqual(result.pending.map((item) => item.key), ['look', 'chat']);
  });

  test('队列满了：丢等级最低、同级里最老的那条', () => {
    const pending = [req('a', 'high'), req('b', 'low'), req('c', 'normal')];
    assert.equal(pending.length, SPEAK_QUEUE_MAX);
    const result = admitSpeak(false, pending, req('d', 'high'));
    assert.equal(result.admit, true);
    if (!result.admit) return;
    assert.deepEqual(result.pending.map((item) => item.key), ['a', 'c', 'd']);
    assert.deepEqual(result.evicted.map((item) => item.key), ['b']);
  });

  test('队列满了、自己又是最低等级：自己都进不去', () => {
    const pending = [req('a', 'high'), req('b', 'high'), req('c', 'normal')];
    const result = admitSpeak(false, pending, req('w', 'low'));
    assert.equal(result.admit, false);
    if (result.admit) return;
    assert.equal(result.reason, 'queue-full-low');
  });
});

describe('pickNext：该谁先说', () => {
  test('等级高的先来', () => {
    const picked = pickNext([req('chat', 'normal'), req('watch', 'high'), req('w', 'low')]);
    assert.equal(picked.next?.key, 'watch');
    assert.deepEqual(picked.rest.map((item) => item.key), ['chat', 'w']);
  });

  test('同级按进来的顺序', () => {
    const picked = pickNext([req('first', 'normal'), req('second', 'normal')]);
    assert.equal(picked.next?.key, 'first');
    assert.deepEqual(picked.rest.map((item) => item.key), ['second']);
  });

  test('空队列没有下一条', () => {
    const picked = pickNext([]);
    assert.equal(picked.next, undefined);
    assert.deepEqual(picked.rest, []);
  });
});