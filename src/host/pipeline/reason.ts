/**
 * 【汐儿 · 11-20 m33631】「这轮为什么开口」——四个开口场景共用的一块提示词。
 *
 * 为什么单独一块：模型不知道自己是被人按了按钮、还是自己到点看了一眼，
 * 于是要么把「陪伴」说成「你在问我」，要么在被叫的时候反过来问他「你在干嘛」。
 * 这块只讲**缘由与时机**，不重复人设（人设管「我是谁」）也不重复 STYLE_RULES（管「怎么说」）。
 *
 * 什么时候别用：回看细节（buildDetailPrompt）与摘要器——那两个是直答/压缩，不需要缘由。
 * 常见坑：idleMs 传 -1（没读到前台）要写成「不知道」，不能当成「他不在」。
 */

export type ReasonKind = 'chat' | 'watch' | 'look' | 'say';

export interface ReasonInput {
  kind: ReasonKind;
  /** 键盘/鼠标空闲多少毫秒；-1 = 没读到前台，不知道 */
  idleMs?: number;
}

const WHY: Record<ReasonKind, string> = {
  chat: '他刚跟你说了话，等着你接',
  watch: '陪伴到点了，你自己看了一眼屏幕',
  look: '他按了「现在看一眼」',
  say: '不是他叫你，是你自己想搭一句',
};

/** 空闲时长说人话：刚碰过 / N 分钟没动 / N 小时没动 / 不知道 */
export function idleText(idleMs: number | undefined): string {
  if (idleMs === undefined || !Number.isFinite(idleMs) || idleMs < 0) return '不知道他人在不在';
  if (idleMs < 60_000) return '刚碰过键盘';
  if (idleMs < 60 * 60_000) return `键盘停了 ${Math.floor(idleMs / 60_000)} 分钟`;
  return `键盘停了 ${Math.floor(idleMs / (60 * 60_000))} 小时`;
}

export function reasonBlock(input: ReasonInput): string {
  return [
    `【这轮为什么开口】${WHY[input.kind]}`,
    `【他在不在听】${idleText(input.idleMs)}`,
    '【怎么开口】真想说才说，没什么好说的就不说（写「-」）；他不在就别说；刚被打断过别追着说。',
  ].join('\n');
}
