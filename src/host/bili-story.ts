/**
 * 视频的「剧情梗概」：把整条时间轴字幕压成三百字以内的背景资料。
 *
 * 哥哥 11-11 m20008 定的口径：视频模式只看单张图（宫格太慢、割裂感强），
 * 字幕不当台词用，只让她「知道个大概」；提示词里禁止讲还没看到的内容。
 *
 * 落盘分两类（哥哥要求「记得分好类」）：
 *   `数据\陪伴\字幕\<BV>_p<分P>.json`  整条时间轴原文（排查用，也能直接看）
 *   `数据\陪伴\剧情\<BV>_p<分P>.json`  压好的梗概（缓存，重看不重烧）
 */
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseBiliVideo, type SubtitleLine } from './bili-subtitle';

export interface StoryEntry {
  bvid: string;
  page: number;
  title: string;
  summary: string;
  at: number;
  chars: number;
}

/** 字幕原文落盘的样子 */
export interface SubtitleFile {
  bvid: string;
  page: number;
  at: number;
  lines: SubtitleLine[];
}

export function storyFileName(bvid: string, page: number): string {
  return `${bvid}_p${page}.json`;
}

/**
 * 目标字数：短视频给一百来字就够（三百字对三分钟的视频是注水），长视频才放到三百。
 * 哥哥 11-11：「三百字够了，甚至对于短视频来说有点长了」。
 */
export function planSummaryChars(totalChars: number): number {
  if (totalChars < 1200) return 120;
  if (totalChars < 5000) return 200;
  return 300;
}

/** 把字幕行拼成一段段纯文本，每段不超过 maxChars（按行切，不切在半句上） */
export function chunkLines(lines: readonly SubtitleLine[], maxChars = 2400): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const text = line.text.trim();
    if (text === '') continue;
    if (current !== '' && current.length + text.length + 1 > maxChars) {
      chunks.push(current);
      current = text;
      continue;
    }
    current = current === '' ? text : current + '\n' + text;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

export function subtitleChars(lines: readonly SubtitleLine[]): number {
  let total = 0;
  for (const line of lines) total += line.text.length;
  return total;
}

/** 分段摘要时每段要的东西：这一小段在讲什么 */
export function chunkPrompt(index: number, count: number, text: string): string {
  return [
    `下面是一个视频的字幕，第 ${index}/${count} 段（按时间顺序）。`,
    '用两句、总共不超过 80 字，说清这一段在讲什么：谁、在做什么、发生了什么。',
    '只写剧情本身，不评价、不摘原话、不写「本段」这种词。',
    '',
    text,
  ].join('\n');
}

/** 合并成最终梗概 */
export function mergePrompt(outline: string, chars: number): string {
  return [
    '下面同一个视频按时间顺序的分段剧情。',
    `把它压成一段不分行的剧情梗概，不超过 ${chars} 字：`,
    '先说这是什么内容、主线是什么，再点出已经发生过的两三件关键事（有转折就说转折）。',
    '别写评价、别写推荐语、别用「视频讲述了一个」这种腔调，就像跟人随口讲一句「这视频在演什么」。',
    '',
    outline,
  ].join('\n');
}

export interface StoryAsk {
  /** 把 prompt 丢给模型，返回它的文本；失败返回空串，不要抛 */
  (prompt: string, system: string): Promise<string>;
}

export interface StoryCacheOptions {
  /** `数据\陪伴\字幕` */
  readonly subtitleDir: string;
  /** `数据\陪伴\剧情` */
  readonly storyDir: string;
  /** 抓整条时间轴字幕（拿不到就 ok:false） */
  readonly fetchLines: (url: string) => Promise<{ ok: boolean; lines: SubtitleLine[]; reason?: string }>;
  readonly ask: StoryAsk;
  /** 落盘文件留几天（哥哥：定时删除）；默认 30 天 */
  readonly keepDays?: number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface StoryResult {
  summary: string;
  cached: boolean;
}

export interface StoryCache {
  /** 有缓存就立刻给；没有就返回 null，并在后台开始生成（不挡着出图） */
  get: (url: string, title: string) => Promise<StoryResult | null>;
  /** 删掉过期的字幕与梗概，返回删了几个 */
  cleanup: () => Promise<number>;
}

/** 摘要用的系统口径：稳、短、不发挥 */
export const STORY_SYSTEM = [
  '你在帮一个陪看视频的桌面宠物做「预习」：把字幕压成剧情梗概，供她在旁边随口搭话时参考。',
  '要求：只写剧情事实，不加评价、不加感情、不写「视频」「字幕」「本段」这类词；句子短，像讲给旁边的人听。',
  '不确定的地方就略过，绝不编造字幕里没有的人名和情节。只输出梗概本身。',
].join('');

export function createStoryCache(options: StoryCacheOptions): StoryCache {
  const now = options.now ?? Date.now;
  const keepMs = (options.keepDays ?? 30) * 24 * 60 * 60 * 1000;
  const log = options.log ?? (() => {});
  const pending = new Map<string, Promise<void>>();

  async function ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  async function readJson<T>(file: string): Promise<T | null> {
    try {
      const raw = await readFile(file, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async function readStory(target: { bvid: string; page: number }): Promise<StoryEntry | null> {
    const entry = await readJson<StoryEntry>(join(options.storyDir, storyFileName(target.bvid, target.page)));
    if (entry === null || typeof entry.summary !== 'string' || entry.summary.trim() === '') return null;
    if (now() - entry.at > keepMs) return null;
    return entry;
  }

  async function readSubtitle(target: { bvid: string; page: number }): Promise<SubtitleLine[] | null> {
    const file = await readJson<SubtitleFile>(join(options.subtitleDir, storyFileName(target.bvid, target.page)));
    if (file === null || !Array.isArray(file.lines) || file.lines.length === 0) return null;
    if (now() - file.at > keepMs) return null;
    return file.lines;
  }

  async function generate(url: string, title: string): Promise<void> {
    const target = parseBiliVideo(url);
    if (target === null) return;
    let lines = await readSubtitle(target);
    if (lines === null) {
      const fetched = await options.fetchLines(url);
      if (!fetched.ok || fetched.lines.length === 0) {
        log(`剧情梗概跳过：字幕没拿到（${fetched.reason ?? 'unknown'}）`);
        return;
      }
      lines = fetched.lines;
      await ensureDir(options.subtitleDir);
      const payload: SubtitleFile = { bvid: target.bvid, page: target.page, at: now(), lines };
      await writeFile(join(options.subtitleDir, storyFileName(target.bvid, target.page)), JSON.stringify(payload), 'utf8');
    }

    const chars = planSummaryChars(subtitleChars(lines));
    const chunks = chunkLines(lines);
    let outline = '';
    if (chunks.length === 1) {
      outline = chunks[0]!;
    } else {
      const parts: string[] = [];
      for (let i = 0; i < chunks.length; i += 1) {
        const part = await options.ask(chunkPrompt(i + 1, chunks.length, chunks[i]!), STORY_SYSTEM);
        if (part.trim() !== '') parts.push(part.trim());
      }
      outline = parts.join('\n');
    }
    if (outline.trim() === '') {
      log('剧情梗概跳过：模型没吐出东西');
      return;
    }

    const summary = await options.ask(mergePrompt(outline, chars), STORY_SYSTEM);
    const text = summary.trim().slice(0, chars);
    if (text === '') {
      log('剧情梗概跳过：合并没有结果');
      return;
    }
    await ensureDir(options.storyDir);
    const entry: StoryEntry = { bvid: target.bvid, page: target.page, title, summary: text, at: now(), chars: text.length };
    await writeFile(join(options.storyDir, storyFileName(target.bvid, target.page)), JSON.stringify(entry), 'utf8');
    log(`剧情梗概好了：${target.bvid} p${target.page}，${text.length} 字`);
  }

  return {
    async get(url: string, title: string): Promise<StoryResult | null> {
      const target = parseBiliVideo(url);
      if (target === null) return null;
      const key = `${target.bvid}#${target.page}`;
      const hit = await readStory(target);
      if (hit !== null) return { summary: hit.summary, cached: true };
      if (!pending.has(key)) {
        const task = generate(url, title)
          .catch((error: unknown) => {
            log(`剧情梗概失败：${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => {
            pending.delete(key);
          });
        pending.set(key, task);
      }
      return null;
    },

    async cleanup(): Promise<number> {
      let removed = 0;
      for (const dir of [options.subtitleDir, options.storyDir]) {
        let names: string[] = [];
        try {
          names = await readdir(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          const file = join(dir, name);
          try {
            const info = await stat(file);
            if (now() - info.mtimeMs > keepMs) {
              await unlink(file);
              removed += 1;
            }
          } catch {
            // 删不掉就算了，下次再说
          }
        }
      }
      return removed;
    },
  };
}
