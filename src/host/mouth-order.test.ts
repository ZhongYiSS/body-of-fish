/**
 * 气泡与提示的先后（哥哥 11-20 m30910）：
 * 1) 碎碎念（1 级）不许盖掉陪伴 / 一眼看刚写的那句，也不许把正在念的话掐掉；
 * 2) 【在说】要等声音真的起来才挂 —— 原来在合成前就挂，看起来像「提示先冒、声音后到」。
 *
 * 这一份是结构契约（读源码），因为这两条都靠「谁先谁后」，行为测试抓不稳。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const indexCode = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8').split('\r\n').join('\n');

test('碎碎念让位：写气泡前先看占位权', () => {
  assert.ok(indexCode.includes('sayBubbleGuard'), '没有 sayBubbleGuard');
  assert.ok(indexCode.includes('skip-now'), '低级别被挡时要有 skip-now 日志');
  // 判据：level < 2 且占位权没过期且对方级别更高 → 直接 return
  const at = indexCode.indexOf('const writeSayNow = (');
  assert.ok(at > 0);
  const body = indexCode.slice(at, at + 700);
  assert.match(body, /level < 2/u);
  assert.match(body, /sayBubbleGuard\.level > level/u);
  assert.match(body, /return;/u);
});

test('碎碎念不再掐话：嘴忙时整条跳过，不推 epoch', () => {
  const at = indexCode.indexOf('const publishWhisper = async (');
  assert.ok(at > 0);
  const body = indexCode.slice(at, indexCode.indexOf('const chatWithPet = async (', at));
  const guard = body.indexOf('if (speakBusy())');
  const bump = body.indexOf('epoch += 1');
  assert.ok(guard > 0, '碎碎念入口没有 speakBusy 守卫');
  assert.ok(bump > guard, 'epoch += 1 必须在 speakBusy 守卫之后（否则先掐后判）');
  assert.match(body, /reason: 'mouth-busy'/u);
});

test('【在说】挂在声音起来那一刻，不在合成前', () => {
  // 旧位置（runSpeakText 开头）不许再有
  const head = indexCode.indexOf('const runSpeakText = async (');
  const headBody = indexCode.slice(head, indexCode.indexOf('const runSpeakTextInner = async (', head));
  assert.ok(!headBody.includes("pushHint('say'"), 'runSpeakText 开头还在挂【在说】');

  // 新位置：show() 里，紧跟在 bubbleOwner 赋值之后
  const showAt = indexCode.indexOf('const show = (): void => {', indexCode.indexOf('const runSpeakTextInner = async ('));
  assert.ok(showAt > 0);
  const showBody = indexCode.slice(showAt, showAt + 1_200);
  const ownerAt = showBody.indexOf('bubbleOwner = { petId, source };');
  const hintAt = showBody.indexOf("pushHint('say'");
  assert.ok(ownerAt > 0, 'show() 里找不到 bubbleOwner');
  assert.ok(hintAt > ownerAt, '【在说】必须在 bubbleOwner 之后（= 播起来了）');
});