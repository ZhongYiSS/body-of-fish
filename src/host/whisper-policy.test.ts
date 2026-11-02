import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WHISPER_JITTER, automaticWhisperSchedule } from './whisper-policy.ts';

// 固定随机数，让抖动可预测（0.5 = 抖动区间的正中间 = 不加不减）
const mid = { random: () => 0.5 };

/** 独立模式的策略桩：排期只读 `isReady()`，另两个成员留着只为接口兼容 */
const policy = { isReady: () => true, canWhisper: () => true, whisperIntervalSec: () => 90 };

test('DSH scheduling preserves existing pet flag and configured cadence', () => {
  // 插件模式走老路：不加抖动（那边早有自己的一套节奏，不能悄悄改）
  assert.deepEqual(automaticWhisperSchedule(undefined, true, 125), { enabled: true, periodSec: 125 });
  assert.deepEqual(automaticWhisperSchedule(undefined, false, 125), { enabled: false, periodSec: 125 });
});

test('standalone scheduling：宠物开关是唯一的「说不说」，间隔只来自配置', () => {
  // 间隔来自 configuredPeriodSec（右键菜单/设置页写的就是它），不是策略桩里的 90
  assert.deepEqual(automaticWhisperSchedule(policy, true, 300, mid), { enabled: true, periodSec: 300 });
  assert.equal(automaticWhisperSchedule(policy, false, 300, mid).enabled, false);
  assert.equal(automaticWhisperSchedule({ ...policy, isReady: () => false }, true, 300, mid).enabled, false);
});

test('本地池有货就绕开「云端就绪」闸 —— 没配 key 也能碎碎念，但宠物开关仍然说话算数', () => {
  const offline = { isReady: () => false, canWhisper: () => true, whisperIntervalSec: () => 120 };
  // 没池子：没得抽，也不能偷偷调云端 → 安静
  assert.equal(automaticWhisperSchedule(offline, true, 300, mid).enabled, false);
  // 有池子：纯本地抽卡，不需要云端；间隔仍按配置的 300
  assert.deepEqual(automaticWhisperSchedule(offline, true, 300, { ...mid, hasLocalPool: true }), {
    enabled: true,
    periodSec: 300,
  });
  // 宠物自己的开关是硬闸：关了就是不说，池子再满也不许说
  assert.equal(automaticWhisperSchedule(offline, false, 300, { ...mid, hasLocalPool: true }).enabled, false);
});

test('周期带 ±20% 抖动：不会每 5 分钟整点打卡，也不会掉到 1 秒', () => {
  const low = automaticWhisperSchedule(policy, true, 300, { random: () => 0 }).periodSec;
  const high = automaticWhisperSchedule(policy, true, 300, { random: () => 0.999999 }).periodSec;
  assert.equal(low, Math.round(300 * (1 - WHISPER_JITTER)));
  assert.equal(high, Math.round(300 * (1 + WHISPER_JITTER)));
  assert.ok(low >= 240 && low <= 360, `抖动范围跑偏：${low}`);
  assert.ok(high >= 240 && high <= 360, `抖动范围跑偏：${high}`);
  // 每次取值都落在区间内，且不是常量（常量就等于没抖动）
  const samples = new Set(
    [0, 0.25, 0.5, 0.75, 0.999999].map(
      (r) => automaticWhisperSchedule(policy, true, 300, { random: () => r }).periodSec,
    ),
  );
  assert.ok(samples.size > 1, '抖动没生效：每次都是同一个周期');
  for (const sec of samples) assert.ok(sec >= 240 && sec <= 360, `抖出区间：${sec}`);
});

test('坏配置也不会把碎碎念变成连发循环', () => {
  // 下限 60 秒是硬闸：抖动在夹紧**之后**算，且算完再夹一次，绝不可能出现几十毫秒的连发
  for (const r of [0, 0.5, 0.999999]) {
    const sec = automaticWhisperSchedule(policy, true, 0, { random: () => r }).periodSec;
    assert.ok(sec >= 60, `下限被抖动吃掉了：${sec}`);
  }
  assert.equal(automaticWhisperSchedule(policy, true, Number.NaN, mid).periodSec, 300);
  assert.equal(automaticWhisperSchedule(policy, true, 30, mid).periodSec, 60);
});
