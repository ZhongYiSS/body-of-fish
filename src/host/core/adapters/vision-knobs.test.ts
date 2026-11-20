/**
 * 识图参数档位测试（0.6 第 3 步）。
 *
 * 背景：这个视觉端点默认把 token 花在「思考」上（同一张图 13.5 秒、652 reasoning token），
 * 关掉思考 1.7 秒就出答案。但参数不是所有端点都认，所以 compatVision 有三档兜底。
 * 这几条盯的是「不被认识的字段会不会自己降档」和「能过的档位会被记住」。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { compatVision, ModelCallError } from './openai-compat.ts';

function ok(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('端点认 thinking 字段：只打一次，请求里带了关闭思考', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return ok('1|关键点：他在写代码');
  }) as unknown as typeof fetch;

  const text = await compatVision(
    { baseUrl: 'https://k1.example/v1', model: 'm' },
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    '看图',
    { fetchImpl },
  );
  assert.equal(text, '1|关键点：他在写代码');
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0]?.thinking, { type: 'disabled' });
  assert.equal(bodies[0]?.reasoning_effort, 'none');
});

test('端点不认 thinking 字段（400）：自动降一档重试，第二次不带它', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    if (body.thinking !== undefined) {
      return new Response('{"error":{"message":"unknown field: thinking"}}', { status: 400 });
    }
    return ok('他正在调试');
  }) as unknown as typeof fetch;

  const text = await compatVision(
    { baseUrl: 'https://k2.example/v1', model: 'm' },
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    '看图',
    { fetchImpl },
  );
  assert.equal(text, '他正在调试');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]?.thinking !== undefined, true);
  assert.equal(bodies[1]?.thinking, undefined);
  assert.equal(bodies[1]?.reasoning_effort, 'none');
});

test('记住能过的那一档：第二次调用不再先撞 400', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    if (body.thinking !== undefined || body.reasoning_effort !== undefined) {
      return new Response('{"error":"bad field"}', { status: 400 });
    }
    return ok('降到底档了');
  }) as unknown as typeof fetch;

  const backend = { baseUrl: 'https://k3.example/v1', model: 'm' };
  const first = await compatVision(backend, new Uint8Array([0xff, 0xd8, 0xff]), '看图', { fetchImpl });
  const afterFirst = bodies.length;
  const second = await compatVision(backend, new Uint8Array([0xff, 0xd8, 0xff]), '看图', { fetchImpl });
  assert.equal(first, '降到底档了');
  assert.equal(second, '降到底档了');
  // 第一次三档全撞：thinking+none、none、{}
  assert.equal(afterFirst, 3);
  // 第二次直接从第三档开始，只打一次
  assert.equal(bodies.length, afterFirst + 1);
  assert.equal(bodies.at(-1)?.thinking, undefined);
  assert.equal(bodies.at(-1)?.reasoning_effort, undefined);
});

test('空正文不换档，直接报 bad-response（换了只会更慢）', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return ok('');
  }) as unknown as typeof fetch;

  await assert.rejects(
    compatVision({ baseUrl: 'https://k4.example/v1', model: 'm' }, new Uint8Array([0xff, 0xd8, 0xff]), '看图', {
      fetchImpl,
    }),
    (error: unknown) => error instanceof ModelCallError && error.code === 'bad-response',
  );
  assert.equal(bodies.length, 1);
});

test('网络断了不换档：只打一次就把错抛出去', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new Error('ECONNRESET');
  }) as unknown as typeof fetch;

  await assert.rejects(
    compatVision({ baseUrl: 'https://k5.example/v1', model: 'm' }, new Uint8Array([0xff, 0xd8, 0xff]), '看图', {
      fetchImpl,
    }),
    (error: unknown) => error instanceof ModelCallError && error.code === 'endpoint-down',
  );
  assert.equal(calls, 1);
});