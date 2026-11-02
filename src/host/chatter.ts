/**
 * 旁听吐槽（chatter）：**改编自 dsh-pet-chatter**（原 dsh-pet-extras 附属包 lib/modules/chatter.js，
 * 本鱼 2026-10 写的那一版）。
 *
 * 改写目的（哥哥 m00722 的「接入会话」+ 合体）：
 *  1. 旧版靠 `POST /dsh-pet-7340/broadcast` 回环冒泡 —— 现在直接调 core.say（进程内），少一跳；
 *  2. 旧版把"监听会话"焊死在 Cordis 插件里（要 agents 服务），这一层只留**纯调度**：
 *     谁来喂 userText/replyText 由外面决定（DSH 会话事件、或接入会话后的整段对话）；
 *     这样独立模式下没有 agents 服务也能用同一套规则。
 *  3. 规则档照旧是**零 token**：命中关键词就说预设台词，没命中按概率给个通用泡泡。
 *
 * 两档比例（哥哥定的 50/50）：调模型 50%（聪明但花钱），规则 50%（免费）。模型那档
 * **生成失败就回落规则**——不能让"模型没配好"变成"宠物哑了"。
 */
import { FALLBACK, RULES } from './chatter-rules';

export interface ChatterConfig {
  enabled?: boolean;
  /** 调模型的比例（0~1），默认 0.5 */
  modelRatio?: number;
  /** 两次吐槽的最小间隔（秒），默认 20，防刷屏 */
  cooldownSec?: number;
  /** 吐槽字数上限，默认 20 */
  maxChars?: number;
}

export interface ChatterDeps {
  /** 唯一出口：冒一句气泡（由 core.say 包进来） */
  say(text: string): Promise<boolean | void> | boolean | void;
  /** 调模型生成一句；缺省 = 只走规则档（零成本） */
  generate?(input: { userText: string; replyText: string; maxChars: number }): Promise<string | null>;
  now?(): number;
  random?(): number;
  log?(message: string): void;
  /** 配置：也可以给一个函数（每次现读，设置页改完不用重启） */
  config?: ChatterConfig | (() => ChatterConfig);
}

export type ChatterOutcome = 'rule' | 'model' | 'skip';

const pick = <T,>(list: readonly T[], random: () => number): T => list[Math.floor(random() * list.length)] as T;

/**
 * 规则档：命中关键词 → 说；没命中 → 60% 概率给个通用泡泡。
 *
 * 为什么"没命中还给"：旧版 25% 时太安静（实测像没接上），60% 才有"在旁边"的感觉；
 * 剩下 40% 留白——宠物不该每一轮都抢话。
 */
export function ruleText(
  userText: string,
  replyText: string,
  random: () => number = Math.random,
): string | null {
  const all = `${String(userText ?? '')} ${String(replyText ?? '')}`;
  for (const rule of RULES) {
    if (rule.kw.some((keyword) => all.includes(keyword))) return pick(rule.lines, random);
  }
  return random() < 0.6 ? pick(FALLBACK, random) : null;
}

/**
 * 洗一句要冒出去的话：只保留第一行、去掉首尾引号、按码点截断。
 *
 * 为什么截断是 `maxChars * 2`：冒泡有自己的排版宽度，模型偶尔多说半句不至于顶爆气泡；
 * 按 `Array.from` 切是为了不把 emoji 切成半个（旧版是 `slice`，emoji 多的台词会乱码）。
 */
export function cleanText(text: string, maxChars: number): string {
  const first = String(text ?? '')
    .trim()
    .split('\n')[0]
    ?.trim();
  if (!first) return '';
  const unquoted = first.replace(/^["「『“]/, '').replace(/["」』”]$/, '').trim();
  if (!unquoted) return '';
  return Array.from(unquoted).slice(0, Math.max(1, maxChars * 2)).join('');
}

export function createChatter(deps: ChatterDeps): {
  /** 一轮结束时调用：返回这一轮走的是哪一档 */
  onTurn(userText: string, replyText: string): Promise<ChatterOutcome>;
  /** 上一次真说话的时间（排障用） */
  lastAt(): number;
} {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const log = deps.log ?? (() => {});
  // 每轮现读配置：设置页把旁听关掉后，下一次 onTurn 立刻生效（不用重启 DSH）
  const readConfig = (): ChatterConfig =>
    typeof deps.config === 'function' ? deps.config() : (deps.config ?? {});

  let last = 0;

  const speak = async (text: string, maxChars: number): Promise<boolean> => {
    const clean = cleanText(text, maxChars);
    if (!clean) return false;
    try {
      await deps.say(clean);
      return true;
    } catch (error) {
      log(`冒泡失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  return {
    async onTurn(userText: string, replyText: string): Promise<ChatterOutcome> {
      const config = readConfig();
      if (config.enabled === false) return 'skip';
      const modelRatio = typeof config.modelRatio === 'number' ? config.modelRatio : 0.5;
      const maxChars = typeof config.maxChars === 'number' ? config.maxChars : 20;
      const cooldownMs = (typeof config.cooldownSec === 'number' ? config.cooldownSec : 20) * 1000;
      const at = now();
      if (at - last < cooldownMs) return 'skip';

      let outcome: ChatterOutcome = 'rule';
      let text: string | null = null;
      if (deps.generate && random() < modelRatio) {
        outcome = 'model';
        try {
          text = await deps.generate({ userText, replyText, maxChars });
        } catch (error) {
          log(`模型档异常，回落规则：${error instanceof Error ? error.message : String(error)}`);
          text = null;
        }
        if (!text) {
          // 模型没结果（没配 key / 超时 / 空话）→ 回落规则，不让宠物哑掉
          outcome = 'rule';
          text = ruleText(userText, replyText, random);
        }
      } else {
        text = ruleText(userText, replyText, random);
      }
      if (!text) return 'skip';
      const said = await speak(text, maxChars);
      if (!said) return 'skip';
      last = at;
      return outcome;
    },

    lastAt(): number {
      return last;
    },
  };
}
