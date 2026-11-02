/**
 * 模型网关实现层的守卫用例：**不联网**，全部用假 fetch。
 * 覆盖哥哥要的三件事：后端三选一、会话只有聊天能用、失败给人话。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createModelGateway, statusOf } from './create-model-gateway.ts';
import { compatChat, chatCompletionsUrl, mapHttpError, toDataUrl } from './adapters/openai-compat.ts';
import type { ChatDelta, ModelConfig } from './model-gateway.ts';

const CFG = (over: Partial<ModelConfig> = {}): ModelConfig => ({
  chat: { enabled: true, backend: { kind: 'remote', baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' } },
  vision: { enabled: true, backend: { kind: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'qwen-vl' } },
  tts: { enabled: false, backend: { kind: 'local', endpoint: 'http://127.0.0.1:9880' } },
  ...over,
});

/** 假 fetch：按调用次数给响应，并记下最后一次请求。 */
function fakeFetch(responses: Array<{ status: number; body: string }>): {
  impl: typeof fetch;
  last?: { url: string; init: RequestInit };
} {
  const holder: { impl: typeof fetch; last?: { url: string; init: RequestInit } } = {
    impl: (async (url: URL | string, init: RequestInit = {}) => {
      holder.last = { url: String(url), init };
      const item = responses.shift() ?? { status: 500, body: 'no more responses' };
      return new Response(item.body, { status: item.status });
    }) as unknown as typeof fetch,
  };
  return holder;
}

async function collect(stream: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

describe('chatCompletionsUrl（拼地址）', () => {
  test('普通 baseUrl 补 /chat/completions', () => {
    assert.equal(chatCompletionsUrl('https://api.x.test/v1'), 'https://api.x.test/v1/chat/completions');
  });

  test('结尾多余的斜杠被吃掉', () => {
    assert.equal(chatCompletionsUrl('http://127.0.0.1:1234/v1///'), 'http://127.0.0.1:1234/v1/chat/completions');
  });

  test('已经写全的不重复拼', () => {
    assert.equal(
      chatCompletionsUrl('https://api.x.test/v1/chat/completions'),
      'https://api.x.test/v1/chat/completions',
    );
  });
});

describe('mapHttpError（失败翻人话）', () => {
  test('401 → auth，提示 key 不被认可', () => {
    const e = mapHttpError(401, 'invalid api key');
    assert.equal(e.code, 'auth');
    assert.match(e.message, /key/);
  });

  test('404 → endpoint-down，提示可能要带 /v1', () => {
    const e = mapHttpError(404, 'not found');
    assert.equal(e.code, 'endpoint-down');
    assert.match(e.message, /v1/);
  });

  test('429 → endpoint-down，提示限流/没额度', () => {
    assert.match(mapHttpError(429, '').message, /限流|额度/);
  });

  test('5xx → endpoint-down；其它 → bad-response', () => {
    assert.equal(mapHttpError(503, '').code, 'endpoint-down');
    assert.equal(mapHttpError(418, '').code, 'bad-response');
  });
});

describe('toDataUrl', () => {
  test('包成 data URL 且字节不乱', () => {
    assert.equal(toDataUrl(new Uint8Array([1, 2, 3])), 'data:image/png;base64,AQID');
  });
});

describe('statusOf（设置页三张卡的红绿）', () => {
  test('配齐且会话在 → 全绿；tts 关着 → 红且说"关着"', () => {
    const status = statusOf(CFG(), true);
    assert.equal(status.chat?.ready, true);
    assert.equal(status.vision?.ready, true);
    assert.equal(status.tts?.ready, false);
    assert.match(status.tts?.reason?.message ?? '', /关/);
  });

  test('配了会话但没连上 → 红，提示去接 DSH', () => {
    const status = statusOf(CFG({ chat: { enabled: true, backend: { kind: 'session' } } }), false);
    assert.equal(status.chat?.ready, false);
    assert.match(status.chat?.reason?.message ?? '', /DSH/);
  });

  test('识图选会话 → 直接判不支持（只有聊天能走会话）', () => {
    const status = statusOf(CFG({ vision: { enabled: true, backend: { kind: 'session' } } }), true);
    assert.equal(status.vision?.ready, false);
    assert.match(status.vision?.reason?.message ?? '', /只有聊天/);
  });
});

describe('gateway.chat（真的调出去了）', () => {
  test('remote 后端：地址/模型/Authorization 都对，文本原样回', async () => {
    const fetchHolder = fakeFetch([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: '在的' } }] }) }]);
    const gateway = createModelGateway({ readConfig: () => CFG(), session: null, fetchImpl: fetchHolder.impl });
    const deltas = await collect(gateway.chat({ messages: [{ role: 'user', text: '在吗' }] }));
    assert.deepEqual(deltas, [{ type: 'text', text: '在的' }, { type: 'done' }]);
    assert.equal(fetchHolder.last?.url, 'https://x.test/v1/chat/completions');
    const headers = fetchHolder.last?.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer k');
    const body = JSON.parse(String(fetchHolder.last?.init.body)) as { model: string; messages: unknown[] };
    assert.equal(body.model, 'm');
    assert.equal(body.messages.length, 1);
  });

  test('local 后端走 endpoint 字段（不是 baseUrl）', async () => {
    const fetchHolder = fakeFetch([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: '嗯' } }] }) }]);
    const gateway = createModelGateway({
      readConfig: () => CFG({ chat: { enabled: true, backend: { kind: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'lm' } } }),
      session: null,
      fetchImpl: fetchHolder.impl,
    });
    await collect(gateway.chat({ messages: [{ role: 'user', text: '嗨' }] }));
    assert.equal(fetchHolder.last?.url, 'http://127.0.0.1:1234/v1/chat/completions');
    const headers = fetchHolder.last?.init.headers as Record<string, string>;
    assert.equal(headers.authorization, undefined);
  });

  test('session 后端交给注入的回调，不碰网络', async () => {
    const fetchHolder = fakeFetch([{ status: 500, body: '' }]);
    const gateway = createModelGateway({
      readConfig: () => CFG({ chat: { enabled: true, backend: { kind: 'session' } } }),
      session: { chat: async () => '走了会话' },
      fetchImpl: fetchHolder.impl,
    });
    const deltas = await collect(gateway.chat({ messages: [{ role: 'user', text: '在吗' }] }));
    assert.deepEqual(deltas, [{ type: 'text', text: '走了会话' }, { type: 'done' }]);
    assert.equal(fetchHolder.last, undefined);
  });

  test('key 不对 → 一个 error 帧（不抛），code=auth', async () => {
    const fetchHolder = fakeFetch([{ status: 401, body: 'bad key' }]);
    const gateway = createModelGateway({ readConfig: () => CFG(), session: null, fetchImpl: fetchHolder.impl });
    const deltas = await collect(gateway.chat({ messages: [{ role: 'user', text: '在吗' }] }));
    assert.equal(deltas.length, 1);
    const frame = deltas[0] as { type: 'error'; error: { code: string; message: string } };
    assert.equal(frame.type, 'error');
    assert.equal(frame.error.code, 'auth');
  });

  test('没配 key → not-configured，连 fetch 都不发', async () => {
    const fetchHolder = fakeFetch([{ status: 200, body: '{}' }]);
    const gateway = createModelGateway({
      readConfig: () => CFG({ chat: { enabled: true, backend: { kind: 'remote', baseUrl: 'https://x.test/v1', model: 'm' } } }),
      session: null,
      fetchImpl: fetchHolder.impl,
    });
    const deltas = await collect(gateway.chat({ messages: [{ role: 'user', text: '在吗' }] }));
    assert.equal((deltas[0] as { error: { code: string } }).error.code, 'not-configured');
    assert.equal(fetchHolder.last, undefined);
  });
});

describe('gateway.test / vision / speak', () => {
  test('test(chat) 成功 → ok 并回显模型的话', async () => {
    const fetchHolder = fakeFetch([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: '在的' } }] }) }]);
    const gateway = createModelGateway({ readConfig: () => CFG(), session: null, fetchImpl: fetchHolder.impl });
    const result = await gateway.test('chat');
    assert.equal(result.ok, true);
    assert.match(result.message, /在的/);
  });

  test('test(tts) 但功能关着 → ok:false 且是中文原因', async () => {
    const gateway = createModelGateway({ readConfig: () => CFG(), session: null });
    const result = await gateway.test('tts');
    assert.equal(result.ok, false);
    assert.match(result.message, /关/);
  });

  test('vision 走会话 → 明确拒绝（不静默换后端）', async () => {
    const gateway = createModelGateway({
      readConfig: () => CFG({ vision: { enabled: true, backend: { kind: 'session' } } }),
      session: { chat: async () => 'x' },
    });
    await assert.rejects(() => gateway.vision(new Uint8Array([1]), '看图'), /只有聊天/);
  });

  test('vision remote：把图片塞进 image_url', async () => {
    const fetchHolder = fakeFetch([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: '一只鱼' } }] }) }]);
    const gateway = createModelGateway({
      readConfig: () => CFG({ vision: { enabled: true, backend: { kind: 'remote', baseUrl: 'https://v.test/v1', model: 'vl', apiKey: 'vk' } } }),
      session: null,
      fetchImpl: fetchHolder.impl,
    });
    const text = await gateway.vision(new Uint8Array([1, 2]), '看图');
    assert.equal(text, '一只鱼');
    const body = JSON.parse(String(fetchHolder.last?.init.body)) as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const imagePart = body.messages[0]?.content.find((p) => p.type === 'image_url');
    assert.match(imagePart?.image_url?.url ?? '', /^data:image\/png;base64,/);
  });

  test('speak remote：命中 /audio/speech 并拿回字节', async () => {
    const audio = new Uint8Array([9, 9, 9]);
    const holder: { impl: typeof fetch; last?: string } = {
      impl: (async (url: URL | string) => {
        holder.last = String(url);
        return new Response(audio, { status: 200 });
      }) as unknown as typeof fetch,
    };
    const gateway = createModelGateway({
      readConfig: () => CFG({ tts: { enabled: true, backend: { kind: 'remote', baseUrl: 'https://s.test/v1', model: 'tts-1', apiKey: 'k' } } }),
      session: null,
      fetchImpl: holder.impl,
    });
    const bytes = await gateway.speak('在的');
    assert.deepEqual([...bytes], [9, 9, 9]);
    assert.equal(holder.last, 'https://s.test/v1/audio/speech');
  });
});

describe('compatChat 直调（超时/结构）', () => {
  test('HTTP 200 但不是 JSON → bad-response', async () => {
    const fetchImpl = (async () => new Response('<html>oops</html>', { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(
      () => compatChat({ baseUrl: 'https://x.test/v1', model: 'm' }, [{ role: 'user', content: '嗨' }], { fetchImpl }),
      /不是 JSON/,
    );
  });

  test('模型回空串 → bad-response（不当成功）', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }] }), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(
      () => compatChat({ baseUrl: 'https://x.test/v1', model: 'm' }, [{ role: 'user', content: '嗨' }], { fetchImpl }),
      /空字符串/,
    );
  });
});
