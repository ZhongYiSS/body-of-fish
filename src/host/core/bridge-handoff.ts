/**
 * 「接入 DSH」时，把身体看到的东西交给会话的那几句话（哥哥 11-09 定 A 方案；
 * 11-17 m26253 起改成「信封」：动作 + 时间 + 转述声明）。
 *
 * 为什么要有信封：投进会话的是**她看到的东西**，不是用户说的话。以前只有一句
 * 「（桌宠看了一眼屏幕：…）」，DSH 那边分不清这句话是谁说的、什么时候说的，
 * 容易当成用户在描述，也容易把「她看到的标题」当成用户的话复述。
 *
 * 现在固定三段：
 *   第一行  动作 + 时间            （桌宠看了一眼屏幕 · 14:32）
 *   第二行  她看到的（压成一行、封顶 400 字）
 *   第三行  转述声明               （以上是桌宠的转述，不是他说的话）
 */

export type HandoffKind = 'look' | 'watch' | 'image';

/** 投进会话的正文上限（DSH 那边是聊天消息，太长会淹没上下文） */
export const HANDOFF_MAX = 400;

const ACTION: Record<HandoffKind, string> = {
  look: '桌宠看了一眼屏幕',
  watch: '桌宠陪你看了一会儿',
  image: '桌宠看过了这张图',
};

/** 转述声明：让人一眼看出这段不是用户说的 */
export const HANDOFF_TAIL = '（以上是桌宠的转述，不是他说的话）';

const two = (n: number): string => String(n).padStart(2, '0');

/** 信封第一行：动作 + 时间（HH:MM） */
export function handoffHeader(kind: HandoffKind, at: Date = new Date()): string {
  return `（${ACTION[kind]} · ${two(at.getHours())}:${two(at.getMinutes())}）`;
}

/**
 * 把识图描述包成投进会话的三段话；空描述 → ''（调用方据此决定「这次不投」）。
 * 正文里的换行/连续空白压成一个空格：DSH 那边一条消息最干净。
 */
export function handoffText(kind: HandoffKind, detail: string, at: Date = new Date()): string {
  const clean = String(detail ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean === '') return '';
  const body = clean.length > HANDOFF_MAX ? `${clean.slice(0, HANDOFF_MAX)}…` : clean;
  return `${handoffHeader(kind, at)}\n${body}\n${HANDOFF_TAIL}`;
}

/** 「这张图」那条：识图描述 → 三段话（动作是「看过了这张图」） */
export function imageHandoffText(detail: string, at: Date = new Date()): string {
  return handoffText('image', detail, at);
}