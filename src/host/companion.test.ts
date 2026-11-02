/**
 * 陪伴模式编排层的单测：**不截屏、不起进程、不联网**，所有副作用全走注入的假函数。
 *
 * 要钉死的语义：
 *   ① 画面变了才调 look；look 的结论进 bubble；
 *   ② 画面没变累计 idle，到 idleStopAfter 就 stop（返回 stopped、running=false）；
 *   ③ 画面一变 idle 归零；
 *   ④ voice 开关 + speak/play 才出声；
 *   ⑤ look 出错不弄死循环，连续 3 次才停；
 *   ⑥ pickMeme 的名字要跟着 bubble 的 {image} 走；
 *   ⑦ stop() 之后 tickOnce 一律 skipped，在途的识图结果也不许再冒泡。
 *
 * 用 Node 内置 test runner（node:test），风格照 `src/host/core/connection.test.ts`。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANGE_THRESHOLD,
  createCompanion,
  DEFAULT_PROMPT,
  MAX_LOOK_FAILURES,
  THUMB_BYTES,
  type CompanionConfig,
  type CompanionDeps,
} from './companion.ts';

/** 一帧 64×36 纯色灰度；两个灰度用得够远，保证差异超过 PIXEL_DELTA。 */
function frame(gray: number): Uint8Array {
  return new Uint8Array(THUMB_BYTES).fill(gray);
}

/** speak 的默认返回值：内容无所谓，只要求"同一段音频"能原样传到 play。 */
const AUDIO = new Uint8Array([1, 2, 3, 4]);

interface HarnessOptions {
  /** 依次返回的截图；用完就重复最后一张。 */
  frames?: Uint8Array[];
  look?: (image: Uint8Array, prompt: string) => Promise<string>;
  speak?: (text: string) => Promise<Uint8Array>;
  play?: (audio: Uint8Array) => Promise<void>;
  pickMeme?: () => string | undefined;
  config?: CompanionConfig;
}

interface Harness {
  calls: {
    captures: number;
    looks: Array<{ image: Uint8Array; prompt: string }>;
    bubbles: Array<{ text: string; opts?: { image?: string } }>;
    speaks: string[];
    plays: Uint8Array[];
    memes: number;
  };
  deps: CompanionDeps;
}

/** 造一套"只记录、不产生真实副作用"的依赖。 */
function harness(options: HarnessOptions = {}): Harness {
  const frames = options.frames ?? [frame(0)];
  const calls: Harness['calls'] = {
    captures: 0,
    looks: [],
    bubbles: [],
    speaks: [],
    plays: [],
    memes: 0,
  };
  let shotIndex = 0;

  const deps: CompanionDeps = {
    capture: async () => {
      calls.captures += 1;
      const shot = frames[Math.min(shotIndex, frames.length - 1)];
      shotIndex += 1;
      return shot;
    },
    look: async (image, prompt) => {
      calls.looks.push({ image, prompt });
      if (options.look) return options.look(image, prompt);
      return '在写代码呀';
    },
    bubble: async (text, opts) => {
      calls.bubbles.push({ text, opts });
    },
    speak: async (text) => {
      calls.speaks.push(text);
      return options.speak ? options.speak(text) : AUDIO;
    },
    play: async (audio) => {
      calls.plays.push(audio);
      if (options.play) await options.play(audio);
    },
    // 测试里日志一律哑掉；要看日志的用例自己注入
    log: () => {},
    // 间隔给足，避免真的 timer 在测试中途插进来；需要定时器的用例自己 tick
    config: { intervalMs: 60_000, ...options.config },
  };

  if (options.pickMeme) {
    const pick = options.pickMeme;
    deps.pickMeme = () => {
      calls.memes += 1;
      return pick();
    };
  }

  return { calls, deps };
}

describe('companion —— 一轮的语义', () => {
  test('画面变了 → 调 look + bubble，返回 changed', async () => {
    const { calls, deps } = harness();
    const pet = createCompanion(deps);

    assert.equal(await pet.tickOnce(), 'changed');
    assert.equal(calls.captures, 1);
    assert.equal(calls.looks.length, 1);
    assert.equal(calls.looks[0].prompt, DEFAULT_PROMPT, '默认看图指令要原样传下去');
    assert.equal(calls.bubbles.length, 1);
    assert.equal(calls.bubbles[0].text, '在写代码呀');
    assert.equal(calls.bubbles[0].opts, undefined, '没挑表情就不带 image');
    // 没 start 也能跑单拍，但只是跑一拍，不该自己起循环
    assert.deepEqual(pet.status(), { running: false, ticks: 1, idle: 0 });
  });

  test('画面没变 1 次 → same；到 idleStopAfter 次 → stopped 且 running=false', async () => {
    // 第一张没有上一张可比，算 changed；之后一直同一张 → same
    const { calls, deps } = harness({ frames: [frame(0)] });
    const pet = createCompanion(deps);
    pet.start();

    assert.equal(await pet.tickOnce(), 'changed');
    assert.equal(await pet.tickOnce(), 'same');
    assert.deepEqual(pet.status(), { running: true, ticks: 2, idle: 1 });

    // idleStopAfter 默认 2：这是第 2 次"没变"，到线自己关
    assert.equal(await pet.tickOnce(), 'stopped');
    assert.deepEqual(pet.status(), { running: false, ticks: 3, idle: 2 });
    assert.equal(pet.status().running, false);
    assert.equal(calls.looks.length, 1, '画面没变不该再花一次识图');
  });

  test('同一次运行里，画面一变 idle 就归零', async () => {
    const { calls, deps } = harness({ frames: [frame(0), frame(0), frame(255)] });
    const pet = createCompanion(deps);
    pet.start();
    try {
      assert.equal(await pet.tickOnce(), 'changed');
      assert.equal(await pet.tickOnce(), 'same');
      assert.equal(pet.status().idle, 1);

      assert.equal(await pet.tickOnce(), 'changed');
      assert.equal(pet.status().idle, 0, '画面变了，连续没变的计数必须清零');
      assert.equal(calls.looks.length, 2, '两次 changed 各看一次');
    } finally {
      pet.stop();
    }
  });

  test('变化像素占比必须到 2% 才算变（旧版阈值原样保留）', async () => {
    const base = frame(0);
    const need = Math.ceil(CHANGE_THRESHOLD * THUMB_BYTES); // 2304 * 0.02 = 46.08 → 47

    // 下面两段各自和纯色 base 比：一段 46 格（不到 2%），一段 47 格（过线）。
    // 不能放进同一串帧里——那样第二段比的是"46 格那张"，两帧只差 1 格。
    const below = frame(0);
    for (let i = 0; i < need - 1; i++) below[i] = 255; // 46/2304 ≈ 1.996%
    const belowRun = harness({ frames: [base, below] });
    const belowPet = createCompanion(belowRun.deps);
    belowPet.start();
    try {
      assert.equal(await belowPet.tickOnce(), 'changed');
      assert.equal(await belowPet.tickOnce(), 'same', '46/2304 ≈ 1.996%，不到 2%');
      assert.equal(belowRun.calls.looks.length, 1);
    } finally {
      belowPet.stop();
    }

    const above = frame(0);
    for (let i = 0; i < need; i++) above[i] = 255; // 47/2304 ≈ 2.04%
    const aboveRun = harness({ frames: [base, above] });
    const abovePet = createCompanion(aboveRun.deps);
    abovePet.start();
    try {
      assert.equal(await abovePet.tickOnce(), 'changed');
      assert.equal(await abovePet.tickOnce(), 'changed', '47/2304 ≈ 2.04%，过线');
      assert.equal(aboveRun.calls.looks.length, 2);
    } finally {
      abovePet.stop();
    }
  });
});

describe('companion —— 出声', () => {
  test('voice:true 且 speak/play 都在 → 调 play 并拿到同一段音频', async () => {
    const spoken = new Uint8Array([7, 8, 9]);
    const { calls, deps } = harness({ speak: async () => spoken, config: { voice: true } });
    const pet = createCompanion(deps);

    assert.equal(await pet.tickOnce(), 'changed');
    assert.equal(calls.bubbles.length, 1, '先冒泡再出声');
    assert.equal(calls.speaks.length, 1);
    assert.equal(calls.speaks[0], '在写代码呀');
    assert.equal(calls.plays.length, 1);
    assert.equal(calls.plays[0], spoken, 'play 必须收到 speak 给的那一段，不能是空音频');
  });

  test('voice:false（默认）→ speak / play 一次都不调', async () => {
    const { calls, deps } = harness();
    const pet = createCompanion(deps);

    assert.equal(await pet.tickOnce(), 'changed');
    assert.equal(calls.bubbles.length, 1);
    assert.equal(calls.speaks.length, 0);
    assert.equal(calls.plays.length, 0);
  });
});

describe('companion —— 出错与收尾', () => {
  test('look 抛错不影响循环，连续 3 次才自动停', async () => {
    const { calls, deps } = harness({
      // 每张都和上一张不同，保证每一拍都真的去 look
      frames: [frame(0), frame(255), frame(0), frame(255)],
      look: async () => {
        throw new Error('识图接口 500');
      },
    });
    const pet = createCompanion(deps);
    pet.start();

    assert.equal(MAX_LOOK_FAILURES, 3, '自动停的线就是连续 3 次');
    assert.equal(await pet.tickOnce(), 'changed', '一次失败只记日志，不算停');
    assert.equal(pet.status().running, true);
    assert.equal(calls.looks.length, 1);

    // 下一轮照跑：截图、look 都还要继续
    assert.equal(await pet.tickOnce(), 'changed');
    assert.equal(pet.status().running, true);
    assert.equal(calls.looks.length, 2);
    assert.equal(calls.captures, 2);

    assert.equal(await pet.tickOnce(), 'stopped');
    assert.equal(pet.status().running, false);
    assert.equal(calls.looks.length, 3);
    assert.equal(calls.captures, 3);
  });

  test('pickMeme 有返回值时 bubble 收到 {image: 名字}', async () => {
    const { calls, deps } = harness({ pickMeme: () => '得意' });
    const pet = createCompanion(deps);

    assert.equal(await pet.tickOnce(), 'changed');
    assert.equal(calls.memes, 1);
    assert.deepEqual(calls.bubbles[0].opts, { image: '得意' });
  });

  test('stop() 后 tickOnce() 返回 skipped，且不再截图', async () => {
    const { calls, deps } = harness();
    const pet = createCompanion(deps);
    pet.stop();

    assert.equal(await pet.tickOnce(), 'skipped');
    assert.equal(calls.captures, 0);
    assert.equal(pet.status().running, false);
  });

  test('stop() 会让在途的那一拍作废：迟到的识图结果不再冒泡', async () => {
    let release!: (text: string) => void;
    const { calls, deps } = harness({
      look: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });
    const pet = createCompanion(deps);

    const pending = pet.tickOnce();
    // 让 capture → look 一路走到"卡在 look 上"
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.looks.length, 1);

    pet.stop();
    release('这句来得太迟了');
    assert.equal(await pending, 'skipped');
    assert.equal(calls.bubbles.length, 0, '停了以后绝不能再冒泡');
    assert.equal(await pet.tickOnce(), 'skipped');
  });
});
