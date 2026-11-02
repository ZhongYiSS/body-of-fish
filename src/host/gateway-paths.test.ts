/**
 * 网关两条生成路径（碎碎念 / 对话）的守卫用例：**不联网、不碰 dsh-llm**。
 * 盯的是"换后端不换风格"：提示词拼装、配图解析、失败结构化。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { generateChatViaGateway } from './chat.ts';
import { generateWhisperViaGateway } from './whisper.ts';

type Frame = { type: string; text?: string; error?: { message: string } };

interface Capture {
  messages: Array<{ role: string; text: string }>;
}

/** 假网关：按给定帧序列产出，并记下收到的消息。 */
function fakeGateway(frames: Frame[]): { gateway: never; captured: Capture[] } {
  const captured: Capture[] = [];
  const gateway = {
    chat(request: { messages: Array<{ role: string; text: string }> }) {
      captured.push({ messages: request.messages });
      return (async function* () {
        for (const frame of frames) yield frame;
      })();
    },
  } as never;
  return { gateway, captured };
}

describe('generateWhisperViaGateway', () => {
  test('几帧文本拼成一句，带图时把图名原样带回', async () => {
    const { gateway, captured } = fakeGateway([{ type: 'text', text: '今天' }, { type: 'text', text: '想晒太阳' }, { type: 'done' }]);
    const result = await generateWhisperViaGateway(gateway, '人设', { name: '可爱', desc: '卖萌' });
    assert.deepEqual(result, { ok: true, text: '今天想晒太阳', image: '可爱' });
    assert.equal(captured[0]?.messages[0]?.role, 'system');
    assert.match(captured[0]?.messages[1]?.text ?? '', /可爱/);
  });

  test('没配图时指令里不出现「配一张表情包」', async () => {
    const { gateway, captured } = fakeGateway([{ type: 'text', text: '嗯' }, { type: 'done' }]);
    const result = await generateWhisperViaGateway(gateway, '人设', undefined);
    assert.deepEqual(result, { ok: true, text: '嗯' });
    assert.doesNotMatch(captured[0]?.messages[1]?.text ?? '', /表情包/);
  });

  test('error 帧 → 结构化失败，不抛', async () => {
    const { gateway } = fakeGateway([{ type: 'error', error: { message: 'key 不对' } }]);
    const result = await generateWhisperViaGateway(gateway, '人设', undefined);
    assert.equal(result.ok, false);
    assert.match((result as { message?: string }).message ?? '', /key 不对/);
  });

  test('只有空帧 → 失败（空话不当成功）', async () => {
    const { gateway } = fakeGateway([{ type: 'done' }]);
    const result = await generateWhisperViaGateway(gateway, '人设', undefined);
    assert.equal(result.ok, false);
    assert.match((result as { message?: string }).message ?? '', /空话/);
  });
});

describe('generateChatViaGateway', () => {
  test('system + 当天历史 + 用户话都进 messages，顺序不乱', async () => {
    const { gateway, captured } = fakeGateway([{ type: 'text', text: '在的' }, { type: 'done' }]);
    const history = [
      { role: 'user' as const, content: '早', ts: 1 },
      { role: 'assistant' as const, content: '早呀', ts: 2 },
    ];
    const result = await generateChatViaGateway(gateway, '人设', history, '在吗');
    assert.deepEqual(result, { ok: true, text: '在的' });
    const messages = captured[0]?.messages ?? [];
    assert.deepEqual(
      messages.map((m) => m.role),
      ['system', 'user', 'assistant', 'user'],
    );
    assert.equal(messages.at(-1)?.text, '在吗');
  });

  test('带池时会把 [图:名称] 标记剥离并采纳池内图', async () => {
    const { gateway } = fakeGateway([{ type: 'text', text: '好呀\n[图:可爱]' }, { type: 'done' }]);
    const result = await generateChatViaGateway(gateway, '人设', [], '在吗', [
      { name: '可爱', desc: '卖萌' } as never,
    ]);
    assert.deepEqual(result, { ok: true, text: '好呀', image: '可爱' });
  });

  test('池外名称（模型幻觉）→ 标记剥离但不配图', async () => {
    const { gateway } = fakeGateway([{ type: 'text', text: '好呀\n[图:不存在的]' }, { type: 'done' }]);
    const result = await generateChatViaGateway(gateway, '人设', [], '在吗', [{ name: '可爱', desc: '卖萌' } as never]);
    assert.equal(result.ok, true);
    assert.equal((result as { image?: string }).image, undefined);
  });

  test('error 帧 → 结构化失败', async () => {
    const { gateway } = fakeGateway([{ type: 'error', error: { message: '连不上 127.0.0.1' } }]);
    const result = await generateChatViaGateway(gateway, '人设', [], '在吗');
    assert.equal(result.ok, false);
    assert.match((result as { message?: string }).message ?? '', /连不上/);
  });
});
