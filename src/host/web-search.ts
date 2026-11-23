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
 *
 * **11-22 哥哥 m36168 定的第三件事**：免费搜索要「读得到内容」。做法是
 * 360 只认 `li.res-list`（真广告是 `e-newsl-box`，压根不在里面）→ 解 `so.com/link` 跳转壳 →
 * 并发抓前 2 页抽正文（≥300 字才用，否则退回标题+摘要）。实测 0.5~1.4 秒拿到 900~1200 字真内容。
 */
export interface SearchHit {
  readonly title: string;
  readonly snippet: string;
  /** 真地址（有它才谈得上抓正文）；360 给的是 so.com/link 跳转壳，抓之前要先解开 */
  readonly url?: string;
  /** 站点域名（360 的 <cite>）：同域只留一条，日志里也好看 */
  readonly site?: string;
  /** 抓到的正文（≤800 字）；没有就退回 snippet —— 哥哥 11-22 要「免费也能读到内容」 */
  readonly text?: string;
}

export interface SearchResult {
  readonly ok: boolean;
  readonly engine: 'baidu' | 'sogou' | 'so360' | 'bing' | 'deepseek' | 'none';
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
/**
 * 【汐儿 · 11-22 m36168】免费搜索只拿 33~97 字摘要，哥哥嫌「抓不到内容」。
 * 实测（5 个查询）：解跳 + 并发抓 2 页 + 抽正文 = 0.5~1.4 秒，2/2 能拿到 900~1200 字真内容。
 * 所以给「读正文」一条独立预算：单页 1.5 秒、最多 2 页、≥300 字才算数，拿不到就退回标题+摘要。
 */
const PAGE_PICK = 2;
const PAGE_TIMEOUT_MS = 1500;
const PAGE_MIN_CHARS = 300;
const PAGE_MAX_CHARS = 800;
/** 视频/直播站的「正文」全是导航和推荐，跳过（实测虎牙抽出来是「王者荣耀 英雄联盟 和平精英…」） */
const PAGE_HOST_SKIP = /(?:^|\.)(?:huya|douyin|youtube|bilibili|iqiyi|youku|twitch|kuaishou|v\.qq)\.(?:com|tv)$/u;

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

/** 360 自家的产品页：抓进去也抽不到正文（AI 摘要页、图片、文库、知道、快搜内容农场） */
const SO360_SELF_HOST = /^(?:ai|image|video|wenku|wenda|info|hao|m|mip|mipcdn)\.so\.com$|(?:^|\.)360kuai\.com$|^e\.360\.cn$/u;
/** 360 塞在结果里的推荐位/信息流：不是搜索结果，标题长这样 */
const SO360_NOISE_TITLE = /短视频大全|360图片|360文库|相关搜索|其他人还搜了|相关游戏|相关软件|反馈$/u;

/**
 * 360 结果页（11-22 起是首选引擎）：**只认 `li.res-list`**。
 *
 * 为什么要这么死板：360 的真广告是 `e-newsl-box` 那种整块推广（带「广告」字样），
 * 它压根不在 res-list 里；而 res-list 里混着「其他人还搜了 / 360图片 / 短视频大全 / 相关搜索·反馈」
 * ——按 h3 一把抓会把它们全当结果（老实现就是这么错的，哥哥说的「抓到广告」多半是这些）。
 * 顺带把 url 和 site 留下：有 url 才能抓正文，有 site 才能同域只留一条。
 */
export function parseSo360(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const re = /<li[^>]*class="[^"]*\bres-list\b[^"]*"[^>]*>([\s\S]*?)<\/li>/giu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const block = match[1] ?? '';
    const titlePart = /<h3[^>]*>([\s\S]*?)<\/h3>/u.exec(block);
    if (titlePart === null) continue;
    const title = stripHtml(titlePart[1] ?? '');
    if (title.length < 2 || SO360_NOISE_TITLE.test(title)) continue;
    const anchorPart = /<a[^>]+href="([^"]+)"/u.exec(block);
    const url = anchorPart === null ? '' : (anchorPart[1] ?? '').replace(/&amp;/gu, '&');
    if (url !== '' && !/^https?:/u.test(url)) continue;
    const citePart = /<cite[^>]*>([\s\S]*?)<\/cite>/u.exec(block);
    const site = citePart === null
      ? ''
      : stripHtml(citePart[1] ?? '').replace(/^https?:\/\//u, '').replace(/\/.*$/u, '').replace(/\s+/gu, '');
    if (site !== '' && SO360_SELF_HOST.test(site)) continue;
    if (site !== '') {
      if (seen.has(site)) continue;
      seen.add(site);
    }
    const descPart = /<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/u.exec(block)
      ?? /<span[^>]*data-result-summary[^>]*>([\s\S]*?)<\/span>/u.exec(block);
    const snippet = descPart === null
      ? ''
      : stripHtml(descPart[1] ?? '').replace(/^\d{4}年\d{1,2}月\d{1,2}日\s*[-·–]\s*/u, '');
    out.push({
      title: title.slice(0, 80),
      snippet: snippet.slice(0, 120),
      ...(url === '' ? {} : { url }),
      ...(site === '' ? {} : { site }),
    });
    if (out.length >= MAX_HITS) break;
  }
  return dedupe(out);
}

/** 认「这页不是结果页」：验证码页。别再按长度猜（真的结果页也可能很小，测试的固定片段就很小） */
function looksBlocked(html: string): boolean {
  return html.includes('安全验证') || html.includes('请输入验证码') || html.includes('人机验证');
}

async function fetchText(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /**
   * 【11-16 体检】上层的预算（chat-search 2 秒）要比我这家的 6 秒短，
   * 所以要能把外层的 abort 透进来——否则预算到点只是「不要结果」，请求还在跑。
   */
  const forward = (): void => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forward, { once: true });
  }
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
    if (signal !== undefined) signal.removeEventListener('abort', forward);
  }
}

/**
 * 把一整页 HTML 剥成「像正文的几行」。
 * 只留 ≥24 字的行（导航、按钮、版权那种短句直接丢），最多 `maxChars` 字。
 * 实测这条规则对中关村在线/值得买/游侠网/9game 都能抽出真正的正文段。
 */
export function pageText(html: string, maxChars = PAGE_MAX_CHARS): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/giu, ' ')
    .replace(/<header[\s\S]*?<\/header>/giu, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<\/(?:p|div|li|h[1-6]|br|tr|section|article)>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ');
  const plain = text
    .replace(/&(?:nbsp|ensp|emsp|thinsp);/giu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"');
  // 中文页才有「按空格切成一串短词」的导航行；英文正文本来就按空格分，别误杀
  const cjk = (plain.match(/[\u4e00-\u9fff]/gu) ?? []).length;
  const chinese = cjk / Math.max(1, plain.length) > 0.05;
  const kept: string[] = [];
  for (const raw of plain.split('\n')) {
    const line = raw.replace(/[ \t\u00a0]+/gu, ' ').trim();
    if (line.length < 24) continue;
    // 「・ 《Fate/stay night》中文免安装版」这类相关链接的列表项：不是正文
    if (/^[・·•|]/u.test(line)) continue;
    if (chinese) {
      const tokens = line.split(/\s+/u).filter((token) => token !== '');
      const compact = line.replace(/\s+/gu, '').length;
      // 「页游大全 今日开服 页游新闻 测试表 厂商黄页」：段多、每段还短 → 导航条
      if (tokens.length >= 5 && compact / tokens.length < 6) continue;
    }
    if (kept[kept.length - 1] === line) continue;
    kept.push(line);
  }
  return kept.join('\n').slice(0, maxChars);
}

/** 360 的 href 是 `so.com/link?m=…` 跳转壳（正文就一行 `window.location.replace("真地址")`），先解开 */
async function resolveSoLink(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  if (!/^https?:\/\/(?:www\.)?so\.com\/link\?/u.test(url)) return url;
  try {
    const html = await fetchText(url, Math.min(timeoutMs, 2500), fetchImpl, signal);
    const found = /location\.replace\("([^"]+)"\)/u.exec(html) ?? /URL='([^']+)'/u.exec(html);
    return found === null ? '' : (found[1] ?? '').replace(/&amp;/gu, '&');
  } catch {
    return '';
  }
}

/**
 * 给前两条结果补正文。**永不抛**：抓不到就是没有 text，调用方退回标题 + 摘要。
 * 只挑 2 条、并发、每条 1.5 秒上限 —— 实测最坏 1.4 秒，最好 0.15 秒。
 */
async function readPages(
  hits: readonly SearchHit[],
  options: { timeoutMs: number; fetchImpl: typeof fetch; signal?: AbortSignal },
): Promise<SearchHit[]> {
  const picks: number[] = [];
  for (let i = 0; i < hits.length && picks.length < PAGE_PICK; i += 1) {
    const url = hits[i]?.url ?? '';
    if (url === '') continue;
    let host = '';
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      continue;
    }
    if (PAGE_HOST_SKIP.test(host)) continue;
    picks.push(i);
  }
  if (picks.length === 0) return [...hits];

  const bodies = await Promise.all(
    picks.map(async (index): Promise<string> => {
      const real = await resolveSoLink(hits[index]?.url ?? '', options.timeoutMs, options.fetchImpl, options.signal);
      if (real === '') return '';
      try {
        const html = await fetchText(real, options.timeoutMs, options.fetchImpl, options.signal);
        const body = pageText(html);
        return body.length >= PAGE_MIN_CHARS ? body : '';
      } catch {
        return '';
      }
    }),
  );

  const out = [...hits];
  picks.forEach((index, order) => {
    const body = bodies[order] ?? '';
    const hit = out[index];
    if (body !== '' && hit !== undefined) out[index] = { ...hit, text: body };
  });
  return out;
}

/**
 * 搜一次。**360 → 搜狗 → Bing → 百度**；抽不到标题就换下一家，全空就回 `ok:false`（调用方当没查）。
 *
 * 11-22 哥哥实测后定的顺序：Bing 中国版对中文长尾查询经常给垃圾（查「泰拉瑞亚 1.4.5」回「泰」字字典），
 * 360 三个查询全对，所以 Bing 从首选降成兜底。拿到的结果还会顺手补正文（见 readPages）。
 * 百度查几次就要人机验证（11-11 实测），所以它排最后，被挡也算正常跳过。
 * **不抛异常**：陪伴这条路上任何失败都只是「这轮没有资料」。
 */
export interface SearchProvider {
  /** free = 抓搜索引擎的结果页（免费，只有标题 + 短摘要）；deepseek = DeepSeek 搜索 API（要 key，摘要 600~800 字） */
  readonly kind: 'free' | 'deepseek';
  readonly baseUrl: string;
  readonly apiKey: string;
  /** 兼容别家的搜索接口时能填（DeepSeek 自己的搜索不吃 model） */
  readonly model?: string;
}

export interface SearchWebOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** 搜索来源：给了 deepseek 就先走它，失败再落回免费那条 */
  provider?: SearchProvider;
}

/**
 * DeepSeek 搜索 API（官方文档 2026-11-22 查：`POST https://api.deepseek.com/v1/tools/search`）。
 * 返回每条带 `summary`（600~800 字，给模型读的）比抓网页的标题摘要强得多；$0.75/千次成功请求。
 * 兼容别家：地址能改，`model` 只是留给兼容服务，DeepSeek 自己不认。
 */
export async function searchDeepSeek(
  query: string,
  options: SearchProvider & { count?: number; timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<SearchResult> {
  const q = String(query ?? '').trim();
  const t0 = Date.now();
  if (q === '') return { ok: false, engine: 'none', query: q, hits: [], ms: 0, reason: 'empty-query' };
  if (options.apiKey.trim() === '') return { ok: false, engine: 'none', query: q, hits: [], ms: 0, reason: 'no-key' };
  const base = (options.baseUrl.trim() === '' ? 'https://api.deepseek.com' : options.baseUrl.trim()).replace(/\/+$/u, '');
  const url = /\/v1$/u.test(base) ? `${base}/tools/search` : `${base}/v1/tools/search`;
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
  try {
    const res = await (options.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey.trim()}`,
      },
      body: JSON.stringify({ query: q, count: options.count ?? MAX_HITS }),
      signal,
    });
    if (!res.ok) {
      return { ok: false, engine: 'none', query: q, hits: [], ms: Date.now() - t0, reason: `http-${res.status}` };
    }
    const body = (await res.json()) as { results?: unknown };
    const list = Array.isArray(body.results) ? body.results : [];
    const hits: SearchHit[] = [];
    for (const raw of list) {
      if (raw === null || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      // summary 是给模型看的 600~800 字；没有就退到 snippet（100~200 字）
      const long = typeof item.summary === 'string' && item.summary.trim() !== '' ? item.summary.trim() : '';
      const short = typeof item.snippet === 'string' ? item.snippet.trim() : '';
      const text = long !== '' ? long : short;
      if (title === '' || text === '') continue;
      hits.push({ title, snippet: text });
      if (hits.length >= MAX_HITS) break;
    }
    if (hits.length === 0) {
      return { ok: false, engine: 'none', query: q, hits: [], ms: Date.now() - t0, reason: 'no-hits' };
    }
    return { ok: true, engine: 'deepseek', query: q, hits, ms: Date.now() - t0 };
  } catch (error) {
    const reason = controller.signal.aborted ? 'timeout' : error instanceof Error ? error.message : String(error);
    return { ok: false, engine: 'none', query: q, hits: [], ms: Date.now() - t0, reason };
  } finally {
    clearTimeout(timer);
  }
}

export async function searchWeb(
  query: string,
  options: SearchWebOptions = {},
): Promise<SearchResult> {
  const q = String(query ?? '').trim();
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (q === '') return { ok: false, engine: 'none', query: q, hits: [], ms: 0, reason: 'empty-query' };
  // 【汐儿 · 11-22 m35769】哥哥嫌免费爬虫搜得差：切到 DeepSeek 搜索就先用它；
  // 它挂了（没网、欠费、超时）再落回下面这条免费路，别让她这轮什么都没查到。
  if (options.provider?.kind === 'deepseek' && options.provider.apiKey.trim() !== '') {
    const paid = await searchDeepSeek(q, {
      ...options.provider,
      timeoutMs: Math.min(timeoutMs, 2500),
      fetchImpl,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (paid.ok) return paid;
  }
  const t0 = Date.now();
  const engines: { engine: 'baidu' | 'sogou' | 'so360' | 'bing'; url: string; parse: (html: string) => SearchHit[] }[] = [
    { engine: 'so360', url: `https://www.so.com/s?q=${encodeURIComponent(q)}`, parse: parseSo360 },
    { engine: 'sogou', url: `https://www.sogou.com/web?query=${encodeURIComponent(q)}`, parse: parseSogou },
    {
      engine: 'bing',
      url: `https://cn.bing.com/search?q=${encodeURIComponent(q)}&mkt=zh-CN&setlang=zh-Hans`,
      parse: parseBing,
    },
    { engine: 'baidu', url: `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`, parse: parseBaidu },
  ];
  let lastReason = 'no-hits';
  // 只有标题、没有摘要的那种结果（门户列表页）当备胎：真给不出摘要也比没有好
  let spare: { engine: 'baidu' | 'sogou' | 'so360' | 'bing'; hits: SearchHit[] } | null = null;
  for (const item of engines) {
    // 外层已经不等了（超时/用户又说了新话）就别再一家家试下去了
    if (options.signal?.aborted === true) {
      lastReason = 'aborted';
      break;
    }
    try {
      const html = await fetchText(item.url, timeoutMs, fetchImpl, options.signal);
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
        const filled = await readPages(rich, {
          timeoutMs: Math.min(timeoutMs, PAGE_TIMEOUT_MS),
          fetchImpl,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return { ok: true, engine: item.engine, query: q, hits: filled, ms: Date.now() - t0 };
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

/**
 * 把搜到的资料压成一段给提示词用。
 * 有正文（11-22 起）就给前两条的正文各 420 字、总 900 字；
 * 没正文就退回老样子：4 条标题 + 摘要，总 240 字（别把上下文吃光）。
 */
export function wikiLine(result: SearchResult): string {
  if (!result.ok || result.hits.length === 0) return '';
  const rich = result.hits.filter((hit) => (hit.text ?? '').length >= PAGE_MIN_CHARS).slice(0, 2);
  if (rich.length > 0) {
    return rich
      .map((hit) => `- ${hit.title}：\n${(hit.text ?? '').slice(0, 420)}`)
      .join('\n')
      .slice(0, 900);
  }
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
