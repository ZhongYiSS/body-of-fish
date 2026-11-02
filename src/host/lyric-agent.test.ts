/**
 * 歌词代理的行为用例：**不联网、不起 PowerShell**。
 * 播放器与网易云都靠注入（readPlayer / fetchImpl），时间用假 now 推，
 * 缓存落在 mkdtemp 出来的临时目录里，跑完删掉。
 *
 * 重点覆盖的就是旧版那三条特性：推算 + 校准（不是每拍都问播放器）、
 * 叶子零冗余（同一行不重复写）、坏缓存/无词不炸。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLyricAgent, type LyricAgentConfig } from './lyric-agent.ts';

// ── 夹具 ────────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000;

/** 假时钟：now() 返回当前毫秒，advance() 推进——不用真等待，测试就是秒级 */
function makeClock(start = T0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeCacheDir(): string {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-lyric-'));
    tempDirs.push(dir);
    return dir;
  } catch {
    // 裸 node 跑单文件时不会经过 scripts/test.mjs 的 TEMP 重定向，而本机的系统临时目录
    // 可能被 ACL 挡住（EPERM）。退回工作目录下一个点开头的一次性目录，跑完同样删掉。
    const dir = mkdtempSync(join(process.cwd(), '.lyric-test-'));
    tempDirs.push(dir);
    return dir;
  }
}

/** 等一个条件成立（真实定时器让出事件循环，上限 500 轮防死等），用于等 start() 的异步链落地 */
async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('等待超时：' + label);
}

/** 七句、每句 5 秒；第 2 句带翻译（测双语拼接） */
const LRC = [
  '[00:00.00]零',
  '[00:05.00]一',
  '[00:10.00]二',
  '[00:15.00]三',
  '[00:20.00]四',
  '[00:25.00]五',
  '[00:30.00]六',
].join('\n');
const TLYRIC = '[00:05.00]第一';

/** 播放器快照（就是 readPlayer 默认实现会吐的那种 JSON 文本） */
function player(positionMs: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    status: 'Playing',
    positionMs,
    endMs: 269_000,
    ...extra,
  });
}

/** 假网易云：搜歌 → 取词；counter 用来断言「没再发请求」 */
interface FetchCounter {
  calls: number;
  urls: string[];
}

function makeFetch(counter: FetchCounter, lrc: string = LRC, tlyric: string = TLYRIC): typeof fetch {
  return (async (input: unknown) => {
    counter.calls++;
    const url = String(input);
    counter.urls.push(url);
    if (url.includes('/api/search/get/web')) {
      return new Response(
        JSON.stringify({ result: { songs: [{ id: 186016, name: '晴天', artists: [{ name: '周杰伦' }] }] } }),
        { status: 200 },
      );
    }
    if (url.includes('/api/song/lyric')) {
      return new Response(JSON.stringify({ lrc: { lyric: lrc }, tlyric: { lyric: tlyric } }), { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

/** 一个 agent + 记录下来的 setLyric 调用 */
function makeAgent(options: {
  cacheDir: string;
  readPlayer: () => Promise<string>;
  fetchImpl: typeof fetch;
  now?: () => number;
  config?: LyricAgentConfig;
}) {
  const calls: Array<{ text: string; instrumental: boolean }> = [];
  const agent = createLyricAgent({
    cacheDir: options.cacheDir,
    readPlayer: options.readPlayer,
    fetchImpl: options.fetchImpl,
    ...(options.now ? { now: options.now } : {}),
    ...(options.config ? { config: options.config } : {}),
    setLyric: (text, instrumental) => {
      calls.push({ text, instrumental });
    },
  });
  return { agent, calls, last: () => calls[calls.length - 1] };
}

// ── 用例 ────────────────────────────────────────────────────────────────

describe('enabled:false（关掉就该完全安静）', () => {
  test('start() 不起定时器，tickOnce() 不读播放器', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    let reads = 0;
    globalThis.setTimeout = ((_fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return { unref() {}, ref() {}, hasRef: () => false } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    try {
      const clock = makeClock();
      const counter: FetchCounter = { calls: 0, urls: [] };
      const { agent, calls } = makeAgent({
        cacheDir: makeCacheDir(),
        now: clock.now,
        config: { enabled: false },
        readPlayer: async () => {
          reads++;
          return player(5_000);
        },
        fetchImpl: makeFetch(counter),
      });

      agent.start();
      assert.equal(delays.length, 0, '关掉时一个定时器都不该挂');
      assert.equal(reads, 0);

      const changed = await agent.tickOnce();
      assert.equal(changed, false);
      assert.equal(reads, 0, 'tickOnce 也不该碰播放器');
      assert.equal(calls.length, 0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe('正常一轮：播放中 → 取词 → 写正确那一行', () => {
  test('位置 6000ms 落在 [00:05] 那句，双语拼成两行', async () => {
    const clock = makeClock();
    const dir = makeCacheDir();
    const counter: FetchCounter = { calls: 0, urls: [] };
    const { agent, calls, last } = makeAgent({
      cacheDir: dir,
      now: clock.now,
      readPlayer: async () => player(6_000),
      fetchImpl: makeFetch(counter),
    });

    const changed = await agent.tickOnce();
    assert.equal(changed, true);
    assert.equal(calls.length, 1, '一轮只写一次叶子');
    assert.deepEqual(last(), { text: '一\n第一', instrumental: false });
    assert.equal(counter.calls, 2, '网易云：搜一次 + 取词一次');
    assert.match(counter.urls[0]!, /api\/search\/get\/web\?.*%E6%99%B4%E5%A4%A9/);
    assert.match(counter.urls[1]!, /api\/song\/lyric\?id=186016/);

    // 缓存落盘：按歌曲 id 一歌一文件（索引 index.json 由下一轮用例验证）
    const entry = JSON.parse(readFileSync(join(dir, '186016.json'), 'utf8')) as {
      lines: Array<{ ms: number; text: string; trans?: string }>;
    };
    assert.equal(entry.lines.length, 7);
    assert.deepEqual(entry.lines[1], { ms: 5_000, text: '一', trans: '第一' });
  });
});

describe('零冗余：同一行不重复写叶子', () => {
  test('推进 500ms 仍在同一句 → 第二次不调 setLyric', async () => {
    const clock = makeClock();
    const counter: FetchCounter = { calls: 0, urls: [] };
    const { agent, calls } = makeAgent({
      cacheDir: makeCacheDir(),
      now: clock.now,
      readPlayer: async () => player(5_000),
      fetchImpl: makeFetch(counter),
    });

    await agent.tickOnce();
    assert.equal(calls.length, 1);

    // 500ms 后还没到校准点（playingCalibMs 默认 20s），纯本地推算
    clock.advance(500);
    const changed = await agent.tickOnce();
    assert.equal(changed, false);
    assert.equal(calls.length, 1, '同一句重复写就是冗余');

    // 再推进到下一句（5000 → 10000 之间跨过 [00:10] = 二）
    clock.advance(5_000);
    const moved = await agent.tickOnce();
    assert.equal(moved, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { text: '二', instrumental: false });
  });
});

describe('校准：偏差超 maxDriftMs 才重设基准', () => {
  test('跳变 5 秒（> 1200ms）→ 用播放器真值重校准', async () => {
    const clock = makeClock();
    const counter: FetchCounter = { calls: 0, urls: [] };
    let reads = 0;
    let position = 5_000;
    const { agent, calls } = makeAgent({
      cacheDir: makeCacheDir(),
      now: clock.now,
      readPlayer: async () => {
        reads++;
        return player(position);
      },
      fetchImpl: makeFetch(counter),
    });

    await agent.tickOnce();
    assert.deepEqual(calls.at(-1), { text: '一\n第一', instrumental: false });
    assert.equal(reads, 1);

    // 推到校准点：本地推算应是 5000+20000=25000（第五句），
    // 但播放器说在 30000（第六句）——偏差 5000 > 1200，必须信真值
    clock.advance(20_000);
    position = 30_000;
    await agent.tickOnce();
    assert.equal(reads, 2);
    assert.deepEqual(calls.at(-1), { text: '六', instrumental: false });
  });

  test('小漂移 300ms（≤ 1200ms）→ 保留本地推算，不硬拽基准', async () => {
    const clock = makeClock();
    const counter: FetchCounter = { calls: 0, urls: [] };
    let position = 4_800;
    const { agent, calls } = makeAgent({
      cacheDir: makeCacheDir(),
      now: clock.now,
      readPlayer: async () => player(position),
      fetchImpl: makeFetch(counter),
    });

    await agent.tickOnce();
    assert.deepEqual(calls.at(-1), { text: '零', instrumental: false });

    // 关键在边界上：推算 4800+20000=24800 落在「四」，
    // 真值 25100 已经跨进「五」，偏差只有 300 → 保留推算 → 仍显示「四」。
    // 如果这里无脑对齐，气泡就会在两句之间多跳一下（旧版 maxDriftMs 想防的就是这个）。
    clock.advance(20_000);
    position = 25_100;
    await agent.tickOnce();
    assert.deepEqual(calls.at(-1), { text: '四', instrumental: false });

    // 再推 200ms 才自然进入下一句——说明基准确实没被拽过去
    clock.advance(200);
    await agent.tickOnce();
    assert.deepEqual(calls.at(-1), { text: '五', instrumental: false });
  });
});

describe('纯器乐 / 没词', () => {
  test('接口没给够 3 行 → instrumental=true 且文本空', async () => {
    const clock = makeClock();
    const counter: FetchCounter = { calls: 0, urls: [] };
    const { agent, last } = makeAgent({
      cacheDir: makeCacheDir(),
      now: clock.now,
      readPlayer: async () => player(6_000),
      // 只有一行 → 当没词（「纯音乐，请欣赏」也是这个待遇）
      fetchImpl: makeFetch(counter, '[00:00.00]纯音乐，请欣赏', ''),
    });

    await agent.tickOnce();
    assert.deepEqual(last(), { text: '', instrumental: true });
  });

  test('暂停 → 隐藏气泡（空文本 + instrumental=false）', async () => {
    const clock = makeClock();
    const counter: FetchCounter = { calls: 0, urls: [] };
    let status = 'Playing';
    const { agent, last } = makeAgent({
      cacheDir: makeCacheDir(),
      now: clock.now,
      readPlayer: async () => player(6_000, { status }),
      fetchImpl: makeFetch(counter),
    });

    await agent.tickOnce();
    assert.deepEqual(last(), { text: '一\n第一', instrumental: false });

    // 暂停靠「下一次校准」发现。注意：播放中校准间隔是 playingCalibMs(20s)，
    // 不是 idleCalibMs(8s)——8s 那一档只在「本来就没在播/没词」时才用。
    clock.advance(20_000);
    status = 'Paused';
    await agent.tickOnce();
    assert.deepEqual(last(), { text: '', instrumental: false }, '暂停要收起气泡，别留最后一句');
  });
});

describe('缓存命中', () => {
  test('同 cacheDir 的新实例：一轮下来一次 fetch 都不发', async () => {
    const clock = makeClock();
    const dir = makeCacheDir();
    const first: FetchCounter = { calls: 0, urls: [] };
    const a = makeAgent({
      cacheDir: dir,
      now: clock.now,
      readPlayer: async () => player(5_000),
      fetchImpl: makeFetch(first),
    });
    await a.agent.tickOnce();
    assert.equal(first.calls, 2);

    const second: FetchCounter = { calls: 0, urls: [] };
    const b = makeAgent({
      cacheDir: dir,
      now: clock.now,
      readPlayer: async () => player(5_000),
      fetchImpl: makeFetch(second),
    });
    await b.agent.tickOnce();
    assert.equal(second.calls, 0, '有缓存就不该再联网');
    assert.deepEqual(b.last(), { text: '一\n第一', instrumental: false });
  });

  test('坏缓存（结构不对）当没有：重新联网取词', async () => {
    const clock = makeClock();
    const dir = makeCacheDir();
    const first: FetchCounter = { calls: 0, urls: [] };
    await makeAgent({
      cacheDir: dir,
      now: clock.now,
      readPlayer: async () => player(5_000),
      fetchImpl: makeFetch(first),
    }).agent.tickOnce();

    // 手改坏数据文件（模拟旧版留下的半截 JSON / 乱码）
    writeFileSync(join(dir, '186016.json'), '{"lines": "not-an-array"}', 'utf8');

    const second: FetchCounter = { calls: 0, urls: [] };
    const b = makeAgent({
      cacheDir: dir,
      now: clock.now,
      readPlayer: async () => player(5_000),
      fetchImpl: makeFetch(second),
    });
    await b.agent.tickOnce();
    assert.equal(second.calls, 2, '坏缓存要当没有，重新取');
    assert.deepEqual(b.last(), { text: '一\n第一', instrumental: false });
  });
});

describe('缓存清理', () => {
  test('start() 时扫一次：超过 TTL 没听过的删掉，刚听过的留着', async () => {
    const clock = makeClock();
    const dir = makeCacheDir();
    const counter: FetchCounter = { calls: 0, urls: [] };
    await makeAgent({
      cacheDir: dir,
      now: clock.now,
      readPlayer: async () => player(5_000),
      fetchImpl: makeFetch(counter),
    }).agent.tickOnce();

    // 往索引里塞一首「8 天前听过」的歌（默认 TTL 7 天），配一份合法的数据文件
    const indexPath = join(dir, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, { id: string; at: number }>;
    index['旧歌|旧人'] = { id: '999', at: T0 - 8 * 24 * 3600 * 1000 };
    writeFileSync(indexPath, JSON.stringify(index), 'utf8');
    writeFileSync(
      join(dir, '999.json'),
      JSON.stringify({ id: '999', title: '旧歌', artist: '旧人', at: T0 - 8 * 86400000, lines: [{ ms: 0, text: '旧' }] }),
      'utf8',
    );

    const fresh: FetchCounter = { calls: 0, urls: [] };
    const { agent } = makeAgent({
      cacheDir: dir,
      now: clock.now,
      readPlayer: async () => player(5_000),
      fetchImpl: makeFetch(fresh),
    });
    try {
      agent.start();
      // 数据文件和索引是两步删的（先删文件、最后才重写索引），所以要等**索引**落定；
      // 而且重写索引时文件会短暂为空（writeFile 先截断），解析失败就当“还没写完”。
      const expiredGone = (): boolean => {
        try {
          const current = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
          return current['旧歌|旧人'] === undefined;
        } catch {
          return false;
        }
      };
      await waitForCondition(expiredGone, '索引里的过期项被清掉');
      assert.equal(existsSync(join(dir, '999.json')), false, '过期数据文件也要删');
      assert.equal(existsSync(join(dir, '186016.json')), true, '刚听过的歌不能删');
      const after = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
      assert.ok(after['晴天|周杰伦'], '常听的索引项要留着');
      assert.equal(fresh.calls, 0, '清理不该触发联网');
    } finally {
      agent.stop();
    }
  });
});

describe('stop() 之后', () => {
  test('推进时间再 tickOnce()：不读播放器、不写叶子', async () => {
    const clock = makeClock();
    const counter: FetchCounter = { calls: 0, urls: [] };
    let reads = 0;
    const { agent, calls } = makeAgent({
      cacheDir: makeCacheDir(),
      now: clock.now,
      readPlayer: async () => {
        reads++;
        return player(5_000);
      },
      fetchImpl: makeFetch(counter),
    });

    await agent.tickOnce();
    assert.equal(calls.length, 1);
    agent.stop();

    clock.advance(60_000);
    const changed = await agent.tickOnce();
    assert.equal(changed, false);
    assert.equal(reads, 1, '停了就不该再问播放器');
    assert.equal(calls.length, 1, '停了就不该再写叶子');
  });
});

describe('start() 幂等', () => {
  test('连调两次只挂一条 500ms tick + 一条清理定时器；stop 后不再排', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    const spy = ((_fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return { unref() {}, ref() {}, hasRef: () => false } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const clock = makeClock();
    const counter: FetchCounter = { calls: 0, urls: [] };
    let reads = 0;
    const { agent } = makeAgent({
      cacheDir: makeCacheDir(),
      now: clock.now,
      readPlayer: async () => {
        reads++;
        return player(5_000);
      },
      fetchImpl: makeFetch(counter),
    });

    // 等一个条件成立（内部用**真实** setTimeout 让出事件循环，绝不依赖被打了桩的那个）：
    // start() 里是「扫缓存 → 挂清理器 → 立刻校准」的异步链，文件 I/O 要几个事件循环才落地，
    // 固定 spin N 轮会偶发失败，所以按条件等，同时留一个上限防止死等。
    const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
      for (let i = 0; i < 500; i++) {
        if (predicate()) return;
        await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
      }
      assert.fail('等待超时：' + label);
    };

    try {
      globalThis.setTimeout = spy;
      agent.start();
      agent.start();
      // 一条 500ms 的 tick 循环 + 一条 12h 的清理定时器（配置默认值）
      await waitFor(() => delays.includes(500), '500ms tick 挂上');
      assert.equal(delays.filter((d) => d === 500).length, 1, '两次 start 只能有一条 tick');
      assert.equal(delays.filter((d) => d === 12 * 3600 * 1000).length, 1);
      assert.equal(reads, 1, 'start 后立刻校准一次');

      agent.stop();
      await new Promise<void>((resolve) => realSetTimeout(resolve, 20));
      assert.equal(delays.filter((d) => d === 500).length, 1, 'stop 后不再排下一拍');
    } finally {
      agent.stop();
      globalThis.setTimeout = realSetTimeout;
    }
  });
});
