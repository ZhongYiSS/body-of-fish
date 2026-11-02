import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyPatch, createPetSettingsService, validatePetSettings, viewOf } from './pet-settings.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-pet-settings-'));
}

test('viewOf：空配置回落到默认值', () => {
  const view = viewOf({});
  assert.equal(view.name, '蓝色大肥鱼');
  assert.equal(view.size, 580);
  assert.equal(view.display, 'both');
  assert.equal(view.corner, 'top-right');
  assert.equal(view.marginX, 24);
  assert.equal(view.marginY, 100);
  assert.equal(view.fontFamily, 'system');
  assert.equal(view.fontSize, 21);
  assert.equal(view.followPet, true);
  assert.equal(view.gravity, 1400);
  assert.equal(view.restitution, 0.78);
  assert.equal(view.groundFriction, 2.5);
  assert.equal(view.ceilingBounce, true);
  assert.equal(view.throwPower, 1);
});

test('viewOf：读得出嵌套字段，非法枚举/数字回落到默认', () => {
  const view = viewOf({
    pets: [{ id: 'main', name: '小蓝', size: 400, display: 'desktop', fixedEnabled: true, position: { corner: 'bottom-left', marginX: 0, marginY: 12 } }],
    confineToScreen: true,
    font: { family: 'kaiti', size: 30, followPet: false },
    physics: { gravity: 900, restitution: 0.5, groundFriction: 1, ceilingBounce: false, throwPower: 2 },
  });
  assert.equal(view.name, '小蓝');
  assert.equal(view.size, 400);
  assert.equal(view.display, 'desktop');
  assert.equal(view.corner, 'bottom-left');
  assert.equal(view.marginX, 0);
  assert.equal(view.confineToScreen, true);
  assert.equal(view.fontFamily, 'kaiti');
  assert.equal(view.fontSize, 30);
  assert.equal(view.followPet, false);

  const broken = viewOf({
    pets: [{ name: '   ', size: 'big', display: 'everywhere', position: { corner: 'middle' } }],
    font: { family: 'comic-sans', size: 999 },
  });
  assert.equal(broken.name, '蓝色大肥鱼');
  assert.equal(broken.size, 580);
  assert.equal(broken.display, 'both');
  assert.equal(broken.corner, 'top-right');
  assert.equal(broken.fontFamily, 'system');
  assert.equal(broken.fontSize, 21);
});

test('applyPatch：只改白名单字段，其他键与其他宠物原样保留', () => {
  const before = {
    pets: [
      { id: 'main', name: '旧名字', whisperPrompt: '别动我' },
      { id: 'second', name: '第二只' },
    ],
    unknownKey: { keep: true },
  };
  const after = applyPatch(before, validatePetSettings({ name: '新名字', size: 300 }));
  assert.equal((after.pets as any[])[0].name, '新名字');
  assert.equal((after.pets as any[])[0].size, 300);
  assert.equal((after.pets as any[])[0].whisperPrompt, '别动我');
  assert.equal((after.pets as any[])[1].name, '第二只');
  assert.deepEqual(after.unknownKey, { keep: true });
  // 原对象不被就地修改
  assert.equal((before.pets as any[])[0].name, '旧名字');
});

test('whisperEnabled：默认允许，读得出也写得进（碎碎念总开关在宠物级）', () => {
  // 配置里没写 → 默认 true（与 assets/config.jsonc 的 pets[].whisperEnabled 默认一致）
  assert.equal(viewOf({}).whisperEnabled, true);
  // 用户关掉 → 页面显示关，且能原样存回去
  const off = viewOf({ pets: [{ id: 'main', whisperEnabled: false }] });
  assert.equal(off.whisperEnabled, false);
  const after = applyPatch({ pets: [{ id: 'main', whisperEnabled: true }] }, validatePetSettings({ whisperEnabled: false }));
  assert.equal((after.pets as any[])[0].whisperEnabled, false);
});

test('whisperIntervalMin：间隔只认 eventsRefreshSec.whisper 这一份（分钟进、秒出）', () => {
  // 没写 → 60 秒 = 1 分钟（和陪伴的节奏接壤，11-01 定）
  assert.equal(viewOf({}).whisperIntervalMin, 1);
  assert.equal(viewOf({ eventsRefreshSec: { whisper: 1800 } }).whisperIntervalMin, 30);
  const next = applyPatch({ eventsRefreshSec: { balance: 1800, whisper: 300 } }, validatePetSettings({ whisperIntervalMin: 15 }));
  // 写进去是秒，别的刷新周期不许被冲掉
  assert.deepEqual(next.eventsRefreshSec, { balance: 1800, whisper: 900 });
  // 越界与非整数直接拒（不让页面把配置写成 0 秒）
  for (const bad of [{ whisperIntervalMin: 0 }, { whisperIntervalMin: 1441 }, { whisperIntervalMin: 5.5 }]) {
    assert.throws(() => validatePetSettings(bad), Error, JSON.stringify(bad));
  }
});
test('persona（人格）：实例级优先 → 条目级 → 空串，写进去、清空能删掉覆盖', () => {
  // 配置里什么都没写 → 页面拿到空串（页面据此用占位符提示"留空即默认"）
  assert.equal(viewOf({}).persona, '');
  // 条目级（顶层 whisperPrompt）
  assert.equal(viewOf({ whisperPrompt: '条目级人设' }).persona, '条目级人设');
  // 实例级覆盖优先
  assert.equal(
    viewOf({ whisperPrompt: '条目级人设', pets: [{ id: 'main', whisperPrompt: '实例级人设' }] }).persona,
    '实例级人设',
  );
  // 写：落到 pets[0].whisperPrompt（宿主 petPersona 优先读它），且前后空白被去掉
  const written = applyPatch({ whisperPrompt: '旧' }, validatePetSettings({ persona: '  新的人设  ' }));
  assert.equal((written.pets as any[])[0].whisperPrompt, '新的人设');
  assert.equal(written.whisperPrompt, '旧'); // 条目级原样保留，不误伤
  // 清空 → 删掉实例级覆盖（回落到条目级/包内默认）
  const cleared = applyPatch(
    { pets: [{ id: 'main', whisperPrompt: '实例级人设' }] },
    validatePetSettings({ persona: '   ' }),
  );
  assert.equal('whisperPrompt' in ((cleared.pets as any[])[0] ?? {}), false);
});

test('validatePetSettings：人格过长被拒（不会把配置文件写成几万字）', () => {
  assert.throws(() => validatePetSettings({ persona: 'x'.repeat(4001) }), /桌宠设置无效/);
});

test('validatePetSettings：越界、未知键、类型错都拒绝，并给同一句可操作提示', () => {
  assert.throws(() => validatePetSettings({ size: 20 }), /桌宠设置无效/);
  assert.throws(() => validatePetSettings({ marginX: 5000 }), /桌宠设置无效/);
  assert.throws(() => validatePetSettings({ fontSize: 3 }), /桌宠设置无效/);
  assert.throws(() => validatePetSettings({ display: 'everywhere' }), /桌宠设置无效/);
  assert.throws(() => validatePetSettings({ name: '' }), /桌宠设置无效/);
  assert.throws(() => validatePetSettings({ nope: 1 }), /桌宠设置无效/);
  assert.deepEqual(validatePetSettings({ gravity: 0, throwPower: 5 }), { gravity: 0, throwPower: 5 });
});

test('createPetSettingsService：文件不存在时读默认值，保存后落盘并回调', async () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'main-config.jsonc');
    let reloads = 0;
    const service = createPetSettingsService(file, () => {
      reloads += 1;
    });
    assert.equal(service.getSettings().name, '蓝色大肥鱼');

    const saved = await service.saveSettings({ name: '小蓝鲸', size: 420, gravity: 800, corner: 'bottom-right' });
    assert.equal(saved.name, '小蓝鲸');
    assert.equal(saved.size, 420);
    assert.equal(saved.corner, 'bottom-right');
    assert.equal(reloads, 1);

    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.pets[0].id, 'main');
    assert.equal(onDisk.pets[0].name, '小蓝鲸');
    assert.equal(onDisk.pets[0].size, 420);
    assert.equal(onDisk.pets[0].position.corner, 'bottom-right');
    assert.equal(onDisk.physics.gravity, 800);
    // 再读一遍仍一致（说明写出来的东西能被自己读回）
    assert.equal(service.getSettings().name, '小蓝鲸');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createPetSettingsService：保留已有配置里的其他键，坏 JSON 时仍能打开页面', async () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'main-config.jsonc');
    writeFileSync(file, JSON.stringify({ pets: [{ id: 'main', name: '旧的', display: 'web' }], keepMe: 1 }));
    const service = createPetSettingsService(file);
    await service.saveSettings({ size: 600 });
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.keepMe, 1);
    assert.equal(onDisk.pets[0].display, 'web');
    assert.equal(onDisk.pets[0].size, 600);

    writeFileSync(file, '{ 这不是 JSON');
    assert.equal(service.getSettings().size, 580);
    await service.saveSettings({ size: 500 });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pets[0].size, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('看图/声音：三档读得出、写得进，且不动 chat 段的密钥', () => {
  const base = {
    model: {
      chat: { enabled: true, kind: 'remote', baseUrl: 'https://api.example.test/v1', model: 'chat-1', apiKey: 'sk-keep' },
      vision: { enabled: true, kind: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'qwen2-vl' },
      tts: { enabled: false, kind: 'local', endpoint: '', model: '' },
    },
  };
  const view = viewOf(base);
  assert.equal(view.visionMode, 'local');
  assert.equal(view.visionEndpoint, 'http://127.0.0.1:1234/v1');
  assert.equal(view.visionModel, 'qwen2-vl');
  assert.equal(view.voiceMode, 'off');

  const next = applyPatch(base, { visionMode: 'remote', visionModel: 'gpt-4o-mini', voiceMode: 'local', voiceEndpoint: 'http://127.0.0.1:9880/v1' });
  const model = next.model as Record<string, Record<string, unknown>>;
  assert.deepEqual(model.vision, { enabled: true, kind: 'remote', baseUrl: '', model: 'gpt-4o-mini', apiKey: '' });
  assert.deepEqual(model.tts, { enabled: true, kind: 'local', endpoint: 'http://127.0.0.1:9880/v1', model: '' });
  // chat 段必须原样（toConfigSection 会写全三项，写错就把 key 冲掉了）
  assert.deepEqual(model.chat, base.model.chat);

  // 关掉看图 → enabled false，但本地地址保留（下次选回本地不用重填）
  const off = applyPatch(next, { visionMode: 'off' });
  assert.deepEqual((off.model as Record<string, Record<string, unknown>>).vision, { enabled: false, kind: 'local', endpoint: '', model: '' });
});

test('看图/声音：模式必须是三档之一，长度有上限', () => {
  assert.throws(() => validatePetSettings({ visionMode: 'session' }));
  assert.throws(() => validatePetSettings({ visionModel: 'x'.repeat(201) }));
  assert.equal((validatePetSettings({ voiceMode: 'off' }) as { voiceMode: string }).voiceMode, 'off');
});

test('声音协议：sovits 的参考音写进 model.tts，切回 openai 就清干净', () => {
  const base: Record<string, unknown> = {
    pets: [{ id: 'main', name: '鱼' }],
    model: {
      chat: { enabled: true, kind: 'session' },
      vision: { enabled: false, kind: 'local' },
      tts: { enabled: false, kind: 'local' },
    },
  };
  const on = applyPatch(base as never, {
    voiceMode: 'local',
    voiceEndpoint: 'http://127.0.0.1:9880',
    voiceProtocol: 'sovits',
    voiceRefAudio: 'D:/AI/GPT-SoVITS/_ref.wav',
    voicePromptText: '哥哥，我是本鱼',
  });
  const tts = (on.model as Record<string, Record<string, unknown>>).tts;
  assert.equal(tts.enabled, true);
  assert.equal(tts.kind, 'local');
  assert.equal(tts.protocol, 'sovits');
  assert.equal(tts.refAudioPath, 'D:/AI/GPT-SoVITS/_ref.wav');
  assert.equal(tts.promptText, '哥哥，我是本鱼');
  assert.equal(tts.speedFactor, 1);

  // 读回来：页面要能看到刚才填的三个字段
  const view = viewOf(on as never);
  assert.equal(view.voiceProtocol, 'sovits');
  assert.equal(view.voiceRefAudio, 'D:/AI/GPT-SoVITS/_ref.wav');
  assert.equal(view.voicePromptText, '哥哥，我是本鱼');

  // 切回标准接口 → sovits 专有字段不许留在配置里
  const off = applyPatch(on as never, { voiceProtocol: 'openai' });
  const tts2 = (off.model as Record<string, Record<string, unknown>>).tts;
  assert.equal(tts2.protocol, undefined);
  assert.equal(tts2.refAudioPath, undefined);
  assert.equal(tts2.promptText, undefined);
});

test('声音协议：只认 openai / sovits，参考音有长度上限', () => {
  assert.throws(() => validatePetSettings({ voiceProtocol: 'vits' }));
  assert.throws(() => validatePetSettings({ voiceRefAudio: 'x'.repeat(513) }));
});
