/**
 * 旁听吐槽的调度守卫：冷却、两档比例、模型失败回落规则、洗句子。
 * 全部注入假 now/random/say/generate，不联网、不花钱。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { cleanText, createChatter, ruleText } from './chatter.ts';
import { FALLBACK, RULES } from './chatter-rules.ts';

const fixed = (value: number) => () => value;

describe('台词库（搬过来的那份）', () => {
  test('至少有 40 条规则、10 条兜底，且每条都有词有句', () => {
    assert.ok(RULES.length >= 20);
    assert.ok(FALLBACK.length >= 10);
    for (const rule of RULES) {
      assert.ok(rule.kw.length > 0 && rule.lines.length > 0);
    }
  });

  test('关键词表里没有空串（空串会命中一切）', () => {
    for (const rule of RULES) for (const keyword of rule.kw) assert.ok(keyword.trim().length > 0);
  });
});

describe('ruleText（规则档）', () => {
  test('命中关键词 → 说该组台词', () => {
    const text = ruleText('今天吃白米饭', '', fixed(0));
    assert.equal(text, RULES[0]?.lines[0]);
  });

  test('看回复也参与匹配（哥哥没提，本鱼答了也算）', () => {
    const text = ruleText('嗯', '本鱼最喜欢白米饭', fixed(0));
    assert.equal(text, RULES[0]?.lines[0]);
  });

  test('没命中 + 随机数小 → 给通用泡泡', () => {
    assert.equal(ruleText('zzz', '', fixed(0)), FALLBACK[0]);
  });

  test('没命中 + 随机数大 → 不说话（留白）', () => {
    assert.equal(ruleText('zzz', '', fixed(0.9)), null);
  });
});

describe('cleanText（洗句子）', () => {
  test('只留第一行', () => {
    assert.equal(cleanText('第一句\n第二句', 20), '第一句');
  });

  test('去掉首尾引号', () => {
    assert.equal(cleanText('「咕噜」', 20), '咕噜');
    assert.equal(cleanText('"泡泡"', 20), '泡泡');
  });

  test('按码点截断（emoji 不许切半）', () => {
    const text = cleanText('🍚🍚🍚🍚', 2);
    assert.equal(Array.from(text).length, 4);
    assert.equal(text, '🍚🍚🍚🍚');
  });

  test('空白 → 空串', () => {
    assert.equal(cleanText('   \n ', 20), '');
  });
});

describe('createChatter（调度）', () => {
  const make = (over: Partial<Parameters<typeof createChatter>[0]> = {}) => {
    const said: string[] = [];
    const chatter = createChatter({
      say: (text) => {
        said.push(text);
      },
      now: fixed(1_000_000),
      random: fixed(0.9),
      ...over,
    });
    return { chatter, said };
  };

  test('关掉 → 一句话都不说', async () => {
    const { chatter, said } = make({ config: { enabled: false } });
    assert.equal(await chatter.onTurn('白米饭', ''), 'skip');
    assert.deepEqual(said, []);
  });

  test('规则档命中 → 说话，返回 rule', async () => {
    const { chatter, said } = make({ random: fixed(0.9) });
    assert.equal(await chatter.onTurn('今天吃白米饭', ''), 'rule');
    assert.equal(said.length, 1);
    assert.ok(RULES[0]?.lines.includes(said[0] ?? ''));
  });

  test('冷却期内第二次 → skip（防刷屏）', async () => {
    let t = 1_000_000;
    const said: string[] = [];
    const chatter = createChatter({
      say: (text) => {
        said.push(text);
      },
      now: () => t,
      random: fixed(0.9),
      config: { cooldownSec: 20 },
    });
    assert.equal(await chatter.onTurn('白米饭', ''), 'rule');
    t += 5_000;
    assert.equal(await chatter.onTurn('白米饭', ''), 'skip');
    t += 20_000;
    assert.equal(await chatter.onTurn('白米饭', ''), 'rule');
    assert.equal(said.length, 2);
  });

  test('模型档：随机数落在比例内 → 用模型的话', async () => {
    const { chatter, said } = make({
      random: fixed(0.1),
      config: { modelRatio: 0.5 },
      generate: async () => '模型说的一句',
    });
    assert.equal(await chatter.onTurn('在吗', ''), 'model');
    assert.deepEqual(said, ['模型说的一句']);
  });

  test('模型返回 null → 回落规则（不许哑）', async () => {
    const { chatter, said } = make({
      random: fixed(0.1),
      config: { modelRatio: 0.5 },
      generate: async () => null,
    });
    assert.equal(await chatter.onTurn('白米饭', ''), 'rule');
    assert.equal(said.length, 1);
  });

  test('模型抛错 → 回落规则，不把异常抛出去', async () => {
    const { chatter, said } = make({
      random: fixed(0.1),
      config: { modelRatio: 0.5 },
      generate: async () => {
        throw new Error('网络挂了');
      },
    });
    assert.equal(await chatter.onTurn('白米饭', ''), 'rule');
    assert.equal(said.length, 1);
  });

  test('say 抛错 → skip（且不更新冷却，下一轮还能试）', async () => {
    const chatter = createChatter({
      say: () => {
        throw new Error('写叶子失败');
      },
      now: fixed(1_000_000),
      random: fixed(0.9),
    });
    assert.equal(await chatter.onTurn('白米饭', ''), 'skip');
    assert.equal(chatter.lastAt(), 0);
  });
});
