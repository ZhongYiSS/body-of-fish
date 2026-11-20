/**
 * 「他这会儿」三行（窗口时间线 / 离开多久 / 窗口形状）——纯函数测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIMELINE_MAX,
  clock,
  contextLine,
  idleLine,
  pushTimeline,
  readLiveContext,
  shapeLine,
  timelineLine,
} from './screen-context.ts';

const t = (h: number, m: number): number => new Date(2026, 10, 19, h, m, 0).getTime();

test('时间线：同名不重复记，超过上限丢最老', () => {
  let list = pushTimeline([], { at: t(14, 2), label: '写文档' });
  list = pushTimeline(list, { at: t(14, 3), label: '写文档' });
  assert.equal(list.length, 1);
  list = pushTimeline(list, { at: t(14, 5), label: '看视频' });
  assert.equal(list.length, 2);
  for (let i = 0; i < 10; i += 1) list = pushTimeline(list, { at: t(15, i), label: `窗口${i}` });
  assert.equal(list.length, TIMELINE_MAX);
  assert.equal(list[list.length - 1]?.label, '窗口9');
});

test('时间线：空名字不记', () => {
  assert.deepEqual(pushTimeline([], { at: t(14, 0), label: '  ' }), []);
});

test('时间线：只留 30 分钟内，最多 4 段', () => {
  const now = t(16, 0);
  const list = [
    { at: t(14, 0), label: '很早' },
    { at: t(15, 40), label: '写文档' },
    { at: t(15, 45), label: '看视频' },
    { at: t(15, 50), label: '写代码' },
    { at: t(15, 55), label: '看网页' },
    { at: t(15, 58), label: '聊天' },
  ];
  const line = timelineLine(list, now);
  assert.ok(!line.includes('很早'));
  assert.ok(line.includes('15:45 看视频'));
  assert.equal(line.split('→').length, 4);
  assert.equal(timelineLine([], now), '');
});

test('离开多久：没读到就不写，超过一分钟报分钟数', () => {
  assert.equal(idleLine(-1), '');
  assert.equal(idleLine(Number.NaN), '');
  assert.equal(idleLine(5_000), '刚碰过键盘');
  assert.equal(idleLine(3 * 60_000), '3 分钟没动键盘');
});

test('窗口形状：铺满整屏 vs 普通窗口', () => {
  const screen = { w: 2560, h: 1600 };
  assert.match(shapeLine({ w: 2560, h: 1600 }, screen), /^铺满整屏/u);
  assert.match(shapeLine({ w: 1280, h: 800 }, screen), /^窗口 1280×800/u);
  assert.equal(shapeLine(null, screen), '');
  assert.equal(shapeLine({ w: 0, h: 0 }, screen), '');
});

test('拼成一行：三段用竖线连，缺的跳过', () => {
  const line = contextLine({
    timeline: [{ at: t(15, 40), label: '写文档' }],
    idleMs: 2 * 60_000,
    rect: { w: 1280, h: 800 },
    screen: { w: 2560, h: 1600 },
    now: t(15, 45),
  });
  assert.equal(line, '15:40 写文档｜2 分钟没动键盘｜窗口 1280×800，屏幕 2560×1600');
  assert.equal(contextLine({ timeline: [], idleMs: -1, rect: null, screen: null, now: t(15, 45) }), '');
});

test('钟点：两位补零', () => {
  assert.equal(clock(t(9, 5)), '09:05');
});

test('公共环境块：洗标题、记时间线、带上空闲与形状', async () => {
  const list: { at: number; label: string }[] = [];
  const got = await readLiveContext({
    readForeground: async () => ({
      title: 'main.ts - 身体 - Visual Studio Code',
      idleMs: 135_000,
      rect: { w: 1941, h: 1243 },
      screen: { w: 2560, h: 1600 },
    }),
    remember: (label, at) => list.push({ at, label }),
    timeline: () => list,
    tidy: (title) => title.replace(/ - Visual Studio Code$/u, ''),
    now: t(16, 0),
  });
  assert.deepEqual(list, [{ at: t(16, 0), label: 'main.ts - 身体' }]);
  assert.equal(got.title, 'main.ts - 身体');
  assert.equal(got.idleMs, 135_000);
  assert.match(got.line, /16:00 main.ts - 身体/u);
  assert.match(got.line, /2 分钟没动键盘/u);
  assert.match(got.line, /窗口 1941×1243/u);
});

test('公共环境块：读前台失败 → 空串，不抛', async () => {
  const got = await readLiveContext({
    readForeground: async () => {
      throw new Error('powershell 挂了');
    },
    remember: () => undefined,
    timeline: () => [],
  });
  assert.deepEqual(got, { line: '', idleMs: -1, title: '' });
});

test('公共环境块：没读到标题也照样给空闲与形状', async () => {
  const got = await readLiveContext({
    readForeground: async () => ({ title: '   ', idleMs: 5_000, rect: null, screen: null }),
    remember: () => {
      throw new Error('空标题不该记时间线');
    },
    timeline: () => [],
    now: t(16, 0),
  });
  assert.equal(got.title, '');
  assert.equal(got.line, '刚碰过键盘');
});
