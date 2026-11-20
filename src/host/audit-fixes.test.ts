/**
 * 0.6 体检修复的回归测试（哥哥 11-20「理清思路看看有没有 bug」）。
 *
 * 钉的是三件事：
 *   ① 配置里存的「出厂默认」副本不能再盖住代码默认（否则改提示词永远不生效）；
 *   ② 陪伴截图的默认宽度不能低于清晰度门槛（≥1280），老配置里的 1008/1280 当没设过；
 *   ③ 笔记不再带「关键点：」前缀。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DETAIL_PROMPT, DEFAULT_WATCH_PROMPT, parseWatchReply } from './game-talk.ts';
import {
  DETAIL_STOCK,
  LEGACY_DETAIL_PROMPT,
  LEGACY_WATCH_PROMPT,
  WATCH_STOCK,
  freshTemplate,
  normalizeTemplate,
} from './legacy-prompts.ts';
import { DEFAULT_TUNING, STILL_H, STILL_W, normalizeTuning } from './watch-mode.ts';
import { splitSentences } from './say-split.ts';

test('出厂默认（含历史版本）一律当没设过：配置里那份副本不能再盖住代码默认', () => {
  assert.equal(freshTemplate(DEFAULT_WATCH_PROMPT, WATCH_STOCK), '');
  assert.equal(freshTemplate(LEGACY_WATCH_PROMPT, WATCH_STOCK), '');
  assert.equal(freshTemplate(DEFAULT_DETAIL_PROMPT, DETAIL_STOCK), '');
  assert.equal(freshTemplate(LEGACY_DETAIL_PROMPT, DETAIL_STOCK), '');
  // 空白差异不该影响判断（配置经过 JSON 读写，换行缩进可能变过）
  assert.equal(freshTemplate(`  ${LEGACY_WATCH_PROMPT.replace(/\n/g, '\n  ')}\n`, WATCH_STOCK), '');
});

test('用户真改过的模板要照原样保留，空串还是空串', () => {
  const mine = '{{persona}}\n只回一行：3|要说的话：…';
  assert.equal(freshTemplate(mine, WATCH_STOCK), mine);
  assert.equal(freshTemplate('', WATCH_STOCK), '');
  assert.equal(freshTemplate(undefined, WATCH_STOCK), '');
  assert.equal(freshTemplate('   \n ', WATCH_STOCK), '');
});

test('历史模板确实缺 {{window}} / {{context}} —— 这是它必须被忽略的证据', () => {
  assert.ok(!LEGACY_WATCH_PROMPT.includes('{{window}}'));
  assert.ok(!LEGACY_WATCH_PROMPT.includes('{{context}}'));
  assert.ok(DEFAULT_WATCH_PROMPT.includes('{{window}}'));
  assert.ok(DEFAULT_WATCH_PROMPT.includes('{{context}}'));
  assert.equal(normalizeTemplate('  a\n b  '), 'a b');
});

test('陪伴截图默认宽度不低于清晰度门槛 1280', () => {
  assert.equal(STILL_W, 1536);
  assert.equal(STILL_H, 960);
  assert.ok(DEFAULT_TUNING.stillWidth >= 1280, '默认宽度必须 ≥1280');
});

test('老配置里的历史默认尺寸（1008×630 / 1280×800）当没设过', () => {
  assert.equal(normalizeTuning({ stillWidth: 1008, stillHeight: 630 }).stillWidth, STILL_W);
  assert.equal(normalizeTuning({ stillWidth: 1280, stillHeight: 800 }).stillWidth, STILL_W);
  // 用户自己设过的值要留着
  assert.equal(normalizeTuning({ stillWidth: 1600, stillHeight: 1000 }).stillWidth, 1600);
  // 只给一半不算「成对」，按原值处理
  assert.equal(normalizeTuning({ stillWidth: 1280 }).stillWidth, 1280);
});

test('笔记不再带「关键点：」前缀，60 字上限也不被标签吃掉', () => {
  const reply = parseWatchReply(['3|要说的话：-', '1|关键点：在读一份 bug 报告', '2|重要性：2'].join('\n'));
  assert.equal(reply.note, '在读一份 bug 报告');
  assert.equal(reply.imp, 2);
  assert.equal(parseWatchReply('1|在读文档\n2|重要性：1').note, '在读文档');
});
test('语气词短句并进下一句：一句 3 字气泡闪一下的问题从拆分这层解决', () => {
  assert.deepEqual(splitSentences('咕噜…卡了快五分钟啦，喝口水歇歇？'), ['咕噜…卡了快五分钟啦，喝口水歇歇？']);
  assert.deepEqual(splitSentences('嗯。让我看看。'), ['嗯。让我看看。']);
  // 整段只有一个语气词：保持原样，不要吐空数组
  assert.deepEqual(splitSentences('咕噜…'), ['咕噜…']);
  // 真的两句话不能被并掉
  assert.deepEqual(splitSentences('这图挺好看。你画的？'), ['这图挺好看。', '你画的？']);
});
