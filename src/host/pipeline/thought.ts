/**
 * 「想说没说」的记账规则（待办第 1 条）。
 *
 * 她排上了队、但没轮到的句子（队列满 / 被同类顶掉 / 等太久过期 / 被手动打断），
 * 不写进主气泡、也不出声，但值得让她自己记一笔：下一轮聊天时知道自己「刚才想说什么」。
 *
 * 只记 high 以上的任务：碎碎念（low）和普通对话（normal）天天被丢，记了只会变成噪音。
 * 纯函数，不碰 IO —— 落盘由宿主调 `sessionStore.append({kind:'thought'})`。
 */
export const THOUGHT_WINDOW_MS = 30 * 60_000;
export const THOUGHT_MAX = 3;

export type ThoughtReason = 'queue-full' | 'replaced' | 'expired' | 'interrupted';

const REASONS: readonly string[] = ['queue-full', 'replaced', 'expired', 'interrupted'];

/** 这一条丢掉的说话任务，值得记成 thought 吗？ */
export function shouldRecordThought(priority: string, reason: string | undefined): reason is ThoughtReason {
  if (reason === undefined || !REASONS.includes(reason)) return false;
  // 只有「她本来要开口」的那两级：陪伴 / 一眼看（high）、手动（urgent）
  return priority === 'high' || priority === 'urgent';
}

/** 从卷里挑出最近的几条 thought（30 分钟内、最多 3 条、新的在前）。 */
export function recentThoughts(
  turns: readonly { at: number; kind: string; text: string }[],
  nowMs: number,
  limit = THOUGHT_MAX,
): string[] {
  const picked: string[] = [];
  for (let i = turns.length - 1; i >= 0 && picked.length < limit; i -= 1) {
    const turn = turns[i];
    if (turn === undefined) continue;
    if (turn.kind !== 'thought') continue;
    if (nowMs - turn.at > THOUGHT_WINDOW_MS) continue;
    const text = turn.text.trim();
    if (text === '') continue;
    picked.push(text);
  }
  return picked;
}

/** 同一句话反复被丢（同一轮里多次重排）只记一次。 */
export function isDuplicateThought(
  last: { text: string; at: number } | null,
  text: string,
  nowMs: number,
  windowMs = 3 * 60_000,
): boolean {
  if (last === null) return false;
  return last.text === text.trim() && nowMs - last.at <= windowMs;
}