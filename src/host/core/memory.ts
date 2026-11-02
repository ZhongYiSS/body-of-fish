/**
 * 桌宠 2.0 · 短期记忆契约
 *
 * 哥哥 10-30 定：**桌宠不要长期记忆**。
 *   - 只留「当天回声」：今天真正调过模型的对话（对话 / 陪伴两条线）。
 *   - 日记只写当天、只读当天；历史日记躺着不读。
 *   - 接了 DSH 会话之后，上下文由会话提供，记忆就不重要了。
 *
 * 铁律：只有类型，无实现；不许 import src/shared。
 */

/** 一条当天回声。source 记来源，方便回想"这句话是聊天说的还是陪伴说的"。 */
export interface MemoryTurn {
  role: 'user' | 'pet';
  text: string;
  /** 毫秒时间戳 */
  at: number;
  source: 'chat' | 'companion';
}

/** 会话接入点：非空表示现在跟着某个 DSH 会话走，短期记忆退化为展示。 */
export interface SessionSource {
  /** 会话 id 或标题，给设置页显示用 */
  id: string;
  title?: string;
  /** 接入时刻 */
  attachedAt: number;
}

export interface MemoryApi {
  /** 记一条当天回声；只该在真调过模型后调用（规则提炼的不算） */
  remember(turn: Omit<MemoryTurn, 'at'> & { at?: number }): Promise<void>;
  /** 当天回声，按时间正序，取最后 limit 条（默认 40） */
  today(limit?: number): Promise<MemoryTurn[]>;
  /** 当天日记：追加一句提炼过的话（零 token，超 300 字就截） */
  digest(text: string): Promise<void>;
  /** 只读当天那一篇 */
  todayDiary(): Promise<string | null>;
  /** 当前会话来源；null = 没接会话 */
  sessionSource(): SessionSource | null;
  setSessionSource(source: SessionSource | null): void;
  /** 跨零点清理旧回声时用：删掉比 keepDays 更早的当天文件 */
  sweep(keepDays?: number): Promise<number>;
}

/** 日记上限，与旧 diary.js 的 maxCharsPerDay 保持一致，别让哥哥再学一个新数 */
export const DIARY_MAX_CHARS = 300;

/** 回声上限：一天一条对话两句，200 条足够撑满一整天 */
export const TURNS_MAX = 200;

/** 把时间戳压成 YYYY-MM-DD（本地时区，跨零点切天） */
export function dayKey(at: number): string {
  const d = new Date(at);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
