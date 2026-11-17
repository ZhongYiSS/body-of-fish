/**
 * 身体的五级台阶：谁排在前面、谁能打断谁（第一批 · 纯函数）
 *
 * 哥哥 11-17 拍了三件事，这里全部照它写死：
 *   1. **等级是听和看自带的**，想和嘴一个字都不许改；
 *   2. **及时性和打断是两件事** —— 2 级及以上都不排「想」的队，只是打断别人时级别低；
 *   3. 五级：5 听一句/紧急 · 4 手动（看一眼、说一句、桥 say-loud）· 3 对话 · 2 主动（陪伴/一眼看）· 1 碎碎念。
 *
 * 设计文档：`C:/Users/hb109/Desktop/身体修改思路.md` 第 2、3 章与 9.1。
 */

import type { SpeakPriority } from '../core/speak-center';
import type { Level, SenseEvent } from './types';

/** 五级全列一遍（顺序固定，别处照这个遍历） */
export const LEVELS: readonly Level[] = [1, 2, 3, 4, 5];

/** 给人看的写法，日志和状态里用 */
export const LEVEL_WORD: Readonly<Record<Level, string>> = {
  1: '碎碎念',
  2: '主动',
  3: '对话',
  4: '手动',
  5: '听一句',
};

/**
 * 打断台阶：`LEVEL_INTERRUPT[新来的][正在占嘴的]`。
 * - `'in'`  能顶掉它（正在说的也算）
 * - `'next'` 只能顶掉「还没开播」的那条，正在说就等它说完
 * - `'no'`  让路
 *
 * 规矩来源（哥哥逐条确认过）：
 *   - 5 级谁都能打断，连正在说的 5 也掐（他按下按钮那一刻就是要立刻听到）；
 *   - 4 级能打断 3/2/1，对 4、5 让路；
 *   - 3 级能打断 2/1，对 3 只顶「还没开播」，对 4/5 让路；
 *   - 2 级只能打断 1（碎碎念）；
 *   - 1 级谁都不打断。
 */
const LEVEL_INTERRUPT: Readonly<Record<Level, Readonly<Record<Level, 'in' | 'next' | 'no'>>>> = {
  5: { 1: 'in', 2: 'in', 3: 'in', 4: 'in', 5: 'in' },
  4: { 1: 'in', 2: 'in', 3: 'in', 4: 'no', 5: 'no' },
  3: { 1: 'in', 2: 'in', 3: 'next', 4: 'no', 5: 'no' },
  2: { 1: 'in', 2: 'no', 3: 'no', 4: 'no', 5: 'no' },
  1: { 1: 'no', 2: 'no', 3: 'no', 4: 'no', 5: 'no' },
};

/** 消息在嘴那边的状态：还没开播 = `queued`，已经在说 = `speaking` */
export type MouthSlot = 'queued' | 'speaking';

/**
 * 新来的这条能不能打断正在占嘴的那条。
 * 注意：这只回答「能不能插队」。**及时性另算** —— 2~5 级不管嘴空不空都先送去合成，
 * 不等别人想完（哥哥 11-17：陪伴要及时，只是打断时级别低）。
 */
export function canInterrupt(incoming: Level, current: Level, slot: MouthSlot): boolean {
  const step = LEVEL_INTERRUPT[incoming][current];
  if (step === 'in') return true;
  if (step === 'next') return slot === 'queued';
  return false;
}

/**
 * 回话的等级**不照抄**事件的等级（文档 2.2）：
 *   - 他正在说话（5 级事件）→ 回话 5 级，先让他听见；
 *   - 手动入口（4 级）→ 回话 4 级；
 *   - 他打字聊天（3 级）→ 回话 3 级；
 *   - 屏幕自己看到（2 级）→ 回话 2 级。
 */
export function replyLevel(event: Pick<SenseEvent, 'kind' | 'level'>): Level {
  if (event.kind === 'seen') return 2;
  if (event.level >= 4) return 5;
  if (event.level === 3) return 3;
  return 2;
}

/**
 * 嘴忙的时候，这条要不要直接丢。
 * 只有 1 级（碎碎念）会被丢 —— 说的时候一定已经过期了；2 级及以上一律排队等。
 */
export function droppableWhenBusy(level: Level): boolean {
  return level === 1;
}

/**
 * 这条最多能排多久（毫秒）。5 级不过期（他按下按钮那句话不能等成化石）。
 * 其余沿用 11-15 定的 15 秒。
 */
export const LEVEL_EXPIRE_MS: Readonly<Record<Level, number>> = {
  1: 15_000,
  2: 15_000,
  3: 15_000,
  4: 15_000,
  5: Number.POSITIVE_INFINITY,
};

/** 排队上限：超了先丢最低、同级的丢最老（5 级永远不丢） */
export const MOUTH_QUEUE_MAX = 3;

/**
 * 五级台阶落到「嘴」的四个优先级上（`speak-center.ts` 里的老四档必须够用——
 * 换一套并行机制就会有两份仲裁，那是 bug 工厂）。
 *
 *   5 听一句 / 紧急  → urgent（谁都能掐）
 *   4 手动          → urgent
 *   3 对话          → normal
 *   2 主动（陪伴/一眼看）→ high
 *   1 碎碎念        → low（谁都能把它挤掉）
 */
export function priorityFor(level: Level): SpeakPriority {
  if (level >= 4) return 'urgent';
  if (level === 3) return 'normal';
  if (level === 2) return 'high';
  return 'low';
}
