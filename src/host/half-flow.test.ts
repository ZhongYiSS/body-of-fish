/**
 * 半流式（低风险版）的回归测试：
 * ① say-split 的取句口（takeReadySentences）——边收边报时哪些句子算定型；
 * ② chat.ts 的网关流式生成真的会报句（用假网关逐块喂字）；
 * ③ 宿主侧的提前合成池接在哪儿（结构断言，防以后被改成"白合成"）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { takeReadySentences } from './say-split.ts';
import { generateChatViaGateway } from './chat.ts';

const INDEX = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

describe('takeReadySentences —— 流式攒句', () => {
  test('半句不算：末段还会继续长，final 之前只给确定下来的句子', () => {
    assert.deepEqual(takeReadySentences('本鱼在呢。哥哥', 0, false), ['本鱼在呢。']);
    // 一个字都没说完之前，一句都不给
    assert.deepEqual(takeReadySentences('本鱼在', 0, false), []);
  });

  test('流结束了就全给（末段算定型）', () => {
    assert.deepEqual(takeReadySentences('本鱼在呢。哥哥忙吗', 1, true), ['哥哥忙吗']);
  });

  test('emitted 往前走就不会重复报（句句只报一次）', () => {
    const all = takeReadySentences('本鱼在呢。哥哥忙吗？好。', 0, true);
    assert.deepEqual(all, ['本鱼在呢。', '哥哥忙吗？', '好。']);
    assert.deepEqual(takeReadySentences('本鱼在呢。哥哥忙吗？好。', all.length, true), []);
  });

  test('语气词并句会让边界后移：宁可不报，也不推一个会变的句子出去', () => {
    // 「嗯。」是语气词，会被并进下一句；这时一句都不算定型 —— 比她早报一句强
    assert.deepEqual(takeReadySentences('嗯。让我看看。', 0, false), []);
    assert.deepEqual(takeReadySentences('嗯。让我看看。', 0, true), ['嗯。让我看看。']);
  });
});

describe('generateChatViaGateway —— 边收边报句', () => {
  const frames = ['咕噜…', '卡了快五分钟啦，', '喝口水歇歇？', '[图:可爱]'];

  const fakeGateway = (chunks: string[]) => ({
    chat: async function* () {
      for (const chunk of chunks) yield { type: 'text', text: chunk };
    },
  });

  test('第一句在流还没结束时就报出去（这就是省时间的地方）', async () => {
    const chunks = ['本鱼在呢。', '哥哥忙吗？', '要不要喝口水？'];
    let fed = 0;
    const seen: Array<{ line: string; fedAt: number }> = [];
    const gateway = {
      chat: async function* () {
        for (const chunk of chunks) {
          fed += 1;
          yield { type: 'text', text: chunk };
        }
      },
    };
    const r = await generateChatViaGateway(gateway as never, '人设', [], '在吗', [], 5_000, undefined, (line) => {
      seen.push({ line, fedAt: fed });
    });
    assert.equal(r.ok, true);
    assert.deepEqual(seen.map((s) => s.line), ['本鱼在呢。', '哥哥忙吗？', '要不要喝口水？']);
    // 用户要的那个「省时间」：首句在第三块到达之前就已经报出去了
    assert.ok(seen[0]!.fedAt < chunks.length, `首句应该早于流结束，实际 fedAt=${seen[0]!.fedAt}`);
  });

  test('配图标记不当话报（不然嗓子会念一句空气）', async () => {
    const chunks = ['本鱼在呢。', '哥哥忙吗？', '[图:可爱]'];
    const seen: string[] = [];
    const gateway = {
      chat: async function* () {
        for (const chunk of chunks) yield { type: 'text', text: chunk };
      },
    };
    await generateChatViaGateway(gateway as never, '人设', [], '在吗', [], 5_000, undefined, (line) => {
      seen.push(line);
    });
    assert.ok(!seen.some((line) => line.includes('[图:')), `不该报配图标记，实际 ${JSON.stringify(seen)}`);
  });

  test('不传 onSentence 就一句话都不报（老路径零影响）', async () => {
    const r = await generateChatViaGateway(fakeGateway(frames) as never, '人设', [], '在吗', [], 5_000);
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.text.includes('喝口水歇歇'));
  });

  test('回调自己抛错也不许影响正文', async () => {
    const r = await generateChatViaGateway(fakeGateway(frames) as never, '人设', [], '在吗', [], 5_000, undefined, () => {
      throw new Error('预热炸了');
    });
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.text.includes('咕噜'));
  });
});

describe('宿主的提前合成池 —— 接线不能白合成', () => {
  test('对话那条网关生成会把每句丢进 warmSynth', () => {
    assert.ok(INDEX.includes('mine.signal, warmFirstSentence)'));
  });

  test('播放侧只对首句取池子，后面的句子串在它后面（不然两句同时合成又堵嗓子）', () => {
    assert.ok(INDEX.includes('const warm = i === 0 ? takeWarmSynth(line) : undefined;'));
    assert.ok(INDEX.includes('const task = warm ?? synthChain.then(() => synthLine(line));'));
  });

  test('嗓子没接上就不预热；池子 60 秒过期', () => {
    assert.ok(INDEX.includes("if (!servicesProvider('main').voice.available().ready) return;"));
    assert.ok(INDEX.includes('const SYNTH_WARM_TTL_MS = 60_000;'));
  });
});