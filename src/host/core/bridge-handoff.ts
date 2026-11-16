/**
 * 「接入 DSH」时，把身体看到的东西交给会话的那句话（哥哥 11-09 定 A 方案）。
 *
 * 为什么要单独一个模块：以前身体在接入时**自己先说一遍**（识图 → 聊天模型 → 念出来），
 * 紧接着又把描述投进会话，DSH 那边再答一句、桥再推回来——同一件事她说两遍。
 * 现在接入时身体只负责「看」，说什么交给会话；这里只做一件纯事：
 * 把描述压成一句能投进会话的话，长度封顶，不夹带路径/换行。
 */

export type HandoffKind = 'look' | 'watch';

/** 投进会话的正文上限（DSH 那边是聊天消息，太长会淹没上下文） */
export const HANDOFF_MAX = 400;

const LABEL: Record<HandoffKind, string> = {
  look: '（桌宠看了一眼屏幕：',
  watch: '（桌宠陪你看了一会儿：',
};

/** 把识图描述压成一句交给会话的话；空描述 → ''（调用方据此决定「这次不投」） */
export function handoffText(kind: HandoffKind, detail: string): string {
  const clean = String(detail ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean === '') return '';
  const body = clean.length > HANDOFF_MAX ? `${clean.slice(0, HANDOFF_MAX)}…` : clean;
  return `${LABEL[kind]}${body}）`;
}