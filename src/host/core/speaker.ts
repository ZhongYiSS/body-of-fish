/**
 * 桌宠 2.0 · 一个喇叭（说话排队契约）
 *
 * 哥哥 11-09 晚定：**只有一个喇叭**。想出声的都不许自己开嘴——
 *   ① 上一句没说完，谁都不许张嘴（不打断、不叠音）；
 *   ② 优先级：`high`（看一眼 / 陪伴，他要的陪伴感）> `normal`（对话 / DSH 朗读）> `low`（碎碎念）；
 *   ③ `low` 是**可以丢的**：正在说话时来的碎碎念直接扔掉（说完早就过期了，而且气泡会盖掉正在说的那句）；
 *   ④ 排队上限 3 条：说的时候这些话早过期了，留一屋子只会越念越旧。
 *
 * 铁律：只有纯函数，无 IO、无定时器；真正合成/播放/写气泡都在 host 里。
 */

export type SpeakPriority = 'low' | 'normal' | 'high';

/** 一条排队请求（正文留在 host 里，这里只认身份和等级） */
export interface SpeakRequest {
  /** 同一段话只留一条：菜单连点两下、桥重发一次，不该念两遍 */
  key: string;
  priority: SpeakPriority;
}

export const SPEAK_RANK: Record<SpeakPriority, number> = { low: 0, normal: 1, high: 2 };

/** 排队上限：超了丢「等级最低、且最老」的那条 */
export const SPEAK_QUEUE_MAX = 3;

export type AdmitResult =
  | {
      admit: true;
      /** 排完之后的新队列（调用方直接替换） */
      pending: SpeakRequest[];
      /** 这次顺手挤掉了谁（用来写日志，不影响行为） */
      evicted: SpeakRequest[];
    }
  | { admit: false; reason: 'busy-low' | 'duplicate' | 'queue-full-low' };

/** 现在能不能立刻开口：队列空 = 直接说，否则排队等前面说完 */
export function admitSpeak(
  active: boolean,
  pending: readonly SpeakRequest[],
  next: SpeakRequest,
): AdmitResult {
  // 同一句已经在排着（或正在说）：不重复
  if (pending.some((item) => item.key === next.key)) return { admit: false, reason: 'duplicate' };

  // 正在说话时的碎碎念：丢掉，不排队（说的时候一定过期）
  if (active && next.priority === 'low') return { admit: false, reason: 'busy-low' };

  let queue = [...pending];
  const evicted: SpeakRequest[] = [];

  // 高等级来了：排着的碎碎念一律清掉（它们已经没意义了）
  if (next.priority !== 'low') {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].priority === 'low') {
        evicted.push(queue[i]);
        queue.splice(i, 1);
      }
    }
  }

  queue.push(next);

  // 超过上限：丢「等级最低、同级里最老」的一条
  while (queue.length > SPEAK_QUEUE_MAX) {
    let victim = 0;
    for (let i = 1; i < queue.length; i += 1) {
      const rankGap = SPEAK_RANK[queue[i].priority] - SPEAK_RANK[queue[victim].priority];
      if (rankGap < 0) victim = i; // 更低的等级：它就是该被丢的那个
    }
    const [dropped] = queue.splice(victim, 1);
    if (dropped.key === next.key) return { admit: false, reason: 'queue-full-low' };
    evicted.push(dropped);
  }

  return { admit: true, pending: queue, evicted };
}

/** 下一条该谁说：等级最高的先来，同级按进来的顺序 */
export function pickNext(pending: readonly SpeakRequest[]): {
  next?: SpeakRequest;
  rest: SpeakRequest[];
} {
  if (pending.length === 0) return { rest: [] };
  let best = 0;
  for (let i = 1; i < pending.length; i += 1) {
    if (SPEAK_RANK[pending[i].priority] > SPEAK_RANK[pending[best].priority]) best = i;
  }
  const rest = pending.filter((_, index) => index !== best);
  return { next: pending[best], rest };
}