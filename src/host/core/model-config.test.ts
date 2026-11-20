/**
 * `model` 段解析/回写的守卫用例：手写坏的配置不许把功能弄崩，只许"按默认"或"明确红"。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fillRemoteBackends, parseCapability, parseModelConfig, toConfigSection } from './model-config.ts';

describe('parseModelConfig（默认值）', () => {
  test('整段缺失 → 聊天开且走会话，识图/声音关且本地', () => {
    const config = parseModelConfig(undefined);
    assert.deepEqual(config.chat, { enabled: true, backend: { kind: 'session' } });
    assert.equal(config.vision.enabled, false);
    assert.deepEqual(config.vision.backend, { kind: 'local', endpoint: '' });
    assert.equal(config.tts.enabled, false);
  });

  test('手写不是对象（"关掉"这种）→ 仍按默认，不抛', () => {
    const config = parseModelConfig('关掉');
    assert.equal(config.chat.backend.kind, 'session');
  });
});

describe('parseCapability（三选一 + 手写容错）', () => {
  test('remote 字段洗净（两端空白、缺 key 就不写 key）', () => {
    const item = parseCapability(
      { enabled: true, kind: 'remote', baseUrl: ' https://a.test/v1 ', model: ' m ', apiKey: '  ' },
      'chat',
      { enabled: true, kind: 'session' },
    );
    assert.deepEqual(item.backend, { kind: 'remote', baseUrl: 'https://a.test/v1', model: 'm' });
    assert.equal(item.enabled, true);
  });

  test('local 只写了 baseUrl 也认（把 baseUrl 当 endpoint）', () => {
    const item = parseCapability(
      { kind: 'local', baseUrl: 'http://127.0.0.1:1234/v1' },
      'vision',
      { enabled: false, kind: 'local' },
    );
    assert.deepEqual(item.backend, { kind: 'local', endpoint: 'http://127.0.0.1:1234/v1' });
  });

  test('不认识的 kind → 用该能力的默认 kind', () => {
    const chat = parseCapability({ kind: 'magic' }, 'chat', { enabled: true, kind: 'session' });
    assert.equal(chat.backend.kind, 'session');
    const tts = parseCapability({ kind: 'magic' }, 'tts', { enabled: false, kind: 'local' });
    assert.equal(tts.backend.kind, 'local');
  });

  test('识图写 kind:"session" → 降成本地空端点（绝不禁默走会话）', () => {
    const item = parseCapability({ enabled: true, kind: 'session' }, 'vision', { enabled: false, kind: 'local' });
    assert.deepEqual(item.backend, { kind: 'local', endpoint: '' });
  });

  test('enabled 不是布尔 → 用默认', () => {
    assert.equal(parseCapability({ enabled: 'yes' }, 'chat', { enabled: true, kind: 'session' }).enabled, true);
    assert.equal(parseCapability({ enabled: 0 }, 'tts', { enabled: false, kind: 'local' }).enabled, false);
  });
});

describe('toConfigSection（回写）', () => {
  test('往返一致：解析 → 回写 → 再解析，配置不变', () => {
    const config = parseModelConfig({
      chat: { enabled: true, kind: 'remote', baseUrl: 'https://a.test/v1', model: 'm', apiKey: 'k' },
      vision: { enabled: true, kind: 'local', endpoint: 'http://127.0.0.1:9999', model: 'vl' },
      tts: { enabled: false, kind: 'local', endpoint: '' },
    });
    const round = parseModelConfig(toConfigSection(config));
    assert.deepEqual(round, config);
  });

  test('session 后端只写 kind + enabled，不写空字段', () => {
    const section = toConfigSection(parseModelConfig(undefined));
    assert.deepEqual(section.chat, { enabled: true, kind: 'session' });
    assert.deepEqual(section.tts, { enabled: false, kind: 'local', endpoint: '', model: '' });
  });

  test('GPT-SoVITS 协议：解析得出来，回写也不丢（只有 tts 带这几个字段）', () => {
    const config = parseModelConfig({
      chat: { enabled: true, kind: 'session' },
      vision: { enabled: true, kind: 'local', endpoint: 'http://127.0.0.1:1234/v1' },
      tts: {
        enabled: true,
        kind: 'local',
        endpoint: 'http://127.0.0.1:9880',
        protocol: 'sovits',
        refAudioPath: 'D:/AI/GPT-SoVITS/_ref.wav',
        promptText: '哥哥，我是本鱼',
        speedFactor: 1.1,
      },
    });
    assert.equal(config.tts.backend.kind === 'local' ? config.tts.backend.protocol : '', 'sovits');
    // 识图即便配置里写了 protocol，也不该被认成发声协议
    assert.equal(config.vision.backend.kind === 'local' ? config.vision.backend.protocol : 'x', undefined);

    const round = parseModelConfig(toConfigSection(config));
    assert.deepEqual(round, config);
    const section = toConfigSection(config);
    assert.equal(section.tts.protocol, 'sovits');
    assert.equal(section.tts.refAudioPath, 'D:/AI/GPT-SoVITS/_ref.wav');
    assert.equal(section.tts.speedFactor, 1.1);
    assert.equal(section.vision.protocol, undefined);
  });
});

describe('fillRemoteBackends（留空 = 跟随 AI 设置）', () => {
  const conn = { baseUrl: 'https://opencode.ai/inference/go/openai/v1', model: 'deepseek-v4.1-flash', apiKey: 'oc_sk_x' };
  const blank = parseModelConfig({
    chat: { enabled: true, kind: 'remote', baseUrl: '', model: '', apiKey: '' },
    vision: { enabled: true, kind: 'remote', baseUrl: '', model: '', apiKey: '' },
    tts: { enabled: true, kind: 'remote', baseUrl: '', model: '', apiKey: '' },
  });

  test('三个能力都补：地址、模型名、密钥', () => {
    const filled = fillRemoteBackends(blank, conn);
    for (const cap of [filled.chat, filled.vision, filled.tts]) {
      assert.equal(cap.backend.kind, 'remote');
      const b = cap.backend as { baseUrl: string; model: string; apiKey?: string };
      assert.equal(b.baseUrl, conn.baseUrl);
      assert.equal(b.model, conn.model);
      assert.equal(b.apiKey, conn.apiKey);
    }
  });

  test('只补空位：显式写了的不动', () => {
    const own = parseModelConfig({
      chat: { enabled: true, kind: 'remote', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-own' },
      // 模型名空着 → 只补模型名，地址和 key 保留
      vision: { enabled: true, kind: 'remote', baseUrl: 'https://my.vision/v1', model: '', apiKey: 'vk' },
    });
    const filled = fillRemoteBackends(own, conn);
    const chat = filled.chat.backend as { baseUrl: string; model: string; apiKey?: string };
    assert.equal(chat.baseUrl, 'https://api.deepseek.com');
    assert.equal(chat.model, 'deepseek-flash');
    assert.equal(chat.apiKey, 'sk-own');
    const vision = filled.vision.backend as { baseUrl: string; model: string; apiKey?: string };
    assert.equal(vision.baseUrl, 'https://my.vision/v1');
    assert.equal(vision.model, conn.model);
    assert.equal(vision.apiKey, 'vk');
  });

  test('session / local 原样返回', () => {
    const mixed = parseModelConfig({ chat: { enabled: true, kind: 'session' }, tts: { enabled: true, kind: 'local', endpoint: 'http://127.0.0.1:9880' } });
    const filled = fillRemoteBackends(mixed, conn);
    assert.deepEqual(filled.chat, mixed.chat);
    assert.deepEqual(filled.tts, mixed.tts);
  });

  test('没 AI 设置（conn 空 / baseUrl 空）→ 原样返回，不硬编默认值', () => {
    assert.deepEqual(fillRemoteBackends(blank, undefined), blank);
    assert.deepEqual(fillRemoteBackends(blank, { baseUrl: '   ' }), blank);
  });
});
