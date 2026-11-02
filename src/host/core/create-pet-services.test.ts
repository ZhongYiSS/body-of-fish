/**
 * 对外服务（气泡/嘴/眼）的守卫用例：**不碰网络、不碰盘**，全部注入假的。
 * 这三条是给 DSH 和别家程序用的口子，行为必须钉住：常驻气泡不许被闲聊顶掉、
 * 空气泡要拒绝、失败要带中文原因。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createPetServices, ServiceError } from './create-pet-services.ts';
import type { SayInput, SayOutcome } from './create-pet-core.ts';
import type { PollState } from '../state.ts';

const CORE_STATE = { sections: {}, pets: { main: {} } };

/** 假 core：只记下"写了什么"，不碰真实状态。 */
function fakeCore(outcome: SayOutcome = { ok: true }): {
  core: {
    say(input: SayInput): SayOutcome;
    state(): PollState;
    writePetSection(petId: string, name: string, data: unknown): void;
  };
  said: SayInput[];
  written: Array<{ petId: string; name: string; data: unknown }>;
} {
  const said: SayInput[] = [];
  const written: Array<{ petId: string; name: string; data: unknown }> = [];
  return {
    core: {
      say(input) {
        said.push(input);
        return outcome;
      },
      state: () => CORE_STATE as unknown as PollState,
      writePetSection(petId, name, data) {
        written.push({ petId, name, data });
      },
    },
    said,
    written,
  };
}

function fakeGateway(over: { vision?: string; speak?: Uint8Array; visionError?: string; speakError?: string } = {}) {
  const status = {
    chat: { ready: true },
    vision: { ready: true },
    tts: { ready: true },
  };
  return {
    async vision() {
      if (over.visionError) throw new Error(over.visionError);
      return over.vision ?? '一只鱼在吃白饭';
    },
    async speak() {
      if (over.speakError) throw new Error(over.speakError);
      return over.speak ?? new Uint8Array([1, 2, 3]);
    },
    status: () => status,
  };
}

describe('bubble（气泡）', () => {
  test('正常冒一句：走 core.say、记下当前气泡、id 有值', async () => {
    const { core, said } = fakeCore();
    const services = createPetServices({ core, gateway: fakeGateway(), now: () => 1000 });
    const handle = await services.bubble.say({ petId: 'main', text: '在的' });
    assert.equal(said.length, 1);
    assert.equal(said[0]?.text, '在的');
    assert.match(handle.id, /^b/);
    assert.equal(services.bubble.current('main')?.text, '在的');
  });

  test('字和图都没有 → bad-request（不写空叶子）', async () => {
    const { core, said } = fakeCore();
    const services = createPetServices({ core, gateway: fakeGateway() });
    await assert.rejects(() => services.bubble.say({ petId: 'main', text: '   ' }), (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.code, 'bad-request');
      return true;
    });
    assert.equal(said.length, 0);
  });

  test('常驻气泡挡住闲聊 → busy（而不是悄悄覆盖）', async () => {
    const { core } = fakeCore();
    const services = createPetServices({ core, gateway: fakeGateway() });
    await services.bubble.say({ petId: 'main', text: '重要提醒', sticky: true });
    await assert.rejects(() => services.bubble.say({ petId: 'main', text: '随便说一句' }), (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.code, 'busy');
      return true;
    });
  });

  test('clear → 写 {clear:true} 叶子并清掉记录', async () => {
    const { core, written } = fakeCore();
    const services = createPetServices({ core, gateway: fakeGateway() });
    await services.bubble.say({ petId: 'main', text: '在的' });
    await services.bubble.clear('main');
    assert.deepEqual(written.at(-1), { petId: 'main', name: 'say', data: { clear: true } });
    assert.equal(services.bubble.current('main'), null);
  });

  test('handle.clear 与 clear() 等价', async () => {
    const { core, written } = fakeCore();
    const services = createPetServices({ core, gateway: fakeGateway() });
    const handle = await services.bubble.say({ petId: 'main', text: '在的' });
    await handle.clear();
    assert.equal(written.length, 1);
  });

  test('core 说不行（比如显示端不对）→ failed 且带上 core 的原话', async () => {
    const { core } = fakeCore({ ok: false, reason: 'surface-mismatch', message: '这只宠物不在桌面显示' });
    const services = createPetServices({ core, gateway: fakeGateway() });
    await assert.rejects(() => services.bubble.say({ petId: 'main', text: '在的' }), (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.code, 'failed');
      assert.match(error.message, /不在桌面显示/);
      return true;
    });
  });
});

describe('voice（嘴）', () => {
  test('正常出声：字节原样回、带上 ttsKind', async () => {
    const { core } = fakeCore();
    const services = createPetServices({ core, gateway: fakeGateway({ speak: new Uint8Array([7, 7]) }), ttsKind: () => 'local' });
    const result = await services.voice.speak({ text: '在的' });
    assert.deepEqual([...result.audio], [7, 7]);
    assert.equal(result.backend, 'local');
    assert.equal(result.mime, 'audio/mpeg');
  });

  test('没话可念 → bad-request', async () => {
    const { core } = fakeCore();
    const services = createPetServices({ core, gateway: fakeGateway() });
    await assert.rejects(() => services.voice.speak({ text: '  ' }), /没话可念/);
  });

  test('网关报错 → failed，原因透传（不吞成"成功"）', async () => {
    const { core } = fakeCore();
    const services = createPetServices({ core, gateway: fakeGateway({ speakError: '还没填 API key' }) });
    await assert.rejects(() => services.voice.speak({ text: '在的' }), /还没填 API key/);
  });
});

describe('eyes（眼）', () => {
  test('给路径 → 读盘后交给网关，回结论', async () => {
    const { core } = fakeCore();
    const services = createPetServices({
      core,
      gateway: fakeGateway({ vision: '屏幕上是代码' }),
      readImage: async () => new Uint8Array([1, 2, 3]),
    });
    const result = await services.eyes.look({ image: 'D:/x.png', prompt: '看图' });
    assert.equal(result.text, '屏幕上是代码');
  });

  test('给字节 → 直接交给网关（不读盘）', async () => {
    const { core } = fakeCore();
    let readCalled = false;
    const services = createPetServices({
      core,
      gateway: fakeGateway({ vision: '空的桌面' }),
      readImage: async () => {
        readCalled = true;
        return new Uint8Array();
      },
    });
    await services.eyes.look({ image: new Uint8Array([9]) });
    assert.equal(readCalled, false);
  });

  test('读不到图 → bad-request，说清是哪张', async () => {
    const { core } = fakeCore();
    const services = createPetServices({
      core,
      gateway: fakeGateway(),
      readImage: async () => {
        throw new Error('ENOENT');
      },
    });
    await assert.rejects(() => services.eyes.look({ image: 'D:/没有.png' }), /读不到这张图/);
  });

  test('空图片 → bad-request', async () => {
    const { core } = fakeCore();
    const services = createPetServices({ core, gateway: fakeGateway() });
    await assert.rejects(() => services.eyes.look({ image: new Uint8Array() }), /图片是空的/);
  });
});

describe('snapshot / available', () => {
  test('snapshot 直接回 core 的状态（与 /state 同源）', () => {
    const { core } = fakeCore();
    const services = createPetServices({ core, gateway: fakeGateway() });
    assert.deepEqual(services.snapshot(), CORE_STATE);
  });

  test('available 把网关状态透出来（设置页据此显示红绿）', () => {
    const { core } = fakeCore();
    const services = createPetServices({ core, gateway: fakeGateway() });
    assert.equal(services.voice.available().ready, true);
    assert.equal(services.eyes.available().ready, true);
  });
});
