/**
 * 长期卡片（第 4 批）：她说「记住：…」或者他在设置页手填的几条，跨卷常驻。
 *
 * 规则（都是纯函数，落盘由 store 负责）：
 *   - 上限 400 张，满了把最久没用、权重最低的挪进归档文件；
 *   - 每轮注入最多 5 张：先按「和这句话重合」，再按权重、再按最近用过；
 *   - 权重不自动判分：被注入时只更新 lastUsedAt，连续两轮命中 +1（封顶 5），30 天没用 -1（下限 1）。
 */
export interface Card {
  id: string;
  text: string;
  tags: string[];
  by: 'pet' | 'user';
  at: number;
  weight: number;
  lastUsedAt?: number;
}

export const CARD_MAX = 400;
export const CARD_INJECT = 5;
export const CARD_TEXT_MAX = 60;
export const CARD_WEIGHT_MAX = 5;
export const CARD_WEIGHT_MIN = 1;
export const CARD_DECAY_MS = 30 * 24 * 60 * 60 * 1_000;

/** 「记住：xxx」只有这一种显式写法会被收进卡片（不做语义抽取）。 */
const REMEMBER_PREFIX = /^(?:记住|记一下|记得)[：:]\s*/u;

export function normalizeCardText(raw: string): string {
  return raw.trim().replace(/\s+/gu, ' ').slice(0, CARD_TEXT_MAX);
}

/** 从一句里认出「记住：…」；不是就不收（返回 undefined）。 */
export function parseRemember(text: string): string | undefined {
  const hit = REMEMBER_PREFIX.exec(text.trim());
  if (hit === null) return undefined;
  const body = normalizeCardText(text.trim().slice(hit[0].length));
  return body === '' ? undefined : body;
}

export function makeCard(input: {
  text: string;
  by: Card['by'];
  at?: number;
  tags?: string[];
  id?: string;
}): Card | undefined {
  const text = normalizeCardText(input.text);
  if (text === '') return undefined;
  const at = input.at ?? Date.now();
  return {
    id: input.id ?? `card-${at}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    tags: (input.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== '').slice(0, 6),
    by: input.by,
    at,
    weight: CARD_WEIGHT_MIN,
    lastUsedAt: undefined,
  };
}

/** 中文按两字一组、英文按单词，算重合度（0~1，除以卡片词数）。 */
export function overlapScore(text: string, card: Card): number {
  const words = [card.text, ...card.tags].join(' ');
  const tokens = new Set<string>();
  for (const word of words.split(/[\s，。、；：！？,.;:!?]+/u)) {
    if (word === '') continue;
    if (/^[\x20-\x7e]+$/u.test(word)) tokens.add(word.toLowerCase());
    else for (let i = 0; i + 1 < word.length; i += 1) tokens.add(word.slice(i, i + 2));
  }
  if (tokens.size === 0) return 0;
  let hit = 0;
  for (const token of tokens) if (text.includes(token)) hit += 1;
  return hit / tokens.size;
}

/** 挑要注入的卡片：重合优先 → 权重 → 最近用过；返回挑中的（不改原数组）。 */
export function pickCards(cards: readonly Card[], text: string, limit = CARD_INJECT): Card[] {
  return [...cards]
    .map((card) => ({ card, score: overlapScore(text, card) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.card.weight !== a.card.weight) return b.card.weight - a.card.weight;
      return (b.card.lastUsedAt ?? 0) - (a.card.lastUsedAt ?? 0);
    })
    .slice(0, Math.max(0, limit))
    .map((item) => item.card);
}

/** 注入之后：记 lastUsedAt、命中的 +1（封顶）。 */
export function touchCards(cards: readonly Card[], picked: readonly Card[], now: number): Card[] {
  const ids = new Set(picked.map((card) => card.id));
  return cards.map((card) =>
    ids.has(card.id)
      ? { ...card, lastUsedAt: now, weight: Math.min(CARD_WEIGHT_MAX, card.weight + 1) }
      : card,
  );
}

/** 30 天没用过就掉一点，掉到 1 为止。 */
export function decayCards(cards: readonly Card[], now: number): Card[] {
  return cards.map((card) => {
    const seen = card.lastUsedAt ?? card.at;
    if (now - seen < CARD_DECAY_MS) return card;
    return card.weight > CARD_WEIGHT_MIN ? { ...card, weight: card.weight - 1 } : card;
  });
}

/** 超上限时挑出要归档的（最不重要的），保持原顺序返回 [留下, 归档]。 */
export function splitOverflow(
  cards: readonly Card[],
  max = CARD_MAX,
): { keep: Card[]; archive: Card[] } {
  if (cards.length <= max) return { keep: [...cards], archive: [] };
  const ranked = [...cards].sort((a, b) => {
    if (a.weight !== b.weight) return a.weight - b.weight;
    return (a.lastUsedAt ?? a.at) - (b.lastUsedAt ?? b.at);
  });
  const dropIds = new Set(ranked.slice(0, cards.length - max).map((card) => card.id));
  const keep: Card[] = [];
  const archive: Card[] = [];
  for (const card of cards) (dropIds.has(card.id) ? archive : keep).push(card);
  return { keep, archive };
}
