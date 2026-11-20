/**
 * 输入 · 耳朵：他按着 Alt+T 说话，`听.py` 出字后交进来。
 *
 * 干什么：把「听到的一句话」包成事件，等级 3（他在跟我说话）。
 *         真·紧急提醒（将来）走 5 级，用 `level` 显式传。
 * 什么时候用：`/ear` 收到 `text` 事件之后。
 * 什么时候别用：别在这里喊「想」——交给 `emitSense`。
 * 常见坑：`text` 可能带换行与前后空格，调用方先 trim；空串不要交。
 */
import type { SourceSpec } from '../pipeline/registry';
import { makeEvent } from '../pipeline/sense';
import type { Level, SenseEvent } from '../pipeline/types';

export const EAR_SOURCE: SourceSpec = {
  id: 'ear',
  title: '耳朵：按着说话，ASR 出字',
  levels: [3, 5],
};

export function earEvent(text: string, at?: number): SenseEvent {
  return makeEvent({
    kind: 'heard',
    source: 'ear',
    text,
    ...(at === undefined ? {} : { at }),
  });
}

export function urgentEvent(text: string, at?: number): SenseEvent {
  const level: Level = 5;
  return makeEvent({
    kind: 'heard',
    source: 'ear',
    text,
    level,
    ...(at === undefined ? {} : { at }),
  });
}