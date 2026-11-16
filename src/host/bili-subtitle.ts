/**
 * bili-subtitle.ts — 给「陪伴 · 视频」抓 B站字幕，只取当前播放位置前后两分钟。
 *
 * 为什么这么绕：B站字幕**必须登录**才给列表（未登录 `data.subtitle.subtitles` 恒为空），
 * 所以需要哥哥在设置里填一次 SESSDATA。填了之后整条链路是：
 *   网址 → BV 号 → cid（pagelist）→ player/v2 拿字幕轨 → 下载字幕 JSON → 按进度切片。
 *
 * 位置靠「观看历史」里的 progress 估（心跳大约每 15~30 秒上报一次），不精确但够用：
 * 我们只要「前后两分钟」这一小段给模型。
 *
 * 【汐儿 · 11-11 m19834】哥哥拍板：登录信息走设置页填 SESSDATA，抓字幕只给当前前后两分钟。
 */

export const BILI_TIMEOUT_MS = 6000;
export const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BILI_REFERER = 'https://www.bilibili.com/';
const WINDOW_SEC = 120;
const MAX_TEXT = 1500;
const CACHE_MS = 120_000;
/** 整条时间轴缓存更久一点：梗概只生成一次，字幕内容一会儿不会变 */
const ALL_CACHE_MS = 600_000;

export interface BiliTarget {
  bvid: string;
  page: number;
}

export interface SubtitleLine {
  from: number;
  to: number;
  text: string;
}

export interface SubtitleSlice {
  ok: boolean;
  lines: SubtitleLine[];
  fromSec: number;
  toSec: number;
  text: string;
  reason?: 'not-bili' | 'no-cookie' | 'no-cid' | 'no-track' | 'failed';
}

/** 从网址里取 BV 号和分P（只认 bilibili.com/video/BVxxx 这种正片地址）。 */
export function parseBiliVideo(url: string): BiliTarget | null {
  if (typeof url !== 'string' || url === '') return null;
  const m = /bilibili\.com\/video\/(BV[0-9A-Za-z]{6,14})/u.exec(url);
  if (m === null) return null;
  const pageMatch = /[?&]p=(\d{1,3})/u.exec(url);
  const page = pageMatch === null ? 1 : Math.max(1, Number(pageMatch[1]));
  return { bvid: m[1], page: Number.isFinite(page) ? page : 1 };
}

/** 网址里带的起始秒（`?t=123` / `&t=123`），拖动进度条后分享出来的地址常常带。 */
export function parseStartSecond(url: string): number | null {
  const m = /[?&]t=(\d{1,6})/u.exec(url ?? '');
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function textOf(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/gu, ' ').trim();
}

/** 字幕轨 JSON → 行（B站给的是 {"body":[{"from":1.2,"to":3.4,"content":"…"}]}）。 */
export function parseSubtitleBody(raw: string): SubtitleLine[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const body = (data as { body?: unknown })?.body;
  if (!Array.isArray(body)) return [];
  const out: SubtitleLine[] = [];
  for (const item of body) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const from = Number(row.from);
    const to = Number(row.to);
    const text = textOf(row.content);
    if (!Number.isFinite(from) || text === '') continue;
    out.push({ from, to: Number.isFinite(to) && to > from ? to : from + 2, text });
  }
  return out;
}

/** 取 [at-120, at+120] 这一窗的行，拼成一段话；超长从中间往两边丢。 */
export function sliceAround(lines: SubtitleLine[], atSec: number): { lines: SubtitleLine[]; text: string; fromSec: number; toSec: number } {
  const at = Number.isFinite(atSec) && atSec > 0 ? atSec : 0;
  const fromSec = Math.max(0, at - WINDOW_SEC);
  const toSec = at + WINDOW_SEC;
  const picked = lines.filter((line) => line.to >= fromSec && line.from <= toSec);
  let text = picked.map((line) => line.text).join(' ');
  if (text.length > MAX_TEXT) {
    // 超长就砍两头、留身边 —— 她说的是「现在这一段」，开头结尾都不重要
    const keep = Math.floor(MAX_TEXT / 2);
    text = '…' + text.slice(Math.max(0, text.length - keep * 2), text.length - keep).trim() + '…';
  }
  return { lines: picked, text, fromSec, toSec };
}

/** 字幕列表里挑中文那份：优先 UP 主上传的 zh，其次 AI 生成的 ai-zh。 */
export function pickSubtitleTrack(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  const rank = (item: Record<string, unknown>): number => {
    const lan = String(item.lan ?? '');
    if (/^zh/u.test(lan) && !/^ai/u.test(lan)) return 0;
    if (lan === 'ai-zh' || /^ai-zh/u.test(lan)) return 1;
    if (/^zh/u.test(lan)) return 2;
    return 9;
  };
  const rows = list
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({ item, score: rank(item), url: typeof item.subtitle_url === 'string' ? item.subtitle_url : '' }))
    .filter((row) => row.url !== '')
    .sort((a, b) => a.score - b.score);
  return rows.length > 0 ? rows[0].url : null;
}

/** 把用户填的那一格收拾成能用的 cookie：只填值就补上 SESSDATA=，填了整串就原样用 */
export function normalizeCookie(raw: string): string {
  const text = raw
    .trim()
    .replace(/^cookie\s*:\s*/iu, '')
    .replace(/^["']|["']$/gu, '');
  if (text === '') return '';
  if (text.includes('=')) return text;
  return `SESSDATA=${text}`;
}

function withScheme(url: string): string {
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('http')) return url;
  return 'https://' + url;
}

async function getJson(url: string, cookie: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: {
        'user-agent': BILI_UA,
        referer: BILI_REFERER,
        accept: 'application/json, text/plain, */*',
        ...(cookie === '' ? {} : { cookie }),
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface SubtitleBookOptions {
  cookie: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** 整条时间轴的字幕（剧情梗概用）；拿不到时 reason 说明卡在哪一步 */
export interface SubtitleAll {
  ok: boolean;
  lines: SubtitleLine[];
  reason?: 'not-bili' | 'no-cookie' | 'no-cid' | 'no-track' | 'failed';
}

export interface SubtitleBook {
  sliceFor: (url: string) => Promise<SubtitleSlice>;
  allFor: (url: string) => Promise<SubtitleAll>;
}

/**
 * 一个 BV 号只抓一次字幕、只查一次进度，两分钟内复用 —— 陪伴每十几秒出一张图，
 * 不能每次出图都去打三个接口。
 */
export function createSubtitleBook(options: SubtitleBookOptions): SubtitleBook {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? BILI_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; lines: SubtitleLine[]; progress: number }>();
  const allCache = new Map<string, { at: number; lines: SubtitleLine[] }>();

  async function load(target: BiliTarget, cookie: string): Promise<{ lines: SubtitleLine[]; progress: number }> {
    const key = target.bvid + '#' + String(target.page);
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at < CACHE_MS) return hit;

    const pageList = await getJson(
      'https://api.bilibili.com/x/player/pagelist?bvid=' + encodeURIComponent(target.bvid),
      cookie,
      timeoutMs,
      fetchImpl,
    );
    const pages = (pageList as { data?: unknown })?.data;
    let cid = 0;
    if (Array.isArray(pages) && pages.length > 0) {
      const index = Math.min(Math.max(1, target.page), pages.length) - 1;
      const row = pages[index] as Record<string, unknown> | undefined;
      cid = Number(row?.cid ?? 0);
    }
    const empty = { lines: [] as SubtitleLine[], progress: 0 };
    if (!Number.isFinite(cid) || cid <= 0) {
      cache.set(key, { at: now(), ...empty });
      return empty;
    }

    const [player, history] = await Promise.all([
      getJson(
        'https://api.bilibili.com/x/player/v2?bvid=' + encodeURIComponent(target.bvid) + '&cid=' + String(cid),
        cookie,
        timeoutMs,
        fetchImpl,
      ),
      getJson('https://api.bilibili.com/x/web-interface/history/cursor?ps=20', cookie, timeoutMs, fetchImpl),
    ]);

    const trackUrl = pickSubtitleTrack(((player as { data?: { subtitle?: { subtitles?: unknown } } })?.data?.subtitle?.subtitles));
    let lines: SubtitleLine[] = [];
    if (trackUrl !== null) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(withScheme(trackUrl), {
          headers: { 'user-agent': BILI_UA, referer: BILI_REFERER, ...(cookie === '' ? {} : { cookie }) },
          signal: controller.signal,
        });
        if (res.ok) lines = parseSubtitleBody(await res.text());
      } catch {
        lines = [];
      } finally {
        clearTimeout(timer);
      }
    }

    let progress = 0;
    const list = (history as { data?: { list?: unknown } })?.data?.list;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        if (row.bvid === target.bvid) {
          const value = Number(row.progress);
          if (Number.isFinite(value) && value >= 0) progress = value;
          break;
        }
      }
    }

    const result = { lines, progress };
    cache.set(key, { at: now(), ...result });
    return result;
  }

  /** 整条时间轴：分P → 字幕轨 → 字幕 JSON，不带观看进度（梗概不需要位置） */
  async function loadAll(target: BiliTarget, cookie: string): Promise<SubtitleLine[]> {
    const key = target.bvid + '#' + String(target.page);
    const hit = allCache.get(key);
    if (hit !== undefined && now() - hit.at < ALL_CACHE_MS) return hit.lines;

    const pageList = await getJson(
      'https://api.bilibili.com/x/player/pagelist?bvid=' + encodeURIComponent(target.bvid),
      cookie,
      timeoutMs,
      fetchImpl,
    );
    const pages = (pageList as { data?: unknown })?.data;
    let cid = 0;
    if (Array.isArray(pages) && pages.length > 0) {
      const index = Math.min(Math.max(1, target.page), pages.length) - 1;
      const row = pages[index] as Record<string, unknown> | undefined;
      cid = Number(row?.cid ?? 0);
    }
    if (!Number.isFinite(cid) || cid <= 0) return [];

    const player = await getJson(
      'https://api.bilibili.com/x/player/v2?bvid=' + encodeURIComponent(target.bvid) + '&cid=' + String(cid),
      cookie,
      timeoutMs,
      fetchImpl,
    );
    const trackUrl = pickSubtitleTrack(
      (player as { data?: { subtitle?: { subtitles?: unknown } } })?.data?.subtitle?.subtitles,
    );
    let lines: SubtitleLine[] = [];
    if (trackUrl !== null) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(withScheme(trackUrl), {
          headers: { 'user-agent': BILI_UA, referer: BILI_REFERER, ...(cookie === '' ? {} : { cookie }) },
          signal: controller.signal,
        });
        if (res.ok) lines = parseSubtitleBody(await res.text());
      } catch {
        lines = [];
      } finally {
        clearTimeout(timer);
      }
    }
    allCache.set(key, { at: now(), lines });
    return lines;
  }

  return {
    async sliceFor(url: string): Promise<SubtitleSlice> {
      const target = parseBiliVideo(url);
      const empty: SubtitleSlice = { ok: false, lines: [], fromSec: 0, toSec: 0, text: '' };
      if (target === null) return { ...empty, reason: 'not-bili' };
      const cookie = normalizeCookie(options.cookie());
      if (cookie === '') return { ...empty, reason: 'no-cookie' };
      try {
        const loaded = await load(target, cookie);
        if (loaded.lines.length === 0) return { ...empty, reason: 'no-track' };
        const at = parseStartSecond(url) ?? loaded.progress;
        const sliced = sliceAround(loaded.lines, at);
        return { ok: sliced.text !== '', lines: sliced.lines, fromSec: sliced.fromSec, toSec: sliced.toSec, text: sliced.text };
      } catch {
        return { ...empty, reason: 'failed' };
      }
    },
    async allFor(url: string): Promise<SubtitleAll> {
      const target = parseBiliVideo(url);
      if (target === null) return { ok: false, lines: [], reason: 'not-bili' };
      const cookie = normalizeCookie(options.cookie());
      if (cookie === '') return { ok: false, lines: [], reason: 'no-cookie' };
      try {
        const lines = await loadAll(target, cookie);
        if (lines.length === 0) return { ok: false, lines: [], reason: 'no-track' };
        return { ok: true, lines };
      } catch {
        return { ok: false, lines: [], reason: 'failed' };
      }
    },
  };
}
