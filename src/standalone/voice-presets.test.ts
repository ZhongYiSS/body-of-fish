/**
 * 嗓子四块的契约（哥哥 m24524 第 3 条 / 11-17 第 5 批三）：
 * 切块只换「当前生效」的那套，别块的字段一个都不能丢。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, viewOf } from './pet-settings.ts';

type Dict = Record<string, unknown>;

const base = (): Dict => ({
  model: {
    chat: { enabled: true, kind: 'remote', baseUrl: 'https://api.example/v1', model: 'chat-x' },
    vision: { enabled: true, kind: 'remote', baseUrl: 'https://api.example/v1', model: 'v-x' },
    tts: {
      enabled: true,
      kind: 'local',
      endpoint: 'http://127.0.0.1:9880',
      model: '希儿-社区版',
      protocol: 'sovits',
      refAudioPath: 'D:/ref.wav',
      promptText: '这是一段参考音',
    },
  },
  voice: { volume: 90 },
});

describe('嗓子四块', () => {
  it('没写 pick 时按 protocol 反推', () => {
    const cfg = base();
    assert.equal(viewOf(cfg).voicePick, 'tts');
    const win = base();
    (win.model as Dict).tts = { enabled: true, kind: 'local', endpoint: '', protocol: 'system' };
    assert.equal(viewOf(win).voicePick, 'windows');
  });

  it('切到 windows 再切回 tts：本地那套字段一个不丢', () => {
    const cfg = base();
    const toWindows = applyPatch(cfg, {
      voicePresets: { windows: { model: 'Microsoft Huihui Desktop' } },
      voicePick: 'windows',
    });
    const winTts = (toWindows.model as Dict).tts as Dict;
    assert.equal(winTts.protocol, 'system');
    assert.equal(winTts.endpoint, '');

    const back = applyPatch(toWindows, { voicePick: 'tts' });
    const backTts = (back.model as Dict).tts as Dict;
    assert.equal(backTts.kind, 'local');
    assert.equal(backTts.endpoint, 'http://127.0.0.1:9880');
    assert.equal(backTts.model, '希儿-社区版');
    assert.equal(backTts.refAudioPath, 'D:/ref.wav');
    assert.equal(backTts.promptText, '这是一段参考音');
    assert.equal(backTts.protocol, 'sovits');
  });

  it('模型直连那块保留自己的地址与密钥', () => {
    const cfg = applyPatch(base(), {
      voicePresets: { model: { baseUrl: 'https://api.example/v1', model: 'tts-1', apiKey: 'sk-1' } },
      voicePick: 'model',
    });
    const tts = (cfg.model as Dict).tts as Dict;
    assert.equal(tts.kind, 'remote');
    assert.equal(tts.baseUrl, 'https://api.example/v1');
    assert.equal(tts.apiKey, 'sk-1');
    // 切回本地后，模型那块还在
    const back = applyPatch(cfg, { voicePick: 'tts' });
    const presets = viewOf(back).voicePresets as Record<string, Dict>;
    assert.equal(presets.model?.baseUrl, 'https://api.example/v1');
    assert.equal(presets.model?.apiKey, 'sk-1');
  });

  it('只改一块不动别块（两次保存后四块都在）', () => {
    let cfg = base();
    cfg = applyPatch(cfg, { voicePick: 'edge', voicePresets: { edge: { model: 'zh-CN-XiaoxiaoNeural' } } });
    cfg = applyPatch(cfg, { voicePick: 'tts', voicePresets: { tts: { endpoint: 'http://127.0.0.1:9880' } } });
    const presets = viewOf(cfg).voicePresets as Record<string, Dict>;
    assert.equal(presets.edge?.model, 'zh-CN-XiaoxiaoNeural');
    assert.equal(presets.windows?.model, undefined);
    assert.equal((cfg.model as Dict).tts === undefined, false);
  });
});
