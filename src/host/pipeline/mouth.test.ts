/**
 * 嘴的测试：拿假合成 / 假播放器把「谁先说、谁打断谁、会不会挂死」全跑一遍。
 * 跑法：`node --test --experimental-strip-types src/host/pipeline/mouth.test.ts`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMouth, type MouthDeps } from './mouth.ts';
import type { Level, Utterance } from './types.ts';

interface Harness {
  deps: MouthDeps;
  bubbles: string[];
  logs: string[];
  lamps: boolean[];
  synthCalls: number;
  tick: (ms: number) => void;
  /** 让当前播放「播完」 */
  finishPlay: () => void;
  /** 放行被卡住的合成 */
  releaseSynth: () => void;
  /** 播放里正在等的那个 resolve（没在播就是 null） */
  playing: { utt: string; epoch: number } | null;
}

function makeHarness(options: { listening?: boolean; synthNull?: boolean; slowSynth?: boolean } = {}): Harness {
  let now = 1_000_000;
  let listening = options.listening === true;
  const bubbles: string[] = [];
  const logs: string[] = [];
  const lamps: boolean[] = [];
  let finish: (() => void) | null = null;
  let releaseSynth: (() => void) | null = null;
  const state: Harness = {
    deps: null as unknown as MouthDeps,
    bubbles,
    logs,
    lamps,
    synthCalls: 0,
    tick: (ms: number) => {
      now += ms;
    },
    finishPlay: () => {
      const done = finish;
      finish = null;
      done?.();
    },
    releaseSynth: () => {
      const done = releaseSynth;
      releaseSynth = null;
      done?.();
    },
    playing: null,
  };
  void listening;

  state.deps = {
    now: () => now,
    isListening: () => listening,
    synthesize: async () => {
      state.synthCalls += 1;
      if (options.slowSynth === true) {
        await new Promise<void>((resolve) => {
          releaseSynth = resolve;
        });
      }
      if (options.synthNull === true) return null;
      return { audio: new Uint8Array([1, 2, 3]), mime: 'audio/wav' };
    },
    play: async (audio, mime, epoch, onStart) => {
      state.playing = { utt: `${audio.length}:${mime}`, epoch };
      onStart();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      state.playing = null;
    },
    stopPlayback: () => {
      const done = finish;
      finish = null;
      done?.();
      state.playing = null;
    },
    writeBubble: (petId, text, image, durationMs) => {
      bubbles.push(`${petId}|${text}|${image ?? ''}|${durationMs}`);
    },
    clearBubble: () => {
      bubbles.push('clear');
    },
    lamp: (on) => {
      lamps.push(on);
    },
    log: (line) => {
      logs.push(line);
    },
    audioMs: () => 4_000,
    synthTimeoutMs: 30_000,
  };
  // 供测试切「在听」状态
  (state as unknown as { setListening: (v: boolean) => void }).setListening = (v: boolean) => {
    listening = v;
  };
  return state;
}

function setListening(harness: Harness, value: boolean): void {
  (harness as unknown as { setListening: (v: boolean) => void }).setListening(value);
}

function utt(level: Level, text: string, extra: Partial<Utterance> = {}): Utterance {
  return {
    id: `${level}:${text}`,
    level,
    session: 'main',
    kind: 'say',
    text,
    petId: 'main',
    at: 1_000_000,
    ...extra,
  };
}

describe('嘴：正常说一句', () => {
  it('气泡等声音开始才写，时长比声音多 2 秒', async () => {
    const h = makeHarness({ slowSynth: true });
    const mouth = createMouth(h.deps);
    const pending = mouth.speak(utt(2, '晚上好'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.bubbles.length, 0, '还没开播就不该有气泡');
    h.releaseSynth();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.bubbles.length, 1, '开播那一刻写一条');
    assert.match(h.bubbles[0], /^main\|晚上好\|\|6000$/);
    h.finishPlay();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.deepEqual(h.lamps, [true, false]);
  });

  it('合成失败时只写字，不假装说过', async () => {
    const h = makeHarness({ synthNull: true });
    const mouth = createMouth(h.deps);
    const result = await mouth.speak(utt(2, '没声音也要有字'));
    assert.equal(result.ok, false);
    assert.equal(result.message, 'synth-failed');
    assert.equal(h.bubbles.length, 1);
    assert.match(h.bubbles[0], /没声音也要有字/);
  });

  it('只冒泡不出声走 show', () => {
    const h = makeHarness();
    const mouth = createMouth(h.deps);
    mouth.show({ petId: 'main', text: '只写字' });
    assert.equal(h.synthCalls, 0);
    assert.equal(h.bubbles.length, 1);
  });
});

describe('嘴：在听时哑巴', () => {
  it('在听时不合成、不冒泡，直接告诉调用方原因', async () => {
    const h = makeHarness({ listening: true });
    const mouth = createMouth(h.deps);
    const result = await mouth.speak(utt(2, '她不该说'));
    assert.equal(result.ok, false);
    assert.equal(result.message, 'listening');
    assert.equal(h.synthCalls, 0);
    assert.equal(h.bubbles.length, 0);
  });

  it('在听时 show 也不出声', () => {
    const h = makeHarness({ listening: true });
    const mouth = createMouth(h.deps);
    mouth.show({ petId: 'main', text: '静音' });
    assert.equal(h.bubbles.length, 0);
  });

  it('停麦后又能说了', async () => {
    const h = makeHarness({ listening: true });
    const mouth = createMouth(h.deps);
    assert.equal((await mouth.speak(utt(2, 'a'))).message, 'listening');
    setListening(h, false);
    const pending = mouth.speak(utt(2, 'b'));
    await new Promise((resolve) => setImmediate(resolve));
    h.finishPlay();
    assert.equal((await pending).ok, true);
  });
});

describe('嘴：谁打断谁', () => {
  it('碎碎念在嘴忙时直接丢', async () => {
    const h = makeHarness();
    const mouth = createMouth(h.deps);
    const first = mouth.speak(utt(2, '正在说'));
    await new Promise((resolve) => setImmediate(resolve));
    const second = await mouth.speak(utt(1, '碎碎念'));
    assert.equal(second.message, 'busy');
    h.finishPlay();
    assert.equal((await first).ok, true);
  });

  it('5 级能顶掉正在说的 2 级，被顶的那条算 interrupted', async () => {
    const h = makeHarness();
    const mouth = createMouth(h.deps);
    const low = mouth.speak(utt(2, '陪伴一句'));
    await new Promise((resolve) => setImmediate(resolve));
    const high = mouth.speak(utt(5, '他按着说话'));
    await new Promise((resolve) => setImmediate(resolve));
    const lowResult = await low;
    assert.equal(lowResult.interrupted, true);
    assert.equal(lowResult.message, 'preempted');
    await new Promise((resolve) => setImmediate(resolve));
    h.finishPlay();
    assert.equal((await high).ok, true);
  });

  it('3 级对正在说的 3 级只排队，不打断', async () => {
    const h = makeHarness();
    const mouth = createMouth(h.deps);
    const first = mouth.speak(utt(3, '第一句'));
    await new Promise((resolve) => setImmediate(resolve));
    const second = mouth.speak(utt(3, '第二句'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mouth.status().queued, 1);
    h.finishPlay();
    assert.equal((await first).ok, true);
    await new Promise((resolve) => setImmediate(resolve));
    h.finishPlay();
    assert.equal((await second).ok, true);
  });

  it('2 级吵不过 3 级：会排队等', async () => {
    const h = makeHarness();
    const mouth = createMouth(h.deps);
    const chat = mouth.speak(utt(3, '回话'));
    await new Promise((resolve) => setImmediate(resolve));
    void mouth.speak(utt(2, '看到的东西'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mouth.status().queued, 1);
    h.finishPlay();
    assert.equal((await chat).ok, true);
  });
});

describe('嘴：不挂死', () => {
  it('排队太久会过期，并且一定要 resolve', async () => {
    const h = makeHarness();
    const mouth = createMouth(h.deps);
    const first = mouth.speak(utt(3, '长句'));
    await new Promise((resolve) => setImmediate(resolve));
    const queued = mouth.speak(utt(2, '排队那句'));
    await new Promise((resolve) => setImmediate(resolve));
    h.tick(16_000);
    h.finishPlay();
    assert.equal((await first).ok, true);
    const expired = await queued;
    assert.equal(expired.ok, false);
    assert.equal(expired.message, 'expired');
  });

  it('打断时队列里的也要 resolve', async () => {
    const h = makeHarness();
    const mouth = createMouth(h.deps);
    const first = mouth.speak(utt(3, '第一'));
    await new Promise((resolve) => setImmediate(resolve));
    const second = mouth.speak(utt(2, '排队'));
    await new Promise((resolve) => setImmediate(resolve));
    mouth.interrupt('manual');
    assert.equal((await first).interrupted, true);
    assert.equal((await second).interrupted, true);
    assert.equal(mouth.status().speaking, false);
    assert.equal(mouth.status().queued, 0);
  });

  it('dispose 时不留悬空 Promise', async () => {
    const h = makeHarness();
    const mouth = createMouth(h.deps);
    const first = mouth.speak(utt(3, '第一'));
    await new Promise((resolve) => setImmediate(resolve));
    const queued = mouth.speak(utt(2, '排队'));
    await new Promise((resolve) => setImmediate(resolve));
    (mouth as unknown as { dispose: () => void }).dispose();
    assert.equal((await first).ok, false);
    assert.equal((await queued).ok, false);
  });
});