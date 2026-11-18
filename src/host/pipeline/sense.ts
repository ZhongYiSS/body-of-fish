/**
 * 「听和看」的出入口：**只负责收消息、贴等级、交给想**（第一批 2 刀）。
 *
 * 为什么要有这一层：等级必须是**信息自带的**（哥哥 11-17 的批注三），
 * 到了「想」和「嘴」手里不许再改。所以谁产的事件、就由谁在这里定级：
 *
 *   heard  —— 麦克风听到的一句话：他在跟我说话，3 级
 *   heard  —— 录音里那种「紧急提醒」：5 级（现在还没有来源，先留着口子）
 *   seen   —— 屏幕上的变化：2 级（陪伴/一眼看的主动开口）
 *   command—— 他自己按的（Alt+T / Alt+G / Alt+S / 菜单）：4 级
 *   reminder— 定时提醒之类（将来）：5 级
 */
import type { Level, SenseEvent, SenseKind } from './types';

export interface SenseSource {
  heard: 'ear';
  seen: 'watch';
  command: 'menu' | 'bridge' | 'dsh';
  reminder: 'timer';
}

// hotkey = 全局快捷键（Alt+T 听一句 / Alt+G 看一眼）；和 menu 分开，查账时能分清是点的还是按的。
export type SenseOrigin = 'ear' | 'watch' | 'menu' | 'hotkey' | 'bridge' | 'dsh' | 'timer';

const LEVEL_OF: Record<SenseKind, Level> = {
  heard: 3,
  seen: 2,
  command: 4,
};

let seq = 0;

/**
 * 产一条事件。`level` 可以显式覆盖（目前只有「听一句」会传 5）。
 * 注意：这里不做任何 IO，也不看时间以外的东西 —— 纯函数，好测。
 */
export function makeEvent(input: {
  kind: SenseKind;
  source: SenseOrigin;
  text?: string;
  image?: Uint8Array;
  imageName?: string;
  target?: string;
  level?: Level;
  at?: number;
}): SenseEvent {
  seq += 1;
  const level = input.level ?? LEVEL_OF[input.kind];
  return {
    id: `${input.kind}-${seq}`,
    kind: input.kind,
    level,
    at: input.at ?? Date.now(),
    text: input.text ?? '',
    ...(input.image === undefined ? {} : { image: input.image }),
    ...(input.imageName === undefined ? {} : { imageName: input.imageName }),
    ...(input.target === undefined ? {} : { target: input.target }),
    source: input.source,
  };
}

/** 一行日志用：`seen level=2 source=watch target=chrome` */
export function describeEvent(event: SenseEvent): string {
  const extra = event.target !== undefined ? ` target=${event.target}` : '';
  const chars = event.text !== undefined ? ` chars=${event.text.length}` : '';
  return `${event.kind} level=${event.level} source=${event.source}${extra}${chars}`;
}
