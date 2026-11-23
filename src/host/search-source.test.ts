/**
 * search-source.test.ts —— 「联网查」的来源可选 + 窗口名兜底（【汐儿 · 11-22 m35769】）
 *
 * 哥哥的原话：「1联网搜索是连到哪了？能不能直接用ds的搜索？总感觉目前的搜索好像效果不太好。
 * 2：读窗口名生效了吗？」→ 默认免费、可切 DeepSeek（地址/key/模型都能填）、窗口名读不到就用进程名兜。
 *
 * 这里钉死四件事：
 *   ① DeepSeek 搜索打的是 `/v1/tools/search`，带 Bearer，body 只有 query + count；
 *   ② 返回里的 `summary`（600~800 字）优先，没有再退 `snippet`；
 *   ③ 没填 key 就**不许**发请求，也别拦着——直接回落免费四引擎；
 *   ④ 前台没标题时用进程名兜一个名字，别让她说「不知道」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exeLabel, readLiveContext } from './screen-context';
import { searchDeepSeek, searchWeb } from './web-search';

const PROVIDER = {
  kind: 'deepseek' as const,
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-test',
};

function jsonFetch(payload: unknown, status = 200): { calls: string[]; impl: typeof fetch } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url));
    // 记下请求体，方便断言「只发了 query + count」
    (impl as unknown as { lastBody?: string }).lastBody = String(init?.body ?? '');
    (impl as unknown as { lastHeaders?: Record<string, string> }).lastHeaders =
      (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test('DeepSeek 搜索：打 /v1/tools/search，带 Bearer，只发 query + count', async () => {
  const fake = jsonFetch({ results: [{ title: '战地 6 第五赛季', summary: '长摘要…', snippet: '短摘要' }] });
  const out = await searchDeepSeek('战地6 第五赛季', { ...PROVIDER, timeoutMs: 500, fetchImpl: fake.impl });
  assert.equal(out.ok, true);
  assert.equal(out.engine, 'deepseek');
  assert.equal(out.hits.length, 1);
  // summary（长摘要）优先于 snippet
  assert.equal(out.hits[0]?.snippet, '长摘要…');
  assert.equal(fake.calls[0], 'https://api.deepseek.com/v1/tools/search');
  const body = JSON.parse((fake.impl as unknown as { lastBody: string }).lastBody) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['count', 'query']);
  const headers = (fake.impl as unknown as { lastHeaders: Record<string, string> }).lastHeaders;
  assert.equal(headers.authorization, 'Bearer sk-test');
});

test('DeepSeek 搜索：baseUrl 已经带 /v1 就不重复拼', async () => {
  const fake = jsonFetch({ results: [{ title: 't', snippet: 's' }] });
  await searchDeepSeek('q', { ...PROVIDER, baseUrl: 'https://example.com/v1/', fetchImpl: fake.impl });
  assert.equal(fake.calls[0], 'https://example.com/v1/tools/search');
});

test('DeepSeek 搜索：没填 key 一个请求都不许发', async () => {
  const fake = jsonFetch({ results: [{ title: '不该出现', snippet: 'x' }] });
  const out = await searchDeepSeek('q', { ...PROVIDER, apiKey: '  ', fetchImpl: fake.impl });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-key');
  assert.equal(fake.calls.length, 0);
});

test('DeepSeek 搜索：HTTP 报错 / 没有结果都算没查到，不编', async () => {
  const bad = jsonFetch({}, 429);
  const one = await searchDeepSeek('q', { ...PROVIDER, fetchImpl: bad.impl });
  assert.equal(one.ok, false);
  assert.equal(one.reason, 'http-429');
  const empty = jsonFetch({ results: [] });
  const two = await searchDeepSeek('q', { ...PROVIDER, fetchImpl: empty.impl });
  assert.equal(two.ok, false);
  assert.equal(two.reason, 'no-hits');
});

test('searchWeb：选了 DeepSeek 且填了 key 就走 DeepSeek，不再抓网页', async () => {
  const fake = jsonFetch({ results: [{ title: '泰拉瑞亚 1.4.5', summary: '更新说明' }] });
  const out = await searchWeb('泰拉瑞亚 1.4.5', { provider: PROVIDER, timeoutMs: 500, fetchImpl: fake.impl });
  assert.equal(out.engine, 'deepseek');
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0] ?? '', /\/v1\/tools\/search$/u);
});

test('searchWeb：选了 DeepSeek 但没 key，安静回落免费（key 为空不许花那笔钱）', async () => {
  const fake = jsonFetch({ results: [] });
  const out = await searchWeb('q', {
    provider: { ...PROVIDER, apiKey: '' },
    timeoutMs: 300,
    fetchImpl: fake.impl,
  });
  assert.notEqual(out.engine, 'deepseek');
  assert.equal(
    fake.calls.some((url) => url.includes('/tools/search')),
    false,
  );
});

test('窗口名兜底：进程名认得就给中文，不认识给原名，空串给空', () => {
  assert.equal(exeLabel('explorer.exe'), '资源管理器');
  assert.equal(exeLabel('MSEDGE.EXE'), 'Edge');
  assert.equal(exeLabel('SomeApp.exe'), 'someapp');
  assert.equal(exeLabel(''), '');
});

test('readLiveContext：标题是空串时退到进程名（任务栏也不再「不知道」）', async () => {
  const remembered: string[] = [];
  const out = await readLiveContext({
    readForeground: async () => ({ title: '', idleMs: 1000, rect: { w: 2560, h: 72 }, screen: { w: 2560, h: 1600 }, exe: 'explorer' }),
    remember: (label) => {
      remembered.push(label);
    },
    timeline: () => [],
    now: 1_000_000,
  });
  assert.equal(out.title, '资源管理器');
  // 兜出来的名字也要进时间线，不然「他刚在资源管理器」这条线就断了
  assert.deepEqual(remembered, ['资源管理器']);
});

test('readLiveContext：有标题就用标题，不被进程名盖掉', async () => {
  const out = await readLiveContext({
    readForeground: async () => ({ title: 'Battlefield™ 6', idleMs: 200, rect: null, screen: null, exe: 'bf6' }),
    remember: () => undefined,
    timeline: () => [],
    now: 1_000_000,
  });
  assert.equal(out.title, 'Battlefield™ 6');
});