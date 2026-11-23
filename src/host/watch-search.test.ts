/**
 * 查资料链路的单测（本鱼 · 11-10 m18596）
 *
 * 全部用**固定 HTML 片段 + 假 fetch**，不真的上网：
 * 真联网验证另放在 `D:\AI\存档\临时\probe_search*.mjs` 手动跑，测试要能离线过。
 *
 * 钉死的语义：
 *   ① 窗口标题搓不出游戏名时回空串（浏览器/终端/我们自己一律不算），调用方就没名字可查；
 *   ② 360 先试、抽不到标题再搜狗、再 Bing、最后百度；全空就 `ok:false`，绝不抛；
 *   ②' 360 只认 li.res-list，广告块/自家产品/「相关搜索」一律不算结果（11-22 m36168）；
 *   ③ 同一款当天只查一次（配额），同一个名字 6 小时内直接吃缓存；
 *   ④ 给提示词的资料最多 4 条、总共 ≤240 字。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLookupBook,
  pageText,
  parseBaidu,
  parseBing,
  parseSo360,
  parseSogou,
  searchWeb,
  tidyGameName,
  wikiLine,
} from './web-search';
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

/**
 * 360 结果页（11-22 起是首选）：真广告是 `e-newsl-box` 整块推广，**不在 res-list 里**；
 * res-list 里混着「360 自家 AI 页」「相关搜索·反馈」「同域第二条」——解析器要全丢掉。
 */
const SO360_HTML = `
<html><body>
<div class="e-newsl-box"><h3 class="res-title"><a href="https://hao.360.com/ad">广告推广：某某旗舰店</a></h3>
  <p class="res-desc">整块推广，不是搜索结果，绝不许当资料。</p></div>
<ul class="result">
<li class="res-list" data-i="0">
  <h3 class="res-title"><a href="https://www.so.com/link?m=aaa">战地6 第五赛季更新内容汇总-中关村在线</a></h3>
  <p class="res-desc">2026年10月13日 - 第五赛季加入两张新地图与一个大逃杀模式，载具同步更新。</p>
  <cite>m.zol.com.cn</cite>
</li>
<li class="res-list">
  <h3 class="res-title"><a href="https://www.so.com/link?m=bbb">战地6 第五赛季玩法解析-游侠网</a></h3>
  <p class="res-desc">新载具与新武器一并上线，赛季通行证同步开启。</p>
  <cite>www.ali213.net</cite>
</li>
<li class="res-list">
  <h3 class="res-title"><a href="https://www.so.com/link?m=ccc">AI 摘要：战地6 是什么</a></h3>
  <p class="res-desc">360 自家 AI 页，抓进去也抽不出正文。</p>
  <cite>ai.so.com</cite>
</li>
<li class="res-list">
  <h3 class="res-title"><a href="javascript:;">相关搜索·反馈</a></h3>
  <p class="res-desc"></p>
  <cite></cite>
</li>
<li class="res-list">
  <h3 class="res-title"><a href="https://www.so.com/link?m=ddd">战地6 另一篇-中关村在线</a></h3>
  <p class="res-desc">同域第二条，应该被去重掉，不许挤掉别家。</p>
  <cite>m.zol.com.cn</cite>
</li>
</ul></body></html>`;

/** so.com/link 的跳转壳：正文就一行 window.location.replace */
const SO360_SHELL = `<html><body><script>window.location.replace("https://m.zol.com.cn/article/1.html")</script>
<noscript><meta http-equiv="refresh" content="0;URL='https://m.zol.com.cn/article/1.html'"></noscript></body></html>`;

/** 第二条指向视频站：抓不到正文（假 fetch 对 bilibili 回 500），用来验「抓不到就退回摘要」 */
const SO360_SHELL_VIDEO = `<html><body><script>window.location.replace("https://www.bilibili.com/video/BV1xx")</script></body></html>`;

/** 真文章页：长段才是正文，短导航行要被 pageText 丢掉 */
const ARTICLE_HTML = `
<html><body><nav>首页 游戏 硬件 手机</nav>
<div class="content">
<p>战地6第五赛季将于2026年10月13日正式上线，本次更新加入拉斯维加斯与另一张城市地图，还原城市主干道与标志性建筑群。</p>
<p>大型结构支持动态破坏，玩家可以炸开整栋楼的外墙制造通路，载具与步兵的配合因此有了新的打法。</p>
<p>赛季通行证同步开启，包含新武器、新载具涂装与一批限时任务，通行证奖励分免费与付费两档。</p>
<p>地图设计上，开发组把可破坏区域集中在中城与海滨两条主轴，进攻方可以从地铁隧道绕到建筑内部，防守方则需要提前封堵楼梯口。</p>
<p>武器平衡方面，突击步枪的中距离伤害略微下调，冲锋枪的移动射击散布收窄，狙击枪的开镜时间缩短了四十毫秒。</p>
<p>官方同时公布了后续两个赛季的排期，预计明年春季上线一张雪地地图，夏季加入夜战模式与新的载具种类。</p>
</div><footer>版权所有</footer></body></html>`;

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
          : url.includes('so.com/link')
            ? url.includes('m=bbb')
              ? 'link-video'
              : 'link'
            : url.includes('so.com')
              ? 'so360'
              : url.includes('zol.com.cn')
                ? 'article'
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

describe('searchWeb：360 先、搜狗次、Bing 兜底、都不抛', () => {
  test('360 有结果就不碰别家', async () => {
    const found = await searchWeb('战地6 第五赛季', { fetchImpl: fakeFetch({ so360: SO360_HTML }) });
    assert.equal(found.ok, true);
    assert.equal(found.engine, 'so360');
    assert.equal(found.hits.length, 2);
  });

  test('360 空 → 退到搜狗', async () => {
    const found = await searchWeb('泰拉瑞亚 月耀', {
      fetchImpl: fakeFetch({ so360: '<html><body>什么都没有</body></html>', sogou: SOGOU_HTML }),
    });
    assert.equal(found.ok, true);
    assert.equal(found.engine, 'sogou');
  });

  test('360 被验证页挡 → 跳过它换下一家', async () => {
    const found = await searchWeb('泰拉瑞亚 月耀', {
      fetchImpl: fakeFetch({ so360: '<html><title>请输入验证码</title></html>', sogou: SOGOU_HTML }),
    });
    assert.equal(found.ok, true);
    assert.equal(found.engine, 'sogou');
  });

  test('Bing 降成兜底：360 和搜狗都空才用它', async () => {
    const found = await searchWeb('泰拉瑞亚 月耀', {
      fetchImpl: fakeFetch({ so360: '<html></html>', sogou: '<html></html>', bing: BING_HTML }),
    });
    assert.equal(found.ok, true);
    assert.equal(found.engine, 'bing');
    assert.equal(found.hits.length, 3);
  });

  test('解跳 + 抓正文：前两条补上 text', async () => {
    const found = await searchWeb('战地6 第五赛季', {
      fetchImpl: fakeFetch({ so360: SO360_HTML, link: SO360_SHELL, 'link-video': SO360_SHELL_VIDEO, article: ARTICLE_HTML }),
    });
    assert.equal(found.ok, true);
    assert.ok((found.hits[0]!.text ?? '').length >= 300, `第一条正文 ${(found.hits[0]!.text ?? '').length} 字`);
    assert.match(found.hits[0]!.text ?? '', /拉斯维加斯/u);
    // 视频站/抓不到的：只留标题 + 摘要，不许抛
    assert.equal(found.hits[1]!.text, undefined);
  });

  test('正文抓不到就退回标题 + 摘要，不抛', async () => {
    const found = await searchWeb('战地6 第五赛季', {
      fetchImpl: fakeFetch({ so360: SO360_HTML, link: SO360_SHELL }),
    });
    assert.equal(found.ok, true);
    assert.equal(found.hits[0]!.text, undefined);
    assert.match(found.hits[0]!.snippet, /大逃杀/u);
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

describe('parseSo360：只认有机结果（11-22 m36168）', () => {
  test('广告块、自家 AI 页、相关搜索、同域第二条全部丢掉', () => {
    const hits = parseSo360(SO360_HTML);
    assert.equal(hits.length, 2);
    assert.deepEqual(
      hits.map((hit) => hit.title),
      ['战地6 第五赛季更新内容汇总-中关村在线', '战地6 第五赛季玩法解析-游侠网'],
    );
    assert.equal(hits[0]!.site, 'm.zol.com.cn');
    assert.equal(hits[0]!.url, 'https://www.so.com/link?m=aaa');
    assert.doesNotMatch(hits.map((hit) => hit.title).join('|'), /广告推广|AI 摘要|相关搜索|另一篇/u);
  });

  test('摘要里的日期前缀去掉', () => {
    const hits = parseSo360(SO360_HTML);
    assert.doesNotMatch(hits[0]!.snippet, /2026年/u);
  });
});

describe('pageText：把整页剥成像正文的几行', () => {
  test('长段留下、导航和版权那种短行丢掉', () => {
    const body = pageText(ARTICLE_HTML);
    assert.match(body, /拉斯维加斯/u);
    assert.match(body, /动态破坏/u);
    assert.doesNotMatch(body, /版权所有/u);
    assert.doesNotMatch(body, /首页 游戏 硬件 手机/u);
  });

  test('空格切的导航条、・开头的关系链接、重复标题都丢掉（11-22 真机看到的样子）', () => {
    const body = pageText(`<div>
<p>页游大全 今日开服 页游新闻 测试表 厂商黄页 新游评测 页游视频</p>
<p>・ 《Fate/stay night》中文免安装版</p>
<p>1.4.5版本的一大核心变化是重新设计的制作界面，旨在让玩家更轻松地浏览游戏内如今已超六千件的庞大物品库。</p>
<p>1.4.5版本的一大核心变化是重新设计的制作界面，旨在让玩家更轻松地浏览游戏内如今已超六千件的庞大物品库。</p>
</div>`);
    assert.doesNotMatch(body, /页游大全/u);
    assert.doesNotMatch(body, /Fate/u);
    assert.equal(body.split('\n').length, 1, `重复标题没去重：${body}`);
  });

  test('超长就截到上限', () => {
    const body = pageText(`<p>${'长'.repeat(3000)}</p>`, 500);
    assert.equal(body.length, 500);
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

  test('有正文就给正文（≤900 字），没正文才退回摘要', () => {
    const body = '战地6第五赛季加入拉斯维加斯地图，支持动态破坏。'.repeat(30);
    const line = wikiLine({
      ok: true,
      engine: 'so360',
      query: 'q',
      ms: 1,
      hits: [{ title: '战地6 第五赛季', snippet: '短摘要', text: body }],
    });
    assert.ok(line.length <= 900, `长 ${line.length}`);
    assert.match(line, /拉斯维加斯/u);
    assert.ok(line.length > 300, `正文没进去，长 ${line.length}`);
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
    // 11-22 起引擎顺序是 360 → 搜狗 → Bing：这个假 fetch 对谁都回必应页，
    // 所以第一次会试满三家。这里只关心「第二次一条都不发」。
    const afterFirst = calls;
    const second = await book.lookup('Terraria');
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.ok(afterFirst >= 1, `第一次应该发过请求，实际 ${afterFirst}`);
    assert.equal(calls, afterFirst);
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
