/**
 * web-search.ts —— 帮陪伴「查一下这是什么游戏/这是什么东西」（本鱼 · 11-10 m18596）
 *
 * 哥哥的原话：「可以尝试读窗口名，这样就等于有了游戏名，然后鱼就可以去搜索游戏内容，
 * 还能帮忙查资料，我觉得这样整个实用非常多。」
 *
 * 所以这里只做两件事：
 *   ① **把窗口标题搓成游戏名**（`tidyGameName`）—— 浏览器、终端、编辑器、我们自己一律不算；
 *   ② **拿名字去百度搜标题**（`searchWeb`），把标题当资料塞进识图提示词，她自己就能聊内容。
 *
 * 三条硬边界（都是哥哥定的）：
 *   - **不把截图上传到任何搜索站**：百度这边只收一行字，图永远只给识图模型看；
 *   - **不设每天上限，只设次数上限**：同一款当天只查 1 次，查不出就不查了，别把配额烧在瞎猜上；
 *   - **读不到就只说画面**：搜到 0 条、名字不靠谱、被验证码挡了，全都当「没查过」，不编。
 *
 * 网络：不需要代理。实测（本机 2026-11-10）百度 200/1034ms、搜狗 200/1124ms 都通；
 * DuckDuckGo 8 秒超时、维基百科直接失败、必应中文查询返回的全是「泰」这个汉字的结果。
 *
 * **11-11 补的实情**：百度连着查几次就吐「百度安全验证」（1438 字节的壳页），
 * 所以顺序改成 **360 → 搜狗 → 百度**，并且认「被挡」这件事（短页面 / 验证页直接跳过）；
 * 标题里的「下载 / 最新版 / 免费 / 安装包」这类门户标题也筛掉，不然塞进提示词全是垃圾。
 */
export interface SearchHit {
  readonly title: string;
  readonly snippet: string;
}

export interface SearchResult {
  readonly ok: boolean;
  readonly engine: 'baidu' | 'sogou' | 'so360' | 'bing' | 'none';
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly ms: number;
  readonly reason?: string;
}

export interface LookupOutcome {
  readonly query: string;
  /** 压成一行给提示词用；搜不到就是空串 */
  readonly wiki: string;
  readonly hits: number;
  readonly engine: string;
  readonly cached: boolean;
  /** 没查的原因：no-name / daily-cap / no-hits */
  readonly skipped?: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SEARCH_TIMEOUT_MS = 6000;
const MAX_HITS = 6;

/** 这些进程就算前台也跟「游戏」无关：别把 Chrome 当游戏名去搜 */
const NOT_A_GAME = [
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi',
  'code', 'code-insiders', 'cursor', 'devenv', 'webstorm', 'idea',
  'explorer', 'notepad', 'notepad++', 'sublime_text',
  'windowsterminal', 'cmd', 'powershell', 'pwsh', 'conhost', 'wt',
  'discord', 'telegram', 'wechat', 'qq', 'wxwork', 'weixin',
  'potplayermini64', 'vlc', 'mpc-hc64', 'microsoft.photos', 'photos',
  'deepseek harness', 'electron',
  'bodyoffish', 'body of fish', '本鱼陪伴', 'dsh-pet',
];

/** 标题里的这些尾巴是启动器/门户加上的，不是游戏名的一部分 */
const SUFFIXES = [
  'steam', 'epic games', 'epic', 'ubisoft connect', 'uplay', 'origin', 'ea app',
  'battle.net', 'gog galaxy', 'xbox', 'wegame', '网易云游戏', '米哈游',
];

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&(?:nbsp|ensp|emsp|thinsp);/giu, ' ')
    .replace(/&hellip;/giu, '…')
    .replace(/&middot;/giu, '·')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&#x([0-9a-f]+);/giu, (_whole, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/gu, (_whole, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * 窗口标题 + 进程名 → 游戏名。搓不出来就回空串（调用方当「不认识」处理，不搜）。
 *
 * 例：`Terraria` → `Terraria`；`Terraria - Steam` → `Terraria`；
 * `砍树的时候 - Google Chrome`（进程 chrome）→ 空串。
 */
export function tidyGameName(title: string, exe = ''): string {
  const rawTitle = String(title ?? '').replace(/\s+/gu, ' ').trim();
  const rawExe = String(exe ?? '').replace(/\.exe$/iu, '').trim().toLowerCase();
  const haystack = `${rawTitle} ${rawExe}`.toLowerCase();
  if (NOT_A_GAME.some((bad) => rawExe === bad || haystack.includes(bad))) return '';
  if (rawTitle === '') return '';
  // 去掉「 - Steam」「 — Epic Games」这类尾巴；没有分隔符就整条留着
  let name = rawTitle;
  const parts = rawTitle.split(/\s+[-–—|]\s+/u);
  if (parts.length > 1 && parts[0]!.trim().length >= 2) name = parts[0]!.trim();
  const lower = name.toLowerCase();
  for (const suffix of SUFFIXES) {
    if (lower === suffix) return '';
    if (lower.endsWith(` ${suffix}`)) name = name.slice(0, name.length - suffix.length - 1).trim();
  }
  // 纯英文版本号/分辨率、纯符号都不算名字
  if (!/[\p{L}\p{N}]/u.test(name)) return '';
  if (name.length > 60) name = name.slice(0, 60);
  return name;
}

/** 门户/下载站的标题对「这是什么游戏」毫无帮助，反而会让提示词跑偏 */
const NOISE_TITLE = /(?:下载|最新版|安装包|绿色版|破解|汉化|官网_|App|^其他人还搜了|^相关搜索|^查看更多|^热门推荐)/u;

function dedupe(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const key = hit.title.toLowerCase();
    if (hit.title === '' || seen.has(key)) continue;
    if (NOISE_TITLE.test(hit.title)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/** 百度结果页：标题在 h3 里，摘要紧跟其后（c-abstract / content-right_ 两种版面都见过） */
export function parseBaidu(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const title = stripHtml(match[1] ?? '');
    if (title.length < 2) continue;
    const after = html.slice(re.lastIndex, re.lastIndex + 1500);
    const abstract = /<div[^>]*class="[^"]*(?:c-abstract|content-right)[^"]*"[^>]*>([\s\S]*?)<\/div>/u.exec(after)
      ?? /<span[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/u.exec(after);
    out.push({
      title: title.slice(0, 80),
      snippet: abstract ? stripHtml(abstract[1] ?? '').slice(0, 120) : '',
    });
    if (out.length >= MAX_HITS) break;
  }
  return dedupe(out);
}

/** 搜狗结果页：同样是 h3 标题 + str-text-info / str_info 摘要 */
export function parseSogou(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const title = stripHtml(match[1] ?? '');
    if (title.length < 2) continue;
    const after = html.slice(re.lastIndex, re.lastIndex + 1500);
    const abstract = /<div[^>]*class="[^"]*str-text-info[^"]*"[^>]*>([\s\S]*?)<\/div>/u.exec(after)
      ?? /<p[^>]*class="[^"]*str_info[^"]*"[^>]*>([\s\S]*?)<\/p>/u.exec(after)
      ?? /<div[^>]*class="[^"]*fz-mid[^"]*"[^>]*>([\s\S]*?)<\/div>/u.exec(after);
    out.push({
      title: title.slice(0, 80),
      snippet: abstract ? stripHtml(abstract[1] ?? '').slice(0, 120) : '',
    });
    if (out.length >= MAX_HITS) break;
  }
  return dedupe(out);
}

/**
 * 必应中国结果页（11-11 实测最靠谱的一家）：`li.b_algo` → h2 标题 + 第一个 p 摘要，
 * 摘要形如「2026年4月19日 - 《泰拉瑞亚》是由 Re-Logic 所开发…」，日期前缀去掉。
 */
export function parseBing(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)<\/li>/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const title = stripHtml(match[1] ?? '');
    if (title.length < 2) continue;
    const para = /<p[^>]*>([\s\S]*?)<\/p>/u.exec(match[2] ?? '');
    const snippet = para === null ? '' : stripHtml(para[1] ?? '').replace(/^\d{4}年\d{1,2}月\d{1,2}日\s*[-·–]\s*/u, '');
    out.push({ title: title.slice(0, 80), snippet: snippet.slice(0, 120) });
    if (out.length >= MAX_HITS) break;
  }
  return dedupe(out);
}

/** 360 结果页：h3.res-title 标题 + p.res-desc 摘要（摘要里带日期前缀，去掉） */
export function parseSo360(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const title = stripHtml(match[1] ?? '');
    if (title.length < 2) continue;
    const after = html.slice(re.lastIndex, re.lastIndex + 1500);
    const abstract = /<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/u.exec(after)
      ?? /<span[^>]*data-result-summary[^>]*>([\s\S]*?)<\/span>/u.exec(after);
    const snippet = abstract ? stripHtml(abstract[1] ?? '').replace(/^\d{4}年\d{1,2}月\d{1,2}日\s*[-·–]\s*/u, '') : '';
    out.push({ title: title.slice(0, 80), snippet: snippet.slice(0, 120) });
    if (out.length >= MAX_HITS) break;
  }
  return dedupe(out);
}

/** 认「这页不是结果页」：验证码页。别再按长度猜（真的结果页也可能很小，测试的固定片段就很小） */
function looksBlocked(html: string): boolean {
  return html.includes('安全验证') || html.includes('请输入验证码') || html.includes('人机验证');
}

async function fetchText(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 搜一次。360 → 搜狗 → 百度；抽不到标题就换下一家，全空就回 `ok:false`（调用方当没查）。
 * 百度查几次就要人机验证（11-11 实测），所以它排最后，被挡也算正常跳过。
 * **不抛异常**：陪伴这条路上任何失败都只是「这轮没有资料」。
 */
export async function searchWeb(
  query: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<SearchResult> {
  const q = String(query ?? '').trim();
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (q === '') return { ok: false, engine: 'none', query: q, hits: [], ms: 0, reason: 'empty-query' };
  const t0 = Date.now();
  const engines: { engine: 'baidu' | 'sogou' | 'so360' | 'bing'; url: string; parse: (html: string) => SearchHit[] }[] = [
    {
      engine: 'bing',
      url: `https://cn.bing.com/search?q=${encodeURIComponent(q)}&mkt=zh-CN&setlang=zh-Hans`,
      parse: parseBing,
    },
    { engine: 'sogou', url: `https://www.sogou.com/web?query=${encodeURIComponent(q)}`, parse: parseSogou },
    { engine: 'so360', url: `https://www.so.com/s?q=${encodeURIComponent(q)}`, parse: parseSo360 },
    { engine: 'baidu', url: `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`, parse: parseBaidu },
  ];
  let lastReason = 'no-hits';
  // 只有标题、没有摘要的那种结果（门户列表页）当备胎：真给不出摘要也比没有好
  let spare: { engine: 'baidu' | 'sogou' | 'so360' | 'bing'; hits: SearchHit[] } | null = null;
  for (const item of engines) {
    try {
      const html = await fetchText(item.url, timeoutMs, fetchImpl);
      if (looksBlocked(html)) {
        lastReason = 'blocked';
        continue;
      }
      const hits = item.parse(html);
      if (hits.length === 0) {
        lastReason = 'no-hits';
        continue;
      }
      const rich = hits.filter((hit) => hit.snippet.length >= 12);
      if (rich.length > 0) {
        return { ok: true, engine: item.engine, query: q, hits: rich, ms: Date.now() - t0 };
      }
      if (spare === null) spare = { engine: item.engine, hits };
      lastReason = 'no-snippet';
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }
  if (spare !== null) {
    return { ok: true, engine: spare.engine, query: q, hits: spare.hits, ms: Date.now() - t0 };
  }
  return { ok: false, engine: 'none', query: q, hits: [], ms: Date.now() - t0, reason: lastReason };
}

/** 把搜到的标题压成一行给提示词用（最多 4 条、总共 ~220 字，别把上下文吃光） */
export function wikiLine(result: SearchResult): string {
  if (!result.ok || result.hits.length === 0) return '';
  const picked = result.hits.slice(0, 4).map((hit) => {
    const brief = hit.snippet === '' ? '' : `：${hit.snippet}`;
    return `- ${hit.title}${brief}`;
  });
  return picked.join('\n').slice(0, 240);
}

export interface LookupBook {
  /** 按名字查一次；内部管缓存与当天次数上限，永不抛错 */
  lookup(name: string, nowMs?: number): Promise<LookupOutcome>;
  /** 今天用了多少次 / 上限多少（给日志和设置页看） */
  stats(nowMs?: number): { day: string; used: number; cap: number };
}

export interface LookupBookOptions {
  /** 每天最多查多少个不同的名字（同一款只算一次） */
  maxPerDay?: number;
  /** 同一个名字多久内不再重查 */
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 注入时钟（测试用） */
  clock?: () => number;
}

function dayKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function createLookupBook(options: LookupBookOptions = {}): LookupBook {
  const maxPerDay = options.maxPerDay ?? 12;
  const ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
  const clock = options.clock ?? Date.now;
  const cache = new Map<string, { at: number; outcome: LookupOutcome }>();
  let usedDay = '';
  let used = 0;

  const noteUsed = (nowMs: number): void => {
    const day = dayKey(nowMs);
    if (day !== usedDay) {
      usedDay = day;
      used = 0;
    }
  };

  return {
    async lookup(name, nowMs = clock()) {
      const key = String(name ?? '').trim();
      if (key === '') return { query: '', wiki: '', hits: 0, engine: 'none', cached: false, skipped: 'no-name' };
      noteUsed(nowMs);
      const hit = cache.get(key);
      if (hit && nowMs - hit.at < ttlMs) {
        return { ...hit.outcome, cached: true };
      }
      if (used >= maxPerDay) {
        return { query: key, wiki: '', hits: 0, engine: 'none', cached: false, skipped: 'daily-cap' };
      }
      used += 1;
      const found = await searchWeb(key, {
        timeoutMs: options.timeoutMs,
        fetchImpl: options.fetchImpl,
      });
      const outcome: LookupOutcome = {
        query: key,
        wiki: wikiLine(found),
        hits: found.hits.length,
        engine: found.engine,
        cached: false,
        ...(found.ok ? {} : { skipped: 'no-hits' }),
      };
      cache.set(key, { at: nowMs, outcome });
      return outcome;
    },
    stats(nowMs = clock()) {
      noteUsed(nowMs);
      return { day: usedDay, used, cap: maxPerDay };
    },
  };
}
