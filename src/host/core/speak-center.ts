/**
 * 桌宠 2.0 · 嗓子仲裁（一个喇叭，第三版）
 *
 * 哥哥 11-15 晚定：**打断要分级**、**排队要会老化**、**气泡跟声音同一个 job**。
 *
 * 为什么要重写（旧 `speaker.ts` 的四个洞）：
 *   D1 `stopLoud()` 只 kill exclusive 那条，队列里正在播的杀不到 → Alt+T 不闭嘴；
 *   D2 `speakForeign` 是个从没 +1 过的死变量 → 旁路出声时队列不知道；
 *   D3 队列没有时间上限 → 三分钟前的画面还在排队等念；
 *   D4 job 保底固定 120 秒 → 卡住就占嘴两分钟。
 *
 * 这一版把「说一句话」看成一个 **job**：语音 + 气泡 + 表情包绑在一起，一起排队、一起收尾。
 *   - `urgent`（手动：Alt+T / 看一眼 / 说一句 / 桥 say-loud）：**立刻打断**正在播的，并清空队列；
 *   - `high`（陪伴开口 / 一眼看结果）> `normal`（对话 / 桥投喂）> `low`（碎碎念）；
 *   - 正在说时来的 `low` 直接丢（说的时候一定过期）；
 *   - 排队超过 `SPEAK_EXPIRE_MS` 的自动作废；
 *   - 单条上限按「音频时长 + 5 秒」，不知道时长就按字数估，封顶 60 秒。
 *
 * 铁律：只有纯函数，无 IO、无定时器、无全局状态；合成 / 播放 / 写气泡 / 计时全在 host 的 `SpeakCenter` 里。
 */

export type SpeakPriority = 'low' | 'normal' | 'high' | 'urgent';

/** 一条排队请求：身份、等级、进来的时间，外加估算用的字数 */
export interface SpeakJob {
  /** 同一段话只留一条：菜单连点两下、桥重发一次，不该念两遍 */
  key: string;
  priority: SpeakPriority;
  /** 入队时刻（毫秒时间戳），用来做老化 */
  enqueuedAt: number;
  /** `say` = 要合成的文本；`clip` = 已经有的音频文件（桥的 say-loud） */
  kind: 'say' | 'clip';
  /** 正文（`clip` 时是文件路径，只用来写日志） */
  text: string;
  /** 字数（`clip` 时按 0 算，上限靠音频时长） */
  chars: number;
}

export const SPEAK_RANK: Record<SpeakPriority, number> = {
  low: 1,
  normal: 2,
  high: 3,
  urgent: 4,
};

/** 排队上限：超了丢「等级最低、且最老」的那条 */
export const SPEAK_QUEUE_MAX = 3;

/**
 * 排队老化：从**入队**那一刻算（不是从开始念算、更不重置），超过就作废。
 * 哥哥 11-15 23:16：默认 15 秒；作废的那句内容要并进下一句，不许白丢。
 */
export const SPEAK_EXPIRE_MS = 15_000;

/** 合成阶段的独立上限：合成不许占着嘴超过这么久（哥哥 11-15：合成单独 30 秒） */
export const SYNTH_GUARD_MS = 30_000;

/**
 * 出声阶段的保底：从**真的开始播放**算，音频时长 + 3 秒（不知道时长就按 60 秒兜）。
 * 与合成阶段的 30 秒分开计，长句才不会被「合成慢」连带掐掉。
 */
export function playGuardMs(audioMs?: number): number {
  const known = audioMs !== undefined && Number.isFinite(audioMs) && audioMs > 0;
  const raw = known ? audioMs + 3_000 : 60_000;
  return Math.min(300_000, Math.max(6_000, Math.round(raw)));
}

/** 单条上限的上下限（哥哥 11-15：保底 60 秒够） */
const GUARD_MIN_MS = 6_000;
const GUARD_MAX_MS = 60_000;

/** 估算一句话要念多久：4 秒起底，每字 250 毫秒，封顶 60 秒（中文正常语速约 4~5 字/秒） */
export function speakBudgetMs(text: string): number {
  const chars = Array.from(text).length;
  const raw = 4_000 + chars * 250;
  return Math.min(GUARD_MAX_MS, Math.max(15_000, raw));
}

/**
 * 这条 job 最多占嘴多久：
 *   知道音频真实时长 → 时长 + 5 秒（宁可多给，别把正常长句掐了）；
 *   不知道 → 按字数估。
 * 两头都夹在 [6 秒, 60 秒]。
 */
export function jobGuardMs(job: Pick<SpeakJob, 'text' | 'kind'>, audioMs?: number): number {
  const known = audioMs !== undefined && Number.isFinite(audioMs) && audioMs > 0;
  const raw = known ? audioMs + 5_000 : speakBudgetMs(job.text);
  return Math.min(GUARD_MAX_MS, Math.max(GUARD_MIN_MS, Math.round(raw)));
}

export interface AdmitOutcome {
  accepted: boolean;
  /** 排完之后的新队列（调用方直接替换） */
  queue: SpeakJob[];
  /** 这次被丢掉/被顶掉的（用来写日志，不影响行为） */
  dropped: SpeakJob[];
  reason?: 'duplicate' | 'busy-low' | 'queue-full-low';
}

/**
 * 能不能收下这条 job。
 *
 * - 同一个 key 已经在排着：不收（`duplicate`）；
 * - 正在说的时候来的 `low`：不收（`busy-low`）；
 * - `urgent`：收下，并且把排着的全清掉（手动动作大于一切）；
 * - 其余：进来的高等级会顺手清掉排着的 `low`；超过上限丢「等级最低、同级最老」；
 *   如果丢掉的正好是它自己，返回 `queue-full-low`。
 */
export function admitSpeak(
  active: SpeakJob | null,
  pending: readonly SpeakJob[],
  next: SpeakJob,
): AdmitOutcome {
  if (pending.some((item) => item.key === next.key)) {
    return { accepted: false, queue: [...pending], dropped: [], reason: 'duplicate' };
  }

  if (next.priority === 'urgent') {
    const dropped = [...pending];
    return { accepted: true, queue: [next], dropped };
  }

  if (active !== null && next.priority === 'low') {
    return { accepted: false, queue: [...pending], dropped: [], reason: 'busy-low' };
  }

  let queue = [...pending];
  const dropped: SpeakJob[] = [];

  // 高等级来了：排着的碎碎念一律清掉（它们已经没意义了）
  if (next.priority !== 'low') {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].priority === 'low') {
        dropped.push(queue[i]);
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
      if (rankGap < 0) victim = i;
      else if (rankGap === 0 && queue[i].enqueuedAt < queue[victim].enqueuedAt) victim = i;
    }
    const [gone] = queue.splice(victim, 1);
    if (gone.key === next.key) {
      return { accepted: false, queue: [...pending], dropped, reason: 'queue-full-low' };
    }
    dropped.push(gone);
  }

  return { accepted: true, queue, dropped };
}

/** 排队老化：超过 `SPEAK_EXPIRE_MS` 的作废，剩下的保持原顺序 */
export function expirePending(
  pending: readonly SpeakJob[],
  now: number,
  expireMs: number = SPEAK_EXPIRE_MS,
): { keep: SpeakJob[]; expired: SpeakJob[] } {
  const keep: SpeakJob[] = [];
  const expired: SpeakJob[] = [];
  for (const job of pending) {
    if (now - job.enqueuedAt > expireMs) expired.push(job);
    else keep.push(job);
  }
  return { keep, expired };
}

/** 下一条该谁说：等级最高的先来，同级按进来的顺序 */
export function pickNext(pending: readonly SpeakJob[]): {
  next?: SpeakJob;
  rest: SpeakJob[];
} {
  if (pending.length === 0) return { rest: [] };
  let best = 0;
  for (let i = 1; i < pending.length; i += 1) {
    const rankGap = SPEAK_RANK[pending[i].priority] - SPEAK_RANK[pending[best].priority];
    if (rankGap > 0) best = i;
    else if (rankGap === 0 && pending[i].enqueuedAt < pending[best].enqueuedAt) best = i;
  }
  const rest = pending.filter((_, index) => index !== best);
  return { next: pending[best], rest };
}
