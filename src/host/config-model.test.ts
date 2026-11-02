/**
 * 设置页写盘的两段白名单：`model`（模型后端）与 `memePool`（抽卡池）。
 * 盯住三件事：归一化落盘、坏形状 400、没传时不抹掉用户手写的值。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { keepApiKey, memePoolValid, modelSectionValid, normalizeMemePool, saveUserConfig } from './config.ts';
import { parseModelConfig } from './core/model-config.ts';

const PET = {
  id: 'main',
  size: 580,
  balanceEnabled: true,
  display: 'desktop',
  position: { corner: 'bottom-right', marginX: 0, marginY: 0 },
};

describe('modelSectionValid（只校形状）', () => {
  test('三个能力名都认；空对象也算合法（全用默认）', () => {
    assert.equal(modelSectionValid({}), true);
    assert.equal(modelSectionValid({ chat: { kind: 'session' } }), true);
    assert.equal(
      modelSectionValid({ chat: {}, vision: {}, tts: {} }),
      true,
    );
  });

  test('不认识的键 / 数组 / 标量 → 非法', () => {
    assert.equal(modelSectionValid({ chat: {}, stt: {} }), false);
    assert.equal(modelSectionValid([]), false);
    assert.equal(modelSectionValid('session'), false);
    assert.equal(modelSectionValid({ chat: 'session' }), false);
    assert.equal(modelSectionValid(undefined), false);
  });
});

describe('memePoolValid / normalizeMemePool', () => {
  test('只接受字符串数组', () => {
    assert.equal(memePoolValid([]), true);
    assert.equal(memePoolValid(['吃白饭']), true);
    assert.equal(memePoolValid([1]), false);
    assert.equal(memePoolValid('吃白饭'), false);
  });

  test('归一化：去空白、丢空串、去重保序', () => {
    assert.deepEqual(normalizeMemePool([' 可爱 ', '可爱', '', '  ', '死掉了']), ['可爱', '死掉了']);
  });
});

describe('saveUserConfig 对 model / memePool 的处理', () => {
  test('传了就归一化落盘（多余字段不写进用户层）', () => {
    const clean = saveUserConfig({
      pets: [PET],
      model: {
        chat: { enabled: true, kind: 'remote', baseUrl: ' https://a.test/v1 ', model: 'm', apiKey: 'k', 额外: 1 },
        vision: { enabled: false, kind: 'local' },
      },
      memePool: [' 可爱 ', '可爱', '死掉了'],
    });
    assert.ok(clean);
    assert.deepEqual(clean?.model, {
      chat: { enabled: true, kind: 'remote', baseUrl: 'https://a.test/v1', model: 'm', apiKey: 'k' },
      vision: { enabled: false, kind: 'local', endpoint: '', model: '' },
      tts: { enabled: false, kind: 'local', endpoint: '', model: '' },
    });
    assert.deepEqual(clean?.memePool, ['可爱', '死掉了']);
  });

  test('没传 → 透传磁盘上的旧值（设置页漏传不能把配置抹掉）', () => {
    const existing = {
      pets: [PET],
      model: { chat: { enabled: true, kind: 'session' } },
      memePool: ['可爱'],
      whisperPrompt: '本鱼人设',
    };
    const clean = saveUserConfig({ pets: [PET] }, existing);
    assert.deepEqual(clean?.model, existing.model);
    assert.deepEqual(clean?.memePool, ['可爱']);
    assert.equal(clean?.whisperPrompt, '本鱼人设');
  });

  test('形状不对 → null（宿主回 400），不写盘', () => {
    assert.equal(saveUserConfig({ pets: [PET], model: { chat: 'session' } }), null);
    assert.equal(saveUserConfig({ pets: [PET], memePool: '全是图' }), null);
    assert.equal(saveUserConfig({ pets: [PET], memePool: [1, 2] }), null);
  });
});

describe('keepApiKey（保存不能把 key 抹掉）', () => {
  test('新配置 key 留空 + 旧值有 key → 沿用旧 key', () => {
    const incoming = parseModelConfig({
      chat: { enabled: true, kind: 'remote', baseUrl: 'https://a.test/v1', model: 'm', apiKey: '' },
    });
    const merged = keepApiKey(incoming, {
      model: { chat: { enabled: true, kind: 'remote', baseUrl: 'https://a.test/v1', model: 'm', apiKey: '旧key' } },
    });
    assert.equal(merged.chat.backend.kind, 'remote');
    assert.equal((merged.chat.backend as { apiKey?: string }).apiKey, '旧key');
  });

  test('新配置填了新 key → 用新的（不覆盖用户输入）', () => {
    const incoming = parseModelConfig({
      chat: { enabled: true, kind: 'remote', baseUrl: 'https://a.test/v1', model: 'm', apiKey: '新key' },
    });
    const merged = keepApiKey(incoming, {
      model: { chat: { enabled: true, kind: 'remote', baseUrl: 'https://a.test/v1', model: 'm', apiKey: '旧key' } },
    });
    assert.equal((merged.chat.backend as { apiKey?: string }).apiKey, '新key');
  });

  test('旧值不是 remote / 旧值没 key / 没有旧配置 → 保持空', () => {
    const incoming = parseModelConfig({ chat: { kind: 'session' } });
    assert.deepEqual(keepApiKey(incoming, undefined), incoming);
    const remote = parseModelConfig({ chat: { kind: 'remote', baseUrl: 'https://a.test/v1', model: 'm' } });
    assert.equal((keepApiKey(remote, { model: { chat: { kind: 'session' } } }).chat.backend as { apiKey?: string }).apiKey, undefined);
  });

  test('识图/声音的 key 各自独立保留', () => {
    const incoming = parseModelConfig({
      vision: { enabled: true, kind: 'remote', baseUrl: 'https://v.test/v1', model: 'vl' },
      tts: { enabled: true, kind: 'remote', baseUrl: 'https://s.test/v1', model: 'tts' },
    });
    const merged = keepApiKey(incoming, {
      model: {
        vision: { kind: 'remote', baseUrl: 'https://v.test/v1', model: 'vl', apiKey: 'v-key' },
        tts: { kind: 'remote', baseUrl: 'https://s.test/v1', model: 'tts', apiKey: 's-key' },
      },
    });
    assert.equal((merged.vision.backend as { apiKey?: string }).apiKey, 'v-key');
    assert.equal((merged.tts.backend as { apiKey?: string }).apiKey, 's-key');
  });
});
