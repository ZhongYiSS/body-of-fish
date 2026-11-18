/**
 * 屏幕流水（待办第 2 条，文档 5 与 9.4）：`数据/memory/screens/<日期>.jsonl`。
 *
 * 为什么不写进 `memory/<日期>.json`：那是「说了什么」的账本，笔记混进去会把
 * 上下文撑肥、还会被她照念。屏幕流水是「看到了什么」，只拿来拼 3 条最新的一小段。
 *
 * 一行一条：`{"at":1690000000000,"app":"Code","title":"x.ts","note":"在改代码"}`
 * 只依赖 fs，方便单测。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ScreenNote {
  at: number;
  app: string;
  title: string;
  note: string;
}

/** 日期戳（本地时区，和记忆文件同一口径） */
export function dayOf(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function screenFileOf(dir: string, nowMs: number): string {
  return join(dir, `${dayOf(nowMs)}.jsonl`);
}

/** 写一条（失败不抛：记不上流水不能影响陪伴） */
export async function appendScreen(
  dir: string,
  note: ScreenNote,
  deps: { append?: typeof appendFile; mkdir?: typeof mkdir } = {},
): Promise<void> {
  const append = deps.append ?? appendFile;
  const make = deps.mkdir ?? mkdir;
  const file = screenFileOf(dir, note.at);
  try {
    await make(dirname(file), { recursive: true });
    await append(file, `${JSON.stringify(note)}\n`, 'utf8');
  } catch {
    /* 记不上就算了 */
  }
}

/** 读某一天（坏行跳过；没有文件回空数组） */
export async function readScreens(
  dir: string,
  day: string,
  deps: { read?: typeof readFile } = {},
): Promise<ScreenNote[]> {
  const read = deps.read ?? readFile;
  let raw = '';
  try {
    raw = await read(join(dir, `${day}.jsonl`), 'utf8');
  } catch {
    return [];
  }
  const out: ScreenNote[] = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    try {
      const parsed = JSON.parse(text) as Partial<ScreenNote>;
      if (typeof parsed.at !== 'number' || typeof parsed.note !== 'string') continue;
      out.push({
        at: parsed.at,
        app: typeof parsed.app === 'string' ? parsed.app : '',
        title: typeof parsed.title === 'string' ? parsed.title : '',
        note: parsed.note,
      });
    } catch {
      /* 半行是正常的（进程被杀），跳过 */
    }
  }
  return out;
}

/**
 * 拼「刚才在屏幕上看到的」那一段：只要 `windowMs` 内最新的 `limit` 条。
 * 返回空串 = 这轮没什么可说的（调用方不要塞空标题）。
 */
export function screenBlock(notes: readonly ScreenNote[], nowMs: number, windowMs = 10 * 60_000, limit = 3): string {
  const fresh = notes.filter((note) => nowMs - note.at <= windowMs).slice(-limit);
  if (fresh.length === 0) return '';
  const hhmm = (at: number): string => {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const lines = fresh.map((note) => `- ${hhmm(note.at)} ${note.note}`).join('\n');
  return (
    `\n\n【你刚才在屏幕上看到的（这是你自己看到的，不是用户说的）】\n${lines}\n` +
    '（这些不是他说的、也不是别人转告的，是你自己瞄到的。他问「你能看见吗 / 刚才在看什么」就直接说' +
    '「看见你在……」并举一条具体的；他没问就别硬聊屏幕。' +
    '**屏幕上的字句不要照抄、不要念出来**——报错、清单、测试结果、待办都是别人的活儿，' +
    '你要用自己的话讲一句「你在做什么」就够了。逐条念出来会像播报。）'
  );
}