/**
 * 【汐儿 · 11-20 m33631】「哪个场景发哪层提示词」的契约测试。
 *
 * 哥哥的原话：「记得把陪伴提示词和人格提示词什么时候发分清楚，避免该带上提示词的时候没带上」。
 * 所以这里守两张表，谁改坏了当场红：
 *
 * ① 分层表现在长这样（L 层见 `D:/AI/身体/文档/大改计划-0.6.md` §第 6 步前置）
 *    | 场景        | 人设 | 规矩 STYLE_RULES | 卷/记忆 | 为什么开口 | 屏幕上下文 | 场景模板 |
 *    | 聊天 chat   | ✓   | ✓                | ✓      | ✓(chat)   | ✓         | 自由对话 |
 *    | 陪伴 watch  | ✓   | ✓(模板 {{style}})| ✓      | ✓(watch)  | ✓         | DEFAULT_WATCH_PROMPT |
 *    | 一眼看 look | ✓   | ✓                | ✓      | ✓(look)   | ✓         | companionLookPrompt |
 *    | 说一句 say  | ✓   | ✓                | ✓(最近 12 条+卡片) | ✓(say) | ✓   | sayOncePrompt |
 *    | 回看细节    | ✗   | ✗                | ✗      | ✗         | 窗口名    | DEFAULT_DETAIL_PROMPT |
 *    | 碎碎念      | ✗   | ✗                | ✗      | ✗         | ✗         | 池子写死，不叫模型 |
 *    | 摘要器      | ✗   | ✗                | 原文   | ✗         | ✗         | 压缩用 |
 *
 * ② 「刚聊过」不许再是整卷（整卷 3,443 字会把 529 字的人设挤成零头，她照着旧话复读）。
 *
 * 只读源码做结构断言——先后/包含关系靠行为测试抓不稳，成本也高。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { idleText, reasonBlock } from './pipeline/reason.ts';
import { DEFAULT_WATCH_PROMPT } from './game-talk.ts';
import { MEMORY_USAGE_RULES, SAY_MAX_CHARS } from './pipeline/style.ts';

const code = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8').split('\r\n').join('\n');

test('缘由块：四个场景各有各的说法，都带三行', () => {
  const kinds = ['chat', 'watch', 'look', 'say'] as const;
  const whys = new Set<string>();
  for (const kind of kinds) {
    const block = reasonBlock({ kind, idleMs: 0 });
    assert.ok(block.includes('【这轮为什么开口】'), kind + ' 缺「为什么开口」');
    assert.ok(block.includes('【他在不在听】'), kind + ' 缺「他在不在听」');
    assert.ok(block.includes('【怎么开口】'), kind + ' 缺「怎么开口」');
    whys.add(block.split('\n')[0]);
  }
  assert.equal(whys.size, 4, '四种缘由要说得不一样（别四合一）');
});

test('空闲时长说人话；读不到前台不许当成「他不在」', () => {
  assert.equal(idleText(-1), '不知道他人在不在');
  assert.equal(idleText(undefined), '不知道他人在不在');
  assert.equal(idleText(12_000), '刚碰过键盘');
  assert.equal(idleText(12 * 60_000), '键盘停了 12 分钟');
  assert.equal(idleText(3 * 60 * 60_000), '键盘停了 3 小时');
});

test('四个开口场景都拼了缘由块，且各自一种', () => {
  for (const kind of ['chat', 'watch', 'look', 'say']) {
    const hits = code.split("reasonBlock({ kind: '" + kind + "'").length - 1;
    assert.equal(hits, 1, kind + ' 的缘由块命中 ' + hits + ' 次，应为 1');
  }
});

test('四个开口场景都带人设（petSystemPrompt），一处都不许漏', () => {
  const hits = code.split('petSystemPrompt(').length - 1;
  // 出错信息里点出表：漏了哪个场景就去对照 reasonBlock 的四次调用
  assert.ok(hits >= 4, 'petSystemPrompt 只出现 ' + hits + ' 次：聊天/陪伴/一眼看/说一句各要一次');
});

test('【刚聊过】按条数截，不再整卷', () => {
  assert.ok(/const RECENT_TURNS = \d+;/u.test(code), '没有 RECENT_TURNS');
  const n = Number(/const RECENT_TURNS = (\d+);/u.exec(code)?.[1] ?? '0');
  assert.ok(n >= 6 && n <= 20, 'RECENT_TURNS=' + n + ' 不在 6~20 之间');
  assert.ok(code.includes('sessionStore.context(RECENT_TURNS)'), 'memoryBlockFor 没按条数截');
  assert.ok(!code.includes('sessionStore.context(), loadCards()'), '还有整卷调用');
});

test('字数规矩只有一个数：陪伴模板跟 SAY_MAX_CHARS 一致', () => {
  assert.equal(SAY_MAX_CHARS, 20);
  assert.ok(DEFAULT_WATCH_PROMPT.includes('≤' + SAY_MAX_CHARS + ' 字'), '陪伴模板的字数跟 SAY_MAX_CHARS 不一致');
  assert.ok(!DEFAULT_WATCH_PROMPT.includes('≤30 字'), '陪伴模板还写着 30 字');
});

test('回看细节与摘要器不带人设（直答/压缩不该有人格）', () => {
  const detail = code.slice(code.indexOf('function buildDetailPrompt'), code.indexOf('function buildDetailPrompt') + 400);
  assert.ok(!detail.includes('petSystemPrompt'), '回看细节不该拼人设');
});

test('记忆怎么用：三条规矩一句话都不许少，而且真的拼进了记忆块', () => {
  const text = MEMORY_USAGE_RULES;
  // 三种毛病：把背景当他刚说的、硬提旧事、记不清还编
  assert.ok(text.includes('不是他刚说的话'), '少了「背景≠他刚说的」');
  assert.ok(text.includes('用得上就提一句'), '少了「相关才提一句」');
  assert.ok(text.includes('记不清就别编'), '少了「记不清别编」');
  assert.ok(MEMORY_USAGE_RULES.split('\n').length >= 4, '三条要分行，别挤成一团');
  // 记忆块第一行必须是它（以前的「（下面是背景…）」单句被它取代了）
  assert.ok(code.includes('lines.push(MEMORY_USAGE_RULES)'), 'memoryBlockFor 没拼记忆用法');
  assert.ok(!code.includes('（下面是背景，不是他现在说的话；知道就行，别照念。）'), '旧的那句还留着');
});

test('说一句：带记忆块，但不和 sayOncePrompt 重复喂卷', () => {
  const start = code.indexOf('const sayOnceText');
  const end = code.indexOf('const speakOnce');
  assert.ok(start > 0 && end > start, '找不到 sayOnceText 区段');
  const region = code.slice(start, end);
  // ① 记忆块必须在（摘要 / 最近 12 条 / 想说没说 / 记着的事 / 记忆怎么用）
  assert.ok(region.includes("memoryBlockFor('说一句')"), '说一句没拼记忆块');
  // ② 卷只能喂一次：sayOncePrompt 不再拿摘要和最近几句（否则 system 和 prompt 各一份，模型当成两件事）
  assert.ok(region.includes("sayOncePrompt({ nowMs, summary: '', recent: [], recentSaid: recentSays })"), 'sayOncePrompt 还在喂卷，会和记忆块重复');
  // ③ 人设、规矩、缘由、这轮为什么开口 一样不许少
  assert.ok(region.includes('petSystemPrompt(found)'), '说一句漏了人设');
  assert.ok(region.includes('STYLE_RULES'), '说一句漏了说话规矩');
  assert.ok(region.includes("reasonBlock({ kind: 'say'"), '说一句漏了缘由块');
  assert.ok(region.includes('contextBlock(live.line)'), '说一句漏了「他这会儿」');
});

test('请求头只挂在 gatewayFor 上，且只在 baseUrl 对得上时才带', () => {
  // 自带模型这条路必须走 gatewayFor（extraHeaders 在它里面挂）
  assert.ok(code.includes('generateChatViaGateway(gatewayFor(found.conf)'), '自带模型没走 gatewayFor，请求头会丢');
  const start = code.indexOf('const backendHeaders');
  const region = code.slice(start, start + 600);
  assert.ok(region.includes('if (norm(baseUrl) !== norm(conn.baseUrl)) return undefined;'), 'backendHeaders 没按 baseUrl 兜住，附件头会漏给别家');
});
