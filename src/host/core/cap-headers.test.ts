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
describe('会话头与取景档位真的能存住（11-19 全量测试查出的四处）', () => {
  it('只改请求头也要落盘，而且关着这一项也留着', () => {
    const next = applyPatch({}, { visionHeaders: 'x-new: 9' });
    const model = next.model as Record<string, Record<string, unknown>>;
    assert.deepEqual(model.vision?.extraHeaders, { 'x-new': '9' }, '关着的项也要记住会话头，下次打开直接用');
    const view = viewOf(next);
    assert.equal(view.visionHeaders, 'x-new: 9', '回显要读 backend.extraHeaders（不是能力顶层）');
  });

  it('切本地 → 云端，会话头不丢', () => {
    const local = applyPatch({}, { visionHeaders: 'x-keep: 1', visionMode: 'local', visionEndpoint: 'http://127.0.0.1:8080' });
    assert.equal(viewOf(local).visionHeaders, 'x-keep: 1');
    const remote = applyPatch(local, { visionMode: 'remote', visionBaseUrl: 'https://v/v1', visionModel: 'm' });
    assert.equal(viewOf(remote).visionHeaders, 'x-keep: 1');
    assert.equal(viewOf(remote).visionBaseUrl, 'https://v/v1');
  });

  it('取景档位与窗口句柄能写进去（原来被白名单漏掉，静默丢弃）', () => {
    const cfg = applyPatch({}, { watchMode: 'window', watchWindowHwnd: 98765 });
    assert.equal(viewOf(cfg).watchMode, 'window');
    assert.equal(viewOf(cfg).watchWindowHwnd, 98765);
    const full = applyPatch(cfg, { watchMode: 'full' });
    assert.equal(viewOf(full).watchMode, 'full');
  });
});

describe('嗓子四块：改了就存住，换块不串（11-19）', () => {
  it('已有存档时，新填的参考音/提示词不会被旧存档压回去', () => {
    const base = {
      model: { tts: { enabled: true, kind: 'local', endpoint: 'http://127.0.0.1:9880', model: '希儿-社区版', protocol: 'sovits', promptText: '旧文本' } },
      voice: { pick: 'tts', presets: { tts: { promptText: '旧文本' } } },
    };
    const next = applyPatch(base, { voicePromptText: '新文本' });
    assert.equal(viewOf(next).voicePromptText, '新文本');
    const preset = (viewOf(next).voicePresets as Record<string, Record<string, unknown>>).tts;
    assert.equal(preset?.promptText, '新文本', '存档那份也要跟着更新，否则下次切块就弹回旧值');
  });
});
