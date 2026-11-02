/**
 * core.say / writeSection 的实现守卫 —— 搬进来之后行为必须与旧路由逐字一致。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PollStateStore } from '../state.ts';
import { createPetCoreRuntime, type SayOutcome } from './create-pet-core.ts';

/** 与 readAllConfig 同形：条目名 → { pets: [...], memes: {...}, 全局开关 } */
const CFG = {
  main: { pets: [{ id: 'main', name: '大肥鱼', size: 580, display: 'desktop' }], memes: {} },
};

function runtime(options: { gate?: (ctx: { petId: string }) => SayOutcome | null } = {}) {
  const state = new PollStateStore();
  const core = createPetCoreRuntime({
    state,
    readConfig: () => CFG,
    memeDirsFor: () => [],
    ...(options.gate ? { gate: options.gate } : {}),
  });
  return { state, core };
}

function sayData(state: PollStateStore, petId = 'main') {
  return (state.read().pets[petId]?.say.data ?? null) as Record<string, unknown> | null;
}

describe('core.say', () => {
  it('正常一句话：写进 say 叶子，counter 前进', () => {
    const { state, core } = runtime();
    const before = state.read().counter;
    assert.deepEqual(core.say({ petId: 'main', text: '  在的哥哥  ' }), { ok: true });
    assert.equal(sayData(state)?.text, '在的哥哥', '首尾空白会被规范化');
    assert.ok(state.read().counter > before);
    assert.equal(sayData(state)?.duration !== undefined, true, 'duration 写生效值');
  });

  it('空文本直接拒，且**不碰**状态（不为必然失败的请求写叶子）', () => {
    const { state, core } = runtime();
    const before = state.read();
    const out = core.say({ petId: 'main', text: '   ' });
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.reason, 'bad-request');
    assert.deepEqual(state.read().pets, before.pets);
  });

  it('duration 非法 / 未带 pet 都给出具体原因', () => {
    const { core } = runtime();
    const bad = core.say({ petId: 'main', text: '嗨', duration: -1 });
    assert.equal(!bad.ok && bad.message, 'duration 必须是 ≥0 的有限数字（毫秒）');
    const noPet = core.say({ petId: '', text: '嗨' });
    assert.equal(!noPet.ok && noPet.reason, 'pet-required');
    const unknown = core.say({ petId: 'test9', text: '嗨' });
    assert.equal(!unknown.ok && unknown.reason, 'unknown-pet');
  });

  it('url 形态只收 http/https；image 与 url 不能同时给', () => {
    const { state, core } = runtime();
    const ok = core.say({ petId: 'main', text: '看图', url: 'https://x.test/a.png' });
    assert.equal(ok.ok, true);
    assert.equal(sayData(state)?.url, 'https://x.test/a.png');
    const bad = core.say({ petId: 'main', text: '看图', url: 'not-a-url' });
    assert.equal(!bad.ok && bad.reason, 'bad-request');
    const both = core.say({ petId: 'main', text: '看图', url: 'https://x.test/a.png', image: 'Ciallo' });
    assert.equal(!both.ok && both.message, 'image 与 url 只能给一个');
  });

  it('门禁拦下时原样回原因，且不写状态', () => {
    const { state, core } = runtime({
      gate: ({ petId }) => (petId === 'main' ? { ok: false, reason: 'locked', message: '被占用了' } : null),
    });
    const out = core.say({ petId: 'main', text: '嗨' });
    assert.equal(!out.ok && out.reason, 'locked');
    assert.equal(sayData(state), null);
  });

  it('读配置炸了要显式失败，不许静默成功', () => {
    const state = new PollStateStore();
    const core = createPetCoreRuntime({
      state,
      readConfig: () => {
        throw new Error('主配置文件坏了');
      },
      memeDirsFor: () => [],
    });
    const out = core.say({ petId: 'main', text: '嗨' });
    assert.equal(!out.ok && out.reason, 'generate-error');
    assert.match(!out.ok ? out.message : '', /主配置文件坏了/);
  });
});

describe('core.lyric', () => {
  const lyricData = (state: PollStateStore, petId = 'main') =>
    (state.read().pets[petId]?.lyric.data ?? null) as Record<string, unknown> | null;

  it('写进 lyric 叶子，不动 say；chars 按码点数', () => {
    const { state, core } = runtime();
    const out = core.lyric({ petId: 'main', text: '🎵咕噜' });
    assert.deepEqual(out, { ok: true, pet: 'main', chars: 3 });
    assert.deepEqual(lyricData(state), { text: '🎵咕噜', instrumental: false });
    assert.equal(state.read().pets.main?.say.data, null, '歌词不抢说话气泡');
  });

  it('空串 / 不给 text 都是合法输入：写空文本（= 隐藏），不算失败', () => {
    const { state, core } = runtime();
    assert.equal(core.lyric({ petId: 'main', text: '先唱一句' }).ok, true);
    const out = core.lyric({ petId: 'main' });
    assert.deepEqual(out, { ok: true, pet: 'main', chars: 0 });
    assert.deepEqual(lyricData(state), { text: '', instrumental: false });
  });

  it('instrumental 只有严格 true 才算，其它值当 false', () => {
    const { state, core } = runtime();
    core.lyric({ petId: 'main', text: '前奏中…', instrumental: 'yes' });
    assert.equal(lyricData(state)?.instrumental, false);
    core.lyric({ petId: 'main', text: '前奏中…', instrumental: true });
    assert.equal(lyricData(state)?.instrumental, true);
  });

  it('显示端不符时被门禁拦下，且不写叶子', () => {
    const { state, core } = runtime({
      gate: () => ({ ok: false, reason: 'surface-mismatch', message: '这只宠物不在浏览器显示' }),
    });
    const out = core.lyric({ petId: 'main', text: '啊' });
    assert.equal(!out.ok && out.reason, 'surface-mismatch');
    assert.equal(lyricData(state), null);
  });

  it('未知宠物 / 空 pet 沿用 say 的判定口径', () => {
    const { core } = runtime();
    const noPet = core.lyric({ petId: '', text: '啊' });
    assert.equal(!noPet.ok && noPet.reason, 'pet-required');
    const unknown = core.lyric({ petId: 'test9', text: '啊' });
    assert.equal(!unknown.ok && unknown.reason, 'unknown-pet');
  });
});

describe('core 槽位与快照', () => {
  it('writeSection / writePetSection 落的是同一份 store', () => {
    const { state, core } = runtime();
    core.writeSection('notify', { frame: 'lyric', text: '为你写诗' });
    core.writePetSection('main', 'anim', { name: 'idle' });
    const snap = state.read();
    assert.deepEqual(snap.sections.notify.data, { frame: 'lyric', text: '为你写诗' });
    assert.equal((snap.pets.main?.anim.data as { name: string }).name, 'idle');
  });

  it('state() 就是 store.read()，config() 就是 readConfig()', () => {
    const { state, core } = runtime();
    assert.deepEqual(core.state(), state.read());
    assert.equal(core.config(), CFG);
  });
});
