import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanQuery,
  composeNote,
  createSearchRunner,
  failedNote,
  parseToolCall,
  SEARCH_TOOL_HINT,
} from './chat-search';
import type { SearchResult } from './web-search';

const hit = (title: string, snippet: string) => ({ title, snippet });

function result(query: string, hits: { title: string; snippet: string }[]): SearchResult {
  return { ok: hits.length > 0, engine: 'bing', query, hits, ms: 3 };
}

test('工具说明里给出标记格式，且写明「不用查就别输出标记」', () => {
  assert.match(SEARCH_TOOL_HINT, /\[\[web_search: 查询词\]\]/u);
  assert.match(SEARCH_TOOL_HINT, /不用查就直接答/u);
  assert.match(SEARCH_TOOL_HINT, /别编没查到的/u);
  assert.match(SEARCH_TOOL_HINT, /别念网址/u);
});

test('parseToolCall：认出标记、剥掉正文、全角冒号也认', () => {
  const one = parseToolCall('好的，[[web_search: 黑神话 虎先锋 打法]]');
  assert.deepEqual(one, { query: '黑神话 虎先锋 打法', rest: '好的，' });
  const two = parseToolCall('[[web_search：泰拉瑞亚 1.4.5 更新]]');
  assert.deepEqual(two, { query: '泰拉瑞亚 1.4.5 更新', rest: '' });
  assert.equal(parseToolCall('今天好累'), null);
  assert.equal(parseToolCall('[[web_search:   ]]'), null);
  // 不是这个工具（别的方括号）不许误认
  assert.equal(parseToolCall('[[image: 123]]'), null);
  assert.equal(parseToolCall('[[web_search]]'), null);
});

test('查到了：标题 + 摘要压进提示词，只当资料', async () => {
  const runner = createSearchRunner({
    search: async (q) =>
      result(q, [
        hit('虎先锋怎么打 - 攻略站', '先用定身术把它按住，再绕到背后打'),
        hit('黑神话悟空攻略', '第二章路线与 Boss 一览'),
      ]),
  });
  const out = await runner.run('黑神话 悟空 虎先锋 打法');
  assert.equal(out.ok, true);
  assert.equal(out.query, '黑神话 悟空 虎先锋 打法');
  assert.equal(out.hits, 2);
  assert.equal(out.engine, 'bing');
  assert.equal(out.cached, false);
  assert.match(out.note, /【刚在网上查到的/u);
  assert.match(out.note, /定身术/u);
  assert.equal(out.reason, undefined);
});

test('有正文时资料给正文，不再只喂 90 字摘要（11-22 m36168）', () => {
  const body = '第五赛季加入拉斯维加斯地图，大型结构支持动态破坏，载具与步兵配合有了新打法。'.repeat(8);
  const note = composeNote('战地6 第五赛季', [
    { title: '战地6 第五赛季更新汇总', snippet: '很短的摘要', text: body },
    hit('另一条', '第二条摘要'),
  ]);
  assert.match(note, /拉斯维加斯/u);
  assert.ok(note.length > 300, `正文没进去，长 ${note.length}`);
  assert.ok(note.length <= 1100, `超上限了：${note.length}`);
  // 只当参考的口气不变
  assert.match(note, /只当参考，别照念/u);
});

test('正文太短（<300 字）就不算正文，退回摘要', () => {
  const note = composeNote('q', [{ title: '标题', snippet: '这只是一句摘要', text: '短'.repeat(80) }]);
  assert.match(note, /这只是一句摘要/u);
});

test('搜不到时给「别编」兜底，不装查过', async () => {
  const runner = createSearchRunner({ search: async (q) => result(q, []) });
  const out = await runner.run('某个查不到的东西');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'failed');
  assert.equal(out.note, failedNote());
  assert.match(out.note, /别编细节/u);
});

test('搜索接口自己报错（ok:false）也算失败', async () => {
  const runner = createSearchRunner({
    search: async (q) => ({ ok: false, engine: 'none', query: q, hits: [], ms: 1, reason: 'blocked' }),
  });
  const out = await runner.run('随便');
  assert.equal(out.reason, 'failed');
  assert.equal(out.note, failedNote());
});

test('同一个查询十分钟内只搜一次', async () => {
  let searched = 0;
  const runner = createSearchRunner({
    search: async (q) => {
      searched += 1;
      return result(q, [hit('泰拉瑞亚更新日志', '加入新的装备与 Boss')]);
    },
  });
  const first = await runner.run('泰拉瑞亚 1.4.5 更新');
  const second = await runner.run('泰拉瑞亚 1.4.5 更新');
  assert.equal(searched, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.note, first.note);
});

test('搜索超时 → 明说没查到（不会把一轮对话拖住）', async () => {
  const runner = createSearchRunner({
    searchBudgetMs: 20,
    search: () => new Promise<SearchResult>(() => {}),
  });
  const out = await runner.run('很慢的查询');
  assert.equal(out.reason, 'timeout');
  assert.equal(out.note, failedNote());
  assert.ok(out.ms < 2000);
});

test('空查询不打网络，直接算失败', async () => {
  let searched = 0;
  const runner = createSearchRunner({
    search: async (q) => {
      searched += 1;
      return result(q, [hit('x', 'y')]);
    },
  });
  const out = await runner.run('  ');
  assert.equal(searched, 0);
  assert.equal(out.reason, 'failed');
});

test('cleanQuery：去引号、去前缀、取第一行', () => {
  assert.equal(cleanQuery('  "黑神话 悟空"  '), '黑神话 悟空');
  assert.equal(cleanQuery('查询：泰拉瑞亚 wiki'), '泰拉瑞亚 wiki');
  assert.equal(cleanQuery('第一行\n第二行不要'), '第一行');
  assert.equal(cleanQuery('a'), '');
  assert.equal(cleanQuery('   '), '');
  assert.equal(cleanQuery('很长'.repeat(40)).length, 40);
});

test('composeNote：最多四条、跳过空标题、总长收住', () => {
  const note = composeNote('q', [
    hit('一', '一' + 'x'.repeat(200)),
    hit('', '空标题不要'),
    hit('二', '二'),
    hit('三', '三'),
    hit('四', '四'),
    hit('五', '五'),
  ]);
  const lines = note.split('\n');
  assert.equal(lines.length, 5); // 抬头 + 4 条
  assert.equal(note.includes('空标题不要'), false);
  assert.ok(note.length <= 700);
  assert.equal(composeNote('q', [hit('', '')]), '');
});

test('超时要把底下的请求一起掐掉：signal 真的被 abort（11-16 体检）', async () => {
  let seen: AbortSignal | undefined;
  const runner = createSearchRunner({
    searchBudgetMs: 20,
    search: (_query, _timeoutMs, signal) => {
      seen = signal;
      return new Promise<SearchResult>(() => {});
    },
  });
  const out = await runner.run('掐掉的查询');
  assert.equal(out.reason, 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(seen !== undefined, '应该把 signal 传到底层');
  assert.equal(seen?.aborted, true, '预算到点后底层请求必须被掐断');
});

test('搜失败也写负缓存：一分钟内同一句不再重复白跑（11-16 体检）', async () => {
  let searched = 0;
  const runner = createSearchRunner({
    search: async (q) => {
      searched += 1;
      return { ok: false, engine: 'none', query: q, hits: [], ms: 1, reason: 'blocked' };
    },
  });
  const first = await runner.run('没结果的查询');
  const second = await runner.run('没结果的查询');
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(searched, 1, '60 秒内同一句只该真正搜一次');
  assert.equal(second.cached, true);
});
