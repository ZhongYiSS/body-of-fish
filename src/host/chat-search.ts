/**
 * chat-search.ts —— 聊天/语音里「她要自己判断要不要上网查」（本鱼 · 11-11 m20130 / m20199）
 *
 * 哥哥的原话：「上网找，本地最好不要，搜索她可以自己判断，次数的话，我觉得直接不设上限，
 * 只看该怎么避免过长的耗时和如果搜索失败怎么回退。」后来又补一句：
 * 「放宽一点吧，但也不要问句就查，我觉得直接把工具给模型就好了。」
 *
 * 所以这里不再用关键词猜意图，而是**把「搜索」当成一个工具交给她**：
 *   - 第一轮就把工具说明拼进 system（`SEARCH_TOOL_HINT`），她需要查时**只输出一行**标记
 *     `[[web_search: 查询词]]`；
 *   - 宿主看见标记才真去搜（`createSearchRunner`），搜完把资料塞回 system 让她接着答；
 *   - 不需要查的时候**一轮就结束**，不多花一次模型调用、更不花网络。
 *
 * 两个硬指标（哥哥点名要的）：
 *   - **耗时封顶**：搜索 2 秒到点就放弃，绝不把一轮对话拖成十秒；同一查询 10 分钟内只搜一次。
 *   - **失败就明说没查到**：搜空、超时、被验证页挡，一律给她一句「别编细节」的兜底提示。
 *
 * 三条边界（沿用 web-search）：图永不上传、只搜文字、搜不到就说没查到。
 */
import { searchWeb, type SearchHit, type SearchResult } from './web-search';

/** 拼进 system 的工具说明：只在「联网查」开着时加。标记必须一眼能认，且不像正常文本。 */
export const SEARCH_TOOL_HINT = [
  '【工具：web_search】你可以上网查东西（人名、作品、价格、攻略、新闻、天气、配置要求……）。',
  '需要查的时候，**只输出这一行**，不要写别的字：',
  '[[web_search: 查询词]]',
  '查询词控制在 30 字以内，用关键词，不要问句。',
  '我会把查到的结果交给你，你再用自己的话说给他听。',
  '不需要查就直接回答，别输出标记。',
  '查到的东西只当参考：**别照念、别编没查到的细节**；没查到的部分就说没查到。',
].join('\n');

/** 一轮里最多允许她连续查几次（防死循环；实际很少超过 1） */
export const MAX_SEARCH_ROUNDS = 1;

const TOOL_CALL = /\[\[\s*web_search\s*[:：]\s*([^\]\n]{1,80})\]\]/iu;

/** 从她的话里认出工具调用；认不出就 null。顺带把标记前后的正文剥出来（有时她会先嘀咕一句）。 */
export function parseToolCall(text: string): { query: string; rest: string } | null {
  const match = TOOL_CALL.exec(text);
  if (match === null) return null;
  const query = (match[1] ?? '').trim().slice(0, 60);
  if (query === '') return null;
  const rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  return { query, rest };
}

export interface ChatSearchDeps {
  /** 搜一次；默认就是 web-search 的 searchWeb（测试可替换） */
  readonly search?: (query: string, timeoutMs: number) => Promise<SearchResult>;
  /** 搜一次的预算，默认 2000ms */
  readonly searchBudgetMs?: number;
  readonly now?: () => number;
}

export interface SearchOutcome {
  readonly ok: boolean;
  /** 塞进 system 的那段（空串 = 什么都不加） */
  readonly note: string;
  readonly query: string;
  readonly hits: number;
  readonly engine: string;
  readonly cached: boolean;
  readonly ms: number;
  /** timeout / failed / no-hits 三种失败；ok 时没有 */
  readonly reason?: 'timeout' | 'failed';
}

export interface SearchRunner {
  run(query: string): Promise<SearchOutcome>;
  clearCache(): void;
}

const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 50;
const NOTE_MAX = 700;
const HIT_TEXT_MAX = 90;

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, Math.max(1, ms));
    // 别为了一个计时器把进程吊住（测试里尤其明显）
    (timer as unknown as { unref?: () => void }).unref?.();
    const finish = (value: T | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    task.then(
      (value) => finish(value),
      () => finish(null),
    );
  });
}

/** 模型吐出来的检索词：去引号、去「查询：」前缀、压空白 */
export function cleanQuery(raw: string): string {
  let text = raw.trim();
  if (text === '') return '';
  text = text.replace(/^[`"'「『【]+|[`"'」』】]+$/gu, '');
  text = text.replace(/^(?:query|查询|检索词|搜索词)\s*[:：]\s*/iu, '');
  text = text.split(/\r?\n/u)[0] ?? '';
  text = text.replace(/\s+/gu, ' ').trim();
  if (text.length < 2) return '';
  return text.slice(0, 40);
}

/** 命中的标题 + 摘要压成一段资料；空标题跳过 */
export function composeNote(query: string, hits: readonly SearchHit[]): string {
  const picked: string[] = [];
  for (const hit of hits) {
    const title = hit.title.trim();
    const snippet = hit.snippet.trim();
    if (title === '') continue;
    const line =
      snippet === ''
        ? `- ${title.slice(0, HIT_TEXT_MAX)}`
        : `- ${title.slice(0, HIT_TEXT_MAX)}：${snippet.slice(0, HIT_TEXT_MAX)}`;
    if (picked.push(line) >= 4) break;
  }
  if (picked.length === 0) return '';
  const head = `【刚在网上查到的（"${query}"，只当参考，别照念）】`;
  return `${head}\n${picked.join('\n')}`.slice(0, NOTE_MAX);
}

/** 搜不到时的兜底提示：宁可认没查到，也别让人以为她查过了 */
export function failedNote(): string {
  return '（这句你本来想上网查，但这次没查到：说清你没查到就行，别编细节。）';
}

export function createSearchRunner(deps: ChatSearchDeps = {}): SearchRunner {
  const budgetMs = deps.searchBudgetMs ?? 2000;
  const search =
    deps.search ??
    ((query: string, timeoutMs: number): Promise<SearchResult> =>
      searchWeb(query, { timeoutMs }).catch(
        (): SearchResult => ({ ok: false, engine: 'none', query, hits: [], ms: 0, reason: 'thrown' }),
      ));
  const cache = new Map<string, { at: number; result: SearchResult }>();
  const now = deps.now ?? (() => Date.now());

  return {
    clearCache(): void {
      cache.clear();
    },

    async run(query: string): Promise<SearchOutcome> {
      const started = now();
      const clean = cleanQuery(query);
      if (clean === '') {
        return { ok: false, note: failedNote(), query, hits: 0, engine: 'none', cached: false, ms: 0, reason: 'failed' };
      }

      const cached = cache.get(clean);
      if (cached !== undefined && now() - cached.at < CACHE_MS) {
        const note = composeNote(clean, cached.result.hits);
        return {
          ok: note !== '',
          note: note === '' ? failedNote() : note,
          query: clean,
          hits: cached.result.hits.length,
          engine: cached.result.engine,
          cached: true,
          ms: now() - started,
        };
      }

      const result = await withTimeout(search(clean, budgetMs), budgetMs + 500);
      if (result === null) {
        return {
          ok: false,
          note: failedNote(),
          query: clean,
          hits: 0,
          engine: 'none',
          cached: false,
          ms: now() - started,
          reason: 'timeout',
        };
      }
      if (!result.ok || result.hits.length === 0) {
        return {
          ok: false,
          note: failedNote(),
          query: clean,
          hits: 0,
          engine: result.engine,
          cached: false,
          ms: now() - started,
          reason: 'failed',
        };
      }

      if (cache.size >= CACHE_MAX) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest !== undefined) cache.delete(oldest[0]);
      }
      cache.set(clean, { at: now(), result });
      const note = composeNote(clean, result.hits);
      return {
        ok: note !== '',
        note: note === '' ? failedNote() : note,
        query: clean,
        hits: result.hits.length,
        engine: result.engine,
        cached: false,
        ms: now() - started,
        ...(note === '' ? { reason: 'failed' as const } : {}),
      };
    },
  };
}
