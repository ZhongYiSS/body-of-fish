/**
 * 模型网关契约守卫 —— 这几条红了就说明"可配置后端"这条需求被写歪了。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  allowsSession,
  diagnoseConfig,
  isBackendComplete,
  type CapabilityConfig,
  type ModelCapability,
} from './model-gateway.ts';

const core = readFileSync(join(import.meta.dirname, 'model-gateway.ts'), 'utf8');
const aiConfig = readFileSync(join(import.meta.dirname, '..', '..', 'standalone', 'ai-config.ts'), 'utf8');

function cfg(backend: CapabilityConfig['backend']): CapabilityConfig {
  return { enabled: true, backend };
}

describe('model-gateway 契约', () => {
  it('不许 import src/shared（DSH 单文件加载会拆 chunk）', () => {
    assert.ok(!/from\s+['"][^'"]*\/shared\//.test(core), 'model-gateway.ts 不能 import shared');
  });

  it('不许直接 import 任何供应商 SDK', () => {
    for (const sdk of ['@anthropic-ai/sdk', 'openai', 'node-fetch', 'undici']) {
      assert.ok(!core.includes(`from '${sdk}'`) && !core.includes(`from "${sdk}"`), `不该依赖 ${sdk}`);
    }
  });

  it('三类能力齐全，且接口承诺了五个方法', () => {
    for (const cap of ['chat', 'vision', 'tts'] as const) assert.ok(core.includes(`'${cap}'`), cap);
    for (const m of ['chat(', 'vision(', 'speak(', 'status(', 'test(']) assert.ok(core.includes(m), m);
  });

  it('只有聊天能走 DSH 会话', () => {
    assert.equal(allowsSession('chat'), true);
    assert.equal(allowsSession('vision'), false);
    assert.equal(allowsSession('tts'), false);
    const cap: ModelCapability = 'vision';
    const bad = diagnoseConfig(cap, cfg({ kind: 'session' }));
    assert.equal(bad?.code, 'unsupported');
  });

  it('后端是否配齐：三种 kind 各判一次', () => {
    assert.equal(isBackendComplete({ kind: 'session' }), true);
    assert.equal(isBackendComplete({ kind: 'local', endpoint: ' ' }), false);
    assert.equal(isBackendComplete({ kind: 'local', endpoint: 'http://127.0.0.1:9880' }), true);
    assert.equal(isBackendComplete({ kind: 'remote', baseUrl: '', model: 'm' }), false);
    assert.equal(isBackendComplete({ kind: 'remote', baseUrl: 'https://x', model: 'm' }), true);
  });

  it('缺东西时给出能照着改的原因，不是一句"配置错误"', () => {
    assert.equal(diagnoseConfig('chat', { enabled: false, backend: { kind: 'session' } })?.code, 'not-configured');
    assert.match(diagnoseConfig('chat', cfg({ kind: 'remote', baseUrl: 'https://x', model: 'm' }))?.message ?? '', /API key/);
    assert.match(diagnoseConfig('tts', cfg({ kind: 'local', endpoint: '' }))?.message ?? '', /本机服务地址/);
    assert.equal(diagnoseConfig('tts', cfg({ kind: 'local', endpoint: 'http://127.0.0.1:9880' })), null);
    // GPT-SoVITS：地址对但没参考音 = 还唱不了，原因要说清（音色全靠那几秒）
    assert.match(
      diagnoseConfig(
        'tts',
        cfg({ kind: 'local', endpoint: 'http://127.0.0.1:9880', protocol: 'sovits', refAudioPath: '  ' }),
      )?.message ?? '',
      /参考音/,
    );
    assert.equal(
      diagnoseConfig(
        'tts',
        cfg({
          kind: 'local',
          endpoint: 'http://127.0.0.1:9880',
          protocol: 'sovits',
          refAudioPath: 'D:/AI/GPT-SoVITS/_ref.wav',
        }),
      ),
      null,
    );
    assert.equal(
      diagnoseConfig('chat', cfg({ kind: 'remote', baseUrl: 'https://x', model: 'm', apiKey: 'k' })),
      null,
    );
  });

  it('字段名与 standalone 的 AI 设置对齐（baseUrl / model / apiKey），不另起一套', () => {
    for (const field of ['baseUrl', 'model', 'apiKey']) {
      assert.ok(core.includes(field), `网关要用 ${field}`);
      assert.ok(aiConfig.includes(field), `ai-config 里也该有 ${field}`);
    }
  });
});
