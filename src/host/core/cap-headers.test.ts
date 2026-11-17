import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeHeaders, parseModelConfig, toConfigSection } from './model-config';
import { applyPatch, viewOf } from '../../standalone/pet-settings';

describe('每个能力自己的会话头（哥哥 11-17 m26607）', () => {
  it('两种写法都认：多行 Key: Value 与对象', () => {
    const fromText = normalizeHeaders('x-a: 1\nx-b:2\n坏键!:3\n只写名字');
    assert.deepEqual(fromText, { 'x-a': '1', 'x-b': '2' });
    const fromObject = normalizeHeaders({ 'x-c': 'v', 'x-d': '' });
    assert.deepEqual(fromObject, { 'x-c': 'v' });
  });

  it('解析进 remote 后端，并能原样回写配置', () => {
    const config = parseModelConfig({
      vision: { enabled: true, kind: 'remote', baseUrl: 'https://v/v1', model: 'm', apiKey: 'k', extraHeaders: { 'x-vision': '1' } },
      tts: { enabled: true, kind: 'remote', baseUrl: 'https://t/v1', model: 'm', extraHeaders: 'x-tts: 2' },
    });
    assert.deepEqual(config.vision.backend.kind === 'remote' ? config.vision.backend.extraHeaders : null, { 'x-vision': '1' });
    assert.deepEqual(config.tts.backend.kind === 'remote' ? config.tts.backend.extraHeaders : null, { 'x-tts': '2' });
    const section = toConfigSection(config);
    assert.deepEqual(section.vision?.extraHeaders, { 'x-vision': '1' });
    assert.deepEqual(section.tts?.extraHeaders, { 'x-tts': '2' });
  });

  it('设置页：回显成多行文本，保存写回 model 段', () => {
    const input = {
      model: {
        vision: { enabled: true, kind: 'remote', baseUrl: 'https://v/v1', model: 'm', extraHeaders: { 'x-vision': '1' } },
      },
    };
    assert.equal(viewOf(input).visionHeaders, 'x-vision: 1');
    const next = applyPatch({}, { visionHeaders: 'x-new: 9', ttsHeaders: 'x-tts: 3' });
    const model = next.model as Record<string, Record<string, unknown>>;
    assert.deepEqual(model.vision?.extraHeaders, { 'x-new': '9' });
    assert.deepEqual(model.tts?.extraHeaders, { 'x-tts': '3' });
  });

  it('小气泡默认位置就是哥哥本机那档（-79 / -7）', () => {
    const view = viewOf({});
    assert.equal(view.hintX, -79);
    assert.equal(view.hintY, -7);
  });
});