import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSubtitleBook,
  parseBiliVideo,
  parseStartSecond,
  parseSubtitleBody,
  normalizeCookie,
  pickSubtitleTrack,
  sliceAround,
} from './bili-subtitle.ts';

const BODY = JSON.stringify({
  body: [
    { from: 0, to: 2.5, content: '大家好' },
    { from: 130, to: 133, content: '这里是第二分钟的内容' },
    { from: 300, to: 303, content: '很后面的内容' },
  ],
});

test('bili-subtitle：网址里取 BV 号和分P', () => {
  assert.deepEqual(parseBiliVideo('https://www.bilibili.com/video/BV1m8WG6CEtj/?vd_source=x'), { bvid: 'BV1m8WG6CEtj', page: 1 });
  assert.deepEqual(parseBiliVideo('https://www.bilibili.com/video/BV1m8WG6CEtj?p=3'), { bvid: 'BV1m8WG6CEtj', page: 3 });
  assert.equal(parseBiliVideo('https://www.bilibili.com/'), null);
  assert.equal(parseBiliVideo('https://example.com/video/BV1m8WG6CEtj'), null);
  assert.equal(parseBiliVideo(''), null);
});

test('bili-subtitle：网址里的起始秒', () => {
  assert.equal(parseStartSecond('https://www.bilibili.com/video/BV1x?t=42'), 42);
  assert.equal(parseStartSecond('https://www.bilibili.com/video/BV1x?p=2&t=90'), 90);
  assert.equal(parseStartSecond('https://www.bilibili.com/video/BV1x'), null);
});

test('bili-subtitle：字幕 JSON 解析（坏行扔掉）', () => {
  const lines = parseSubtitleBody(BODY);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { from: 0, to: 2.5, text: '大家好' });
  assert.deepEqual(parseSubtitleBody('not json'), []);
  assert.deepEqual(parseSubtitleBody(JSON.stringify({ body: [{ from: 1, content: '  ' }] })), []);
});

test('bili-subtitle：只取前后两分钟', () => {
  const lines = parseSubtitleBody(BODY);
  const sliced = sliceAround(lines, 120);
  assert.equal(sliced.fromSec, 0);
  assert.equal(sliced.toSec, 240);
  assert.deepEqual(sliced.lines.map((line) => line.text), ['大家好', '这里是第二分钟的内容']);
  assert.ok(sliced.text.includes('第二分钟'));

  const late = sliceAround(lines, 300);
  assert.ok(late.lines.some((line) => line.text === '很后面的内容'));
});

test('bili-subtitle：太长就截断', () => {
  const long = Array.from({ length: 400 }, (_, i) => ({ from: i, to: i + 1, text: '很长的一句台词。' }));
  const sliced = sliceAround(long, 200);
  assert.ok(sliced.text.length <= 1510, '截断后仍太长：' + String(sliced.text.length));
});

test('bili-subtitle：挑中文轨（人工 zh 优先于 ai-zh）', () => {
  const list = [
    { lan: 'en', subtitle_url: '//x/en.json' },
    { lan: 'ai-zh', subtitle_url: '//x/ai.json' },
    { lan: 'zh-Hans', subtitle_url: '//x/zh.json' },
  ];
  assert.equal(pickSubtitleTrack(list), '//x/zh.json');
  assert.equal(pickSubtitleTrack([{ lan: 'ai-zh', subtitle_url: '//x/ai.json' }]), '//x/ai.json');
  assert.equal(pickSubtitleTrack([]), null);
  assert.equal(pickSubtitleTrack(undefined), null);
});

test('bili-subtitle：没填 cookie 直接放弃，不打网络', async () => {
  let called = 0;
  const book = createSubtitleBook({
    cookie: () => '',
    fetchImpl: (async () => {
      called += 1;
      throw new Error('不该被调用');
    }) as unknown as typeof fetch,
  });
  const out = await book.sliceFor('https://www.bilibili.com/video/BV1m8WG6CEtj/');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-cookie');
  assert.equal(called, 0);
});

test('bili-subtitle：不是 B站视频直接放过', async () => {
  const book = createSubtitleBook({ cookie: () => 'SESSDATA=abc', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
  assert.equal((await book.sliceFor('https://example.com/a')).reason, 'not-bili');
});

test('bili-subtitle：全链路（分P → 字幕轨 → 拉到文本），同一个 BV 只打一次', async () => {
  let calls = 0;
  const fetchImpl = (async (url: string) => {
    calls += 1;
    const target = String(url);
    if (target.includes('/pagelist')) return new Response(JSON.stringify({ data: [{ cid: 111 }, { cid: 222 }] }));
    if (target.includes('/player/v2')) {
      return new Response(JSON.stringify({ data: { subtitle: { subtitles: [{ lan: 'zh-Hans', subtitle_url: '//i0.hdslb.com/bfs/sub/1.json' }] } } }));
    }
    if (target.includes('hdslb.com')) return new Response(BODY);
    if (target.includes('/history/cursor')) {
      return new Response(JSON.stringify({ data: { list: [{ bvid: 'BV1m8WG6CEtj', progress: 130 }] } }));
    }
    return new Response('{}');
  }) as unknown as typeof fetch;

  const book = createSubtitleBook({ cookie: () => 'SESSDATA=abc', fetchImpl });
  const url = 'https://www.bilibili.com/video/BV1m8WG6CEtj/';
  const first = await book.sliceFor(url);
  assert.equal(first.ok, true);
  assert.equal(first.fromSec, 10);
  assert.equal(first.toSec, 250);
  assert.ok(first.text.includes('第二分钟'));
  const firstCalls = calls;

  const second = await book.sliceFor(url);
  assert.equal(second.ok, true);
  assert.equal(calls, firstCalls, '两分钟内应该走缓存，不再打网络');
});

test('bili-subtitle：没有字幕轨 → no-track，不抛', async () => {
  const fetchImpl = (async (url: string) => {
    const target = String(url);
    if (target.includes('/pagelist')) return new Response(JSON.stringify({ data: [{ cid: 1 }] }));
    if (target.includes('/player/v2')) return new Response(JSON.stringify({ data: { subtitle: { subtitles: [] } } }));
    return new Response(JSON.stringify({ data: { list: [] } }));
  }) as unknown as typeof fetch;
  const book = createSubtitleBook({ cookie: () => 'SESSDATA=abc', fetchImpl });
  const out = await book.sliceFor('https://www.bilibili.com/video/BV1m8WG6CEtj/');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-track');
});

test('bili-subtitle：接口全挂也不抛', async () => {
  const book = createSubtitleBook({
    cookie: () => 'SESSDATA=abc',
    fetchImpl: (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch,
  });
  const out = await book.sliceFor('https://www.bilibili.com/video/BV1m8WG6CEtj/');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-track');
});

test('bili-subtitle：填的登录信息怎么收拾（只填值 / 带前缀 / 整段 cookie）', () => {
  assert.equal(normalizeCookie('  abc123%2Cdef  '), 'SESSDATA=abc123%2Cdef');
  assert.equal(normalizeCookie('SESSDATA=abc123'), 'SESSDATA=abc123');
  assert.equal(normalizeCookie('Cookie: SESSDATA=abc123; bili_jct=zzz'), 'SESSDATA=abc123; bili_jct=zzz');
  assert.equal(normalizeCookie('   '), '');
});

test('bili-subtitle：整条时间轴一起拿（剧情梗概用），不查观看进度', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.includes('pagelist')) {
      return new Response(JSON.stringify({ data: [{ cid: 777 }] }), { status: 200 });
    }
    if (url.includes('player/v2')) {
      return new Response(
        JSON.stringify({ data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: '//a.b/c.json' }] } } }),
        { status: 200 },
      );
    }
    return new Response(BODY, { status: 200 });
  }) as unknown as typeof fetch;

  const book = createSubtitleBook({ cookie: () => 'SESSDATA=x', fetchImpl });
  const all = await book.allFor('https://www.bilibili.com/video/BV1xx411c7mD/');
  assert.equal(all.ok, true);
  assert.equal(all.lines.length, 3);
  assert.ok(!calls.some((url) => url.includes('history')), '梗概不需要观看进度');

  // 缓存：同一个 BV 再要一次不再打网络
  const before = calls.length;
  await book.allFor('https://www.bilibili.com/video/BV1xx411c7mD/');
  assert.equal(calls.length, before);
});
