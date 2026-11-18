/**
 * 「说一句」（点菜单 / `POST /say`）的提示词与兜底台词（待办第 4 条）。
 *
 * 以前是八句写死的台词随机抽，半夜也会冒出「哥哥，本鱼在呢」。
 * 现在改成：读一眼卷（摘要 + 最近几句 + 他最后一句）+ 看当前时辰，让模型随口一句；
 * 模型没配好 / 超时 / 说了空话，才回落到按时辰挑的兜底台词。
 *
 * 纯函数，不碰 IO —— 句子怎么来由宿主决定，这里只管「问什么」和「说不出话时说什么」。
 */

/** 最近她说过的话（用来去重），最多记 3 句 */
export const RECENT_KEEP = 3;

export type DayPart = 'lateNight' | 'morning' | 'noon' | 'afternoon' | 'evening';

export function dayPartOf(nowMs: number): DayPart {
  const hour = new Date(nowMs).getHours();
  if (hour < 5) return 'lateNight';
  if (hour < 11) return 'morning';
  if (hour < 13) return 'noon';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

export function dayPartWord(part: DayPart): string {
  switch (part) {
    case 'lateNight':
      return '深夜（该睡了）';
    case 'morning':
      return '上午';
    case 'noon':
      return '中午';
    case 'afternoon':
      return '下午';
    case 'evening':
      return '晚上';
  }
}

/** 按时辰分组的兜底台词：都是「随口一句」，不是问句，也不催他做事 */
const FALLBACK: Record<DayPart, readonly string[]> = {
  lateNight: ['还没睡呀。', '本鱼陪着，别熬太晚。', '灯还亮着呢。', '这个点，泡泡都困了。'],
  morning: ['早呀。', '本鱼醒着呢。', '今天慢慢来。', '早上好，咕噜。'],
  noon: ['吃了吗？', '本鱼在的。', '中午啦，歇会儿吧。', '泡泡晒暖了。'],
  afternoon: ['本鱼在这儿。', '下午好呀。', '忙你的，本鱼不吵。', '要不要歇一会儿？'],
  evening: ['晚上好呀。', '本鱼在呢。', '忙完了吗？', '今天辛苦啦。'],
};

/** 挑一句兜底：先避开最近说过的，全撞了就随便挑一句 */
export function pickFallback(nowMs: number, recent: readonly string[], roll = Math.random): string {
  const pool = FALLBACK[dayPartOf(nowMs)].filter((line) => !recent.includes(line));
  const usable = pool.length > 0 ? pool : FALLBACK[dayPartOf(nowMs)];
  return usable[Math.floor(roll() * usable.length)] ?? usable[0] ?? '本鱼在呢。';
}

export interface SayOnceInput {
  nowMs: number;
  /** 上一卷的摘要（可能为空） */
  summary: string;
  /** 最近她说过 / 他说过的几句（老的在前） */
  recent: readonly { kind: string; text: string }[];
  /** 最近三句她说过的（去重用） */
  recentSaid: readonly string[];
}

/** 拼一句「说一句」的指令。只输出一句话，别带引号、别解释。 */
export function sayOncePrompt(input: SayOnceInput): string {
  const part = dayPartWord(dayPartOf(input.nowMs));
  const lines = [
    `现在点了一下「说一句」，你随口冒一句就好。现在是${part}。`,
    '',
    '要求：',
    '- 20 字以内，口语，像在桌边随口说的。',
    '- 不要问句堆着，不要一上来就提要求；不是回复谁。',
    '- 别用不合时辰的话（深夜别说早上好）。',
    '- 别重复最近说过的这几句，也别解释你在干什么。',
    '- 只输出这一句，不要引号、不要括号里的动作描写。',
  ];
  if (input.summary !== '') lines.push('', '【上回说到】' + input.summary);
  const said = input.recentSaid.slice(-RECENT_KEEP);
  if (said.length > 0) lines.push('', '【刚说过的（别重复）】' + said.join(' / '));
  const tail = input.recent
    .filter((turn) => turn.kind !== 'thought')
    .slice(-4)
    .map((turn) => `${turn.kind === 'said' ? '你' : '他'}：${turn.text}`);
  if (tail.length > 0) lines.push('', '【刚才那几句】' + tail.join(' / '));
  return lines.join('\n');
}

/** 模型回的话清一下：去掉引号 / 首尾空白 / 换行折成空格，只留第一句 */
export function tidySayOnce(raw: string): string {
  const first = raw.trim().split(/\n+/u)[0] ?? '';
  const unquoted = first.replace(/^[「『‘"'“]+|[」』’"'”]+$/gu, '').trim();
  const sentence = unquoted.split(/(?<=[。！？!?~～])/u)[0] ?? unquoted;
  return sentence.trim().slice(0, 40);
}