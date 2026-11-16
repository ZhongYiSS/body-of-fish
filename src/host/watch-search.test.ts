/**
 * 查资料链路的单测（本鱼 · 11-10 m18596）
 *
 * 全部用**固定 HTML 片段 + 假 fetch**，不真的上网：
 * 真联网验证另放在 `D:\AI\存档\临时\probe_search*.mjs` 手动跑，测试要能离线过。
 *
 * 钉死的语义：
 *   ① 窗口标题搓不出游戏名时回空串（浏览器/终端/我们自己一律不算），调用方就没名字可查；
 *   ② 百度先试、抽不到标题再搜狗；两个都空就 `ok:false`，绝不抛；
 *   ③ 同一款当天只查一次（配额），同一个名字 6 小时内直接吃缓存；
 *   ④ 给提示词的资料最多 4 条、总共 ≤240 字。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createLookupBook, parseBaidu, parseBing, parseSogou, searchWeb, tidyGameName, wikiLine } from './web-search';
import { cleanTitle, parseForegroundLine, UNKNOWN_FOREGROUND } from './idle';

const BAIDU_HTML = `
<html><body>
<div class="result">
  <h3 class="t"><a href="https://wiki.biligame.com/terraria/%E6%9C%88%E8%80%80">月耀 - 泰拉瑞亚WIKI_BWIKI</a></h3>
  <div class="c-abstract">月耀是泰拉瑞亚中一种魔法武器，由月亮领主掉落。</div>
</div>
<div class="result">
  <h3 class="t"><a href="https://www.gamersky.com/x">泰拉瑞亚月耀怎么获得</a></h3>
  <div class="c-abstract">击败月亮领主后有 10% 概率掉落。</div>
</div>
<div class="result">
  <h3 class="t"><a href="https://example.com/y">月耀（消歧义）</a></h3>
  <span class="content-right_x">本条目列出同名事物。</span>
</div>
</body></html>`;

const SOGOU_HTML = `
<html><body>
<div class="vrwrap">
  <h3 class="vrTitle"><a href="/link?url=1">泰拉瑞亚 月耀 - 搜狗百科</a></h3>
  <div class="str-text-info">月耀是困难模式的魔法武器。</div>
</div>
</body></html>`;

/** 必应中国（11-11 起排第一，实测最靠谱）：li.b_algo → h2 标题 + p 摘要 */
const BING_HTML = `
<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://wiki.biligame.com/terraria">月耀 - 官方中文 Terraria Wiki</a></h2>
  <p>2026年4月19日&ensp;&#0183;&ensp;月耀是泰拉瑞亚中一把魔法武器，由月亮领主掉落。</p></li>
<li class="b_algo"><h2><a href="https://baike.example">泰拉瑞亚_百度百科</a></h2>
  <p>2011年5月16日&ensp;&#0183;&ensp;泰拉瑞亚是 Re-Logic 开发的沙盒游戏。</p></li>
<li class="b_algo"><h2><a href="https://example.com/y">月耀（消歧义）</a></h2>
  <p>本条目列出同名事物的消歧义说明，别当成游戏内容。</p></li>
</ol></body></html>`;

/** 假 fetch：按 url 里的域名决定回哪段 HTML */
function fakeFetch(pages: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const key = url.includes('bing.com')
      ? 'bing'
      : url.includes('sogou.com')
        ? 'sogou'
        : url.includes('baidu.com')
          ? 'baidu'
          : 'other';
    const body = pages[key];
    if (body === undefined) return new Response('', { status: 500 });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as unknown as typeof fetch;
}

describe('tidyGameName：窗口标题 → 游戏名', () => {
  test('干净的标题原样用', () => {
    assert.equal(tidyGameName('Terraria', 'Terraria'), 'Terraria');
    assert.equal(tidyGameName('星露谷物语', 'Stardew Valley'), '星露谷物语');
  });

  test('去掉启动器尾巴', () => {
    assert.equal(tidyGameName('Terraria - Steam', 'Terraria'), 'Terraria');
    assert.equal(tidyGameName('赛博朋克2077 — GOG Galaxy', ''), '赛博朋克2077');
  });

  test('浏览器 / 终端 / 编辑器 / 我们自己：一律不算游戏', () => {
    assert.equal(tidyGameName('砍树的时候 - Google Chrome', 'chrome'), '');
    assert.equal(tidyGameName('PowerShell', 'powershell'), '');
    assert.equal(tidyGameName('index.ts - dsh-pet2 - Visual Studio Code', 'Code'), '');
    assert.equal(tidyGameName('身体陪玩模式 — DeepSeek Harness', 'DeepSeek Harness'), '');
    assert.equal(tidyGameName('本鱼陪伴', 'BodyOfFish'), '');
  });

  test('空标题、纯符号、纯启动器名都不算', () => {
    assert.equal(tidyGameName('', ''), '');
    assert.equal(tidyGameName('   ', 'game'), '');
    assert.equal(tidyGameName('***', 'x'), '');
    assert.equal(tidyGameName('Steam', 'steam'), '');
  });

  test('太长的标题截到 60 字', () => {
    assert.equal(tidyGameName('游'.repeat(90), '').length, 60);
  });
});

describe('parseBing / parseBaidu / parseSogou：从结果页抠标题和摘要', () => {
  test('必应抽得到 3 条，摘要里的日期和 %ensp; 实体都清掉', () => {
    const hits = parseBing(BING_HTML);
    assert.equal(hits.length, 3);
    assert.equal(hits[0]!.title, '月耀 - 官方中文 Terraria Wiki');
    assert.match(hits[0]!.snippet, /魔法武器/u);
    assert.doesNotMatch(hits[0]!.snippet, /2026年/u);
    assert.doesNotMatch(hits[0]!.snippet, /&/u);
  });

  test('百度抽得到 3 条，摘要跟得上', () => {
    const hits = parseBaidu(BAIDU_HTML);
    assert.equal(hits.length, 3);
    assert.equal(hits[0]!.title, '月耀 - 泰拉瑞亚WIKI_BWIKI');
    assert.match(hits[0]!.snippet, /魔法武器/u);
    assert.match(hits[2]!.snippet, /同名事物/u);
  });

  test('搜狗抽得到标题，摘要来自 str-text-info', () => {
    const hits = parseSogou(SOGOU_HTML);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.title, '泰拉瑞亚 月耀 - 搜狗百科');
    assert.match(hits[0]!.snippet, /魔法武器/u);
  });

  test('没结果的页面回空数组，不炸', () => {
    assert.deepEqual(parseBaidu('<html><body>no result</body></html>'), []);
    assert.deepEqual(parseSogou(''), []);
  });
});

describe('searchWeb：必应先、搜狗次、都不抛', () => {
  test('必应有结果就不碰别家', async () => {
    const found = await searchWeb('泰拉瑞亚 月耀', { fetchImpl: fakeFetch({ bing: BING_HTML }) });
    assert.equal(found.ok, true);
    assert.equal(found.engine, 'bing');
    assert.equal(found.hits.length, 3);
  });

  test('必应空 → 退到搜狗', async () => {
    const found = await searchWeb('泰拉瑞亚 月耀', {
      fetchImpl: fakeFetch({ bing: '<html><body>什么都没有</body></html>', sogou: SOGOU_HTML }),
    });
    assert.equal(found.ok, true);
    assert.equal(found.engine, 'sogou');
  });

  test('必应被验证页挡 → 跳过它换下一家', async () => {
    const found = await searchWeb('泰拉瑞亚 月耀', {
      fetchImpl: fakeFetch({ bing: '<html><title>百度安全验证</title></html>', sogou: SOGOU_HTML }),
    });
    assert.equal(found.ok, true);
    assert.equal(found.engine, 'sogou');
  });

  test('两个都空 → ok:false，不抛', async () => {
    const found = await searchWeb('一个不存在的玩意儿', {
      fetchImpl: fakeFetch({ baidu: '<html></html>', sogou: '<html></html>' }),
    });
    assert.equal(found.ok, false);
    assert.deepEqual(found.hits, []);
  });

  test('空查询直接拒绝，不发请求', async () => {
    let called = 0;
    const spy = (async () => {
      called += 1;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const found = await searchWeb('   ', { fetchImpl: spy });
    assert.equal(found.ok, false);
    assert.equal(found.reason, 'empty-query');
    assert.equal(called, 0);
  });

  test('网络抛错也只是「没查到」', async () => {
    const boom = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const found = await searchWeb('泰拉瑞亚', { fetchImpl: boom });
    assert.equal(found.ok, false);
    assert.equal(found.reason, 'ECONNRESET');
  });
});

describe('wikiLine：给提示词的那一行', () => {
  test('最多 4 条，总长不超过 240', () => {
    const line = wikiLine({
      ok: true,
      engine: 'baidu',
      query: 'q',
      ms: 1,
      hits: Array.from({ length: 8 }, (_v, i) => ({ title: `标题${i}`.repeat(3), snippet: '摘要'.repeat(30) })),
    });
    assert.ok(line.length <= 240, `长 ${line.length}`);
    assert.equal(line.split('\n').length, 4);
  });

  test('没搜到就是空串', () => {
    assert.equal(wikiLine({ ok: false, engine: 'none', query: 'q', hits: [], ms: 1 }), '');
  });
});

describe('createLookupBook：缓存 + 当天配额', () => {
  test('同一个名字第二次吃缓存，不再发请求', async () => {
    let calls = 0;
    const spy = (async (input: string | URL | Request) => {
      calls += 1;
      return new Response(BING_HTML, { status: 200 });
    }) as unknown as typeof fetch;
    const book = createLookupBook({ fetchImpl: spy, clock: () => Date.UTC(2026, 10, 10, 4, 0, 0) });
    const first = await book.lookup('Terraria');
    const second = await book.lookup('Terraria');
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
    assert.match(first.wiki, /沙盒/u);
  });

  test('超过当天上限就跳过（同一款不算新的）', async () => {
    const spy = (async () => new Response(BING_HTML, { status: 200 })) as unknown as typeof fetch;
    const book = createLookupBook({ fetchImpl: spy, maxPerDay: 1, clock: () => Date.UTC(2026, 10, 10, 4, 0, 0) });
    const a = await book.lookup('Terraria');
    const b = await book.lookup('另一个游戏');
    assert.equal(a.skipped, undefined);
    assert.equal(b.skipped, 'daily-cap');
    assert.equal(book.stats().used, 1);
    assert.equal(book.stats().cap, 1);
  });

  test('没名字就不查', async () => {
    const book = createLookupBook({ fetchImpl: fakeFetch({}) });
    const out = await book.lookup('  ');
    assert.equal(out.skipped, 'no-name');
    assert.equal(out.wiki, '');
  });
});

describe('parseForegroundLine：idle|标题|进程名', () => {
  test('三段正常切', () => {
    const info = parseForegroundLine('1234|Terraria|Terraria');
    assert.deepEqual(info, { idleMs: 1234, hwnd: 0, title: 'Terraria', exe: 'terraria', url: '', rect: { x: 0, y: 0, w: 0, h: 0 }, screen: { w: 0, h: 0 } });
  });

  test('标题里带竖线也不切错', () => {
    const info = parseForegroundLine('88|A|B - Terraria|terraria');
    assert.equal(info.idleMs, 88);
    assert.equal(info.title, 'A|B - Terraria');
    assert.equal(info.exe, 'terraria');
  });

  test('空串、坏数字都回「不知道」', () => {
    assert.deepEqual(parseForegroundLine(''), UNKNOWN_FOREGROUND);
    assert.equal(parseForegroundLine('abc||').idleMs, -1);
    assert.equal(parseForegroundLine('4294967295||').idleMs, -1);
  });
});

// 【汐儿 · 11-16 m21691】回归：PowerShell 那边曾经把 '[<>\r\n\t]' 当正则用，
// .NET 里那是「反斜杠 + 字母」，于是标题里的 r/n/t 全被换成空格
// （实测「sheets - 文件资源管理器」→「shee s - 文件资源管理器」）。
test('标题里的字母不能被吃掉（r/n/t 回归）', () => {
  assert.equal(cleanTitle('sheets - 文件资源管理器'), 'sheets - 文件资源管理器');
  assert.equal(cleanTitle('Program Manager'), 'Program Manager');
  assert.equal(cleanTitle('  Windows\tTerminal\u200b  '), 'Windows Terminal');
  const line = '31<|>659358<|>Program Manager<|>explorer<|>https://x.test/a<|>0,0,800,600<|>2560,1600';
  const fg = parseForegroundLine(line);
  assert.equal(fg.title, 'Program Manager');
  assert.equal(fg.exe, 'explorer');
});
