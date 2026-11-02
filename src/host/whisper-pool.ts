/**
 * 碎碎念本地池（【本鱼改造 · 10-28 加的，10-30 搬成 TS】）。
 *
 * 为什么要有它：碎碎念是**周期性**的（默认几分钟一句），全走模型的话一天下来是一笔实打实的
 * token 开销，而内容多半是"困了""在啃饭团"这类自己写好的话。所以：池文件在 → 从池里随机取一句，
 * **完全不叫模型**；池文件不在 / 池为空 → 走原来的模型路径（见 index.ts 的 publishWhisper）。
 *
 * 池文件形状（人可手改，改完不用重启：按 mtime 自动重读）：
 *   [{ "text": "在的哥哥", "meme": "揉眼睛" }, { "text": "咕噜咕噜" }]
 *   - text 可省（只发图）：此时文字用一个空格占位（前端把纯空格当"只有图"处理）；
 *   - meme 是该条目表情包池里的**名称**（不是文件名）；名字不在池里就当没配，随机抽一张兜底。
 *
 * 缓存口径与旧版逐字一致：mtime 没变就复用上次的解析结果；读失败时若曾经成功读过，就继续
 * 用上一次的结果（池文件被临时保存成半截也不至于把碎碎念弄哑）；从没成功过则当空池。
 */
import { readFileSync, statSync } from 'node:fs';

import { matchMeme, pickMeme, type MemeEntry } from './memes.ts';

/** 池里的一条：text / meme 都可省，但**至少得有一个**才有意义（见 pickFromWhisperPool） */
export interface WhisperPoolItem {
  text?: string;
  meme?: string;
}

interface PoolCache {
  /** 上次成功读取时的 mtimeMs；-1 = 还没成功读过 */
  mtime: number;
  items: WhisperPoolItem[];
}

/** 新建一份缓存（一个插件实例一份；测试之间互不干扰） */
export function createWhisperPoolCache(): PoolCache {
  return { mtime: -1, items: [] };
}

/**
 * 读池文件（带 mtime 缓存）。
 *
 * 收 `cache` 而不是模块级变量：模块级状态会让"两个实例读两个不同文件"变成隐式串味，
 * 也让测试必须共享一份脏缓存。
 */
export function readWhisperPool(
  file: string,
  cache: PoolCache = createWhisperPoolCache(),
): WhisperPoolItem[] {
  try {
    const stat = statSync(file);
    if (stat.mtimeMs === cache.mtime) return cache.items;
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    // 只留对象项：池文件是手改的，混进字符串/数字项时**跳过而不是整份作废**
    const items = Array.isArray(raw)
      ? raw.filter((x): x is WhisperPoolItem => typeof x === 'object' && x !== null)
      : [];
    cache.mtime = stat.mtimeMs;
    cache.items = items;
    return items;
  } catch {
    // 没这文件 / 解析失败：曾经成功过就继续用旧内容，否则空池
    return cache.mtime === -1 ? [] : cache.items;
  }
}

/**
 * 从池里取一条可直接写进 `pets.<id>.say` 的气泡数据。
 *
 * 配图规则（与旧版一致）：
 *   - 池里写了 meme 且该名字在表情包池里 → 用它；
 *   - 否则**随机抽一张**（池里没图就只发字）；
 *   - 文字与配图都没有 → 返回 undefined（调用方据此回 `empty-pool`，不要写空气泡）。
 */
export function pickFromWhisperPool(
  pool: readonly WhisperPoolItem[],
  memes: readonly MemeEntry[],
  random: () => number = Math.random,
): { text: string; image?: string } | undefined {
  if (pool.length === 0) return undefined;
  const item = pool[Math.floor(random() * pool.length) % pool.length];
  const body = typeof item.text === 'string' ? item.text.trim() : '';
  const hit = typeof item.meme === 'string' && item.meme ? matchMeme(memes, item.meme) : undefined;
  const image = hit ? hit.name : pickMeme(memes, random)?.name;
  // 纯空格是**有意的**：前端把"只有空白"当"只有图、没有字"，不会渲染一个空气泡
  if (!body && !image) return undefined;
  return { text: body || ' ', ...(image ? { image } : {}) };
}
