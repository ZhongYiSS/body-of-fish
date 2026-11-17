/**
 * 嘴：身体唯一能出声、也是唯一能写主气泡的地方（第一批）
 *
 * 哥哥 11-17 定：**嘴不管话从哪来**，只按五级规矩决定「先说什么、谁打断谁」。
 * 这一版把 11-15 的 `SpeakCenter` 那套规则（打断 / 老化 / 队列 / 看门狗）搬进来，
 * 但对外只说五级，内部不再有 `low/normal/high/urgent` 四档的老名字。
 *
 * 三条铁律：
 *   1. **只有这里写主气泡**（`deps.writeBubble`），别处一律不许碰 `state.writePet('say')`；
 *   2. 每一条 utterance 都要有结局 —— 说完了、被顶了、过期了、在听被静音了，都得 resolve，
 *      不许让调用方的 `await` 挂死（11-15 的 B1 就是这么挂的）；
 *   3. 在听（麦克风开着）时**既不出声也不冒泡**，产出的「话」由调用方记成「想说没说」。
 *
 * 纯逻辑 + 依赖注入，无全局状态、无 IO，能拿假播放器直接测。
 */

import { canInterrupt, droppableWhenBusy, LEVEL_EXPIRE_MS, MOUTH_QUEUE_MAX } from './level';
import type { Level, Utterance } from './types';

/** 一条在嘴里的活：队列里的和正在说的都用它 */
interface MouthJob {
  utt: Utterance;
  /** 进队时刻，用来老化 */
  enqueuedAt: number;
  /** 轮到它时兑现给调用方 */
  settle: (result: MouthResult) => void;
}

/** 说完（或没轮上）的结果；调用方靠它决定记不记「想说没说」 */
export interface MouthResult {
  ok: boolean;
  /** 没说的原因：listening / busy / expired / preempted / interrupted / synth-failed / shut */
  message?: string;
  /** 被掐掉（不是过期）→ 上层可以记成 thought 下轮带标签 */
  interrupted?: boolean;
}

/** 嘴要干活的全部外部能力，全由宿主注入 */
export interface MouthDeps {
  /** 当前时间（毫秒） */
  now: () => number;
  /** 在听（麦克风正在录）→ 嘴哑巴 */
  isListening: () => boolean;
  /** 合成语音；返回 null 表示这次没声音（合成失败 / provider 没配） */
  synthesize: (text: string, voice: boolean) => Promise<{ audio: Uint8Array; mime: string } | null>;
  /** 真的放出来。`onStart` 在音频真正开始那一刻回调（气泡靠它对齐） */
  play: (audio: Uint8Array, mime: string, epoch: number, onStart: () => void) => Promise<void>;
  /** 掐掉正在放的声音（打断 / 停播） */
  stopPlayback: () => void;
  /** 写主气泡 —— 全身体只在这里调用 */
  writeBubble: (petId: string, text: string, image: string | undefined, durationMs: number) => void;
  /** 收掉主气泡 */
  clearBubble: (petId: string) => void;
  /** 副气泡【在说】开 / 关 */
  lamp: (on: boolean, petId: string) => void;
  /** 一行日志（宿主负责写文件） */
  log: (line: string) => void;
  /** 音频时长（毫秒）；不知道返回 0 */
  audioMs?: (audio: Uint8Array, mime: string) => number;
  /** 合成阶段的上限，默认 30 秒 */
  synthTimeoutMs?: number;
}

export interface MouthStatus {
  speaking: boolean;
  level: Level | null;
  queued: number;
  text: string;
}

export interface Mouth {
  /** 把一句话交给嘴；调用方 await 它拿到结局 */
  speak: (utt: Utterance) => Promise<MouthResult>;
  /** 只要气泡、不出声（桥的「只冒泡」、碎碎念抽卡的静态台词都走这条） */
  show: (utt: Pick<Utterance, 'petId' | 'text' | 'image'>) => void;
  /** 掐掉正在说的 + 清空队列（手动打断 / 在听自动让路 / 关机） */
  interrupt: (reason: string) => void;
  /** 现在的状态（给 /state、菜单、测试用） */
  status: () => MouthStatus;
}

const DEFAULT_SYNTH_TIMEOUT_MS = 30_000;
/** 气泡比声音多留 2 秒，别让字先消失 */
const BUBBLE_TAIL_MS = 2_000;
const BUBBLE_MIN_MS = 3_000;

/** 队列排序：等级高的先，同级先进的先 */
function pickIndex(queue: MouthJob[], now: number): number {
  let best = -1;
  for (let i = 0; i < queue.length; i += 1) {
    if (now - queue[i].enqueuedAt > LEVEL_EXPIRE_MS[queue[i].utt.level]) continue;
    if (best < 0) {
      best = i;
      continue;
    }
    const cand = queue[i];
    const cur = queue[best];
    if (cand.utt.level > cur.utt.level) best = i;
    else if (cand.utt.level === cur.utt.level && cand.enqueuedAt < cur.enqueuedAt) best = i;
  }
  return best;
}

/** 队列满了要挤掉谁：等级最低、同级最老的；5 级永远不挤 */
function worstIndex(queue: MouthJob[]): number {
  let worst = -1;
  for (let i = 0; i < queue.length; i += 1) {
    if (queue[i].utt.level >= 5) continue;
    if (worst < 0) {
      worst = i;
      continue;
    }
    const cand = queue[i];
    const cur = queue[worst];
    if (cand.utt.level < cur.utt.level) worst = i;
    else if (cand.utt.level === cur.utt.level && cand.enqueuedAt >= cur.enqueuedAt) worst = i;
  }
  return worst;
}

export function createMouth(deps: MouthDeps): Mouth {
  let epoch = 0;
  let active: MouthJob | null = null;
  let activeStartedAt = 0;
  let activeGuard: ReturnType<typeof setTimeout> | null = null;
  let queue: MouthJob[] = [];
  let pumping = false;
  let disposed = false;

  const synthTimeoutMs = deps.synthTimeoutMs ?? DEFAULT_SYNTH_TIMEOUT_MS;

  const log = (line: string): void => deps.log(`mouth ${line}`);

  const clearGuard = (): void => {
    if (activeGuard !== null) {
      clearTimeout(activeGuard);
      activeGuard = null;
    }
  };

  /**
   * 老任务的收尾：只有**它还占着 active** 时才许收。
   * 否则会出现「上一句被顶掉、它慢一拍回来把新的一句也收掉」——11-15 那类挂死/吞句就是这么来的。
   */
  const settleIfActive = (job: MouthJob, result: MouthResult): void => {
    if (active !== job) return;
    finishActive(result);
  };

  const finishActive = (result: MouthResult): void => {
    const job = active;
    if (job === null) return;
    active = null;
    clearGuard();
    deps.lamp(false, job.utt.petId);
    try {
      job.settle(result);
    } catch {
      // settle 是 Promise 的 resolve，不该抛；真抛了也不许拖住下一句
    }
  };

  /** 把一条挤出去：一定要 settle，否则调用方永远挂着（11-15 的 B1） */
  const dropJob = (job: MouthJob, result: MouthResult): void => {
    log(`drop face=${job.utt.session} level=${job.utt.level} why=${result.message ?? '?'} chars=${job.utt.text.length}`);
    try {
      job.settle(result);
    } catch {
      // 同上
    }
  };

  const expireQueue = (now: number): void => {
    const alive: MouthJob[] = [];
    for (const job of queue) {
      if (now - job.enqueuedAt > LEVEL_EXPIRE_MS[job.utt.level]) {
        dropJob(job, { ok: false, message: 'expired' });
      } else {
        alive.push(job);
      }
    }
    queue = alive;
  };

  const stopEverything = (reason: string, keepQueue: boolean): number => {
    epoch += 1;
    deps.stopPlayback();
    const dropped = keepQueue ? 0 : queue.length;
    if (!keepQueue) {
      const gone = queue;
      queue = [];
      for (const job of gone) dropJob(job, { ok: false, interrupted: true, message: reason });
    }
    if (active !== null) {
      const job = active;
      finishActive({ ok: false, interrupted: true, message: reason });
      deps.clearBubble(job.utt.petId);
    }
    return dropped;
  };

  const runJob = async (job: MouthJob): Promise<void> => {
    const { utt } = job;
    active = job;
    activeStartedAt = deps.now();
    epoch += 1;
    const myEpoch = epoch;
    deps.lamp(true, utt.petId);

    const synthBudget = Math.min(
      60_000,
      Math.max(15_000, 4_000 + utt.text.length * 250),
    );
    const guardMs = utt.kind === 'clip' ? 60_000 : synthBudget + 30_000;
    activeGuard = setTimeout(() => {
      if (active !== job) return;
      log(`guard fire face=${utt.session} level=${utt.level} cost=${deps.now() - activeStartedAt}ms`);
      deps.stopPlayback();
      deps.clearBubble(utt.petId);
      finishActive({ ok: false, message: 'timeout' });
      void pump();
    }, guardMs);
    activeGuard.unref?.();

    try {
      let audio = utt.audio;
      let mime = utt.mime ?? 'audio/wav';

      if (utt.kind === 'say') {
        const synthStart = deps.now();
        const synth = await deps.synthesize(utt.text, true);
        if (myEpoch !== epoch) {
          settleIfActive(job, { ok: false, interrupted: true, message: 'preempted' });
          return;
        }
        if (synth === null) {
          log(`synth-none face=${utt.session} level=${utt.level} cost=${deps.now() - synthStart}ms`);
          // 没声音也要把字说出来 —— 这条路以前就是「只写字没声」
          writeBubbleNow(utt, 0);
          settleIfActive(job, { ok: false, message: 'synth-failed' });
          return;
        }
        audio = synth.audio;
        mime = synth.mime;
        log(`synth-ok face=${utt.session} level=${utt.level} cost=${deps.now() - synthStart}ms bytes=${audio.length}`);
      }

      if (audio === undefined) {
        writeBubbleNow(utt, 0);
        settleIfActive(job, { ok: false, message: 'no-audio' });
        return;
      }

      const durMs = deps.audioMs?.(audio, mime) ?? 0;
      await deps.play(audio, mime, myEpoch, () => {
        // 声音真的开始了才冒泡：字和声同一个起点（11-16 哥哥报的「配合不默契」）
        if (myEpoch !== epoch) return;
        writeBubbleNow(utt, durMs);
      });
      if (myEpoch !== epoch) {
        settleIfActive(job, { ok: false, interrupted: true, message: 'preempted' });
        return;
      }
      log(`done face=${utt.session} level=${utt.level} cost=${deps.now() - activeStartedAt}ms`);
      settleIfActive(job, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`fail face=${utt.session} level=${utt.level} err=${message.slice(0, 120)}`);
      writeBubbleNow(utt, 0);
      settleIfActive(job, { ok: false, message: 'play-failed' });
    }
  };

  const writeBubbleNow = (utt: Utterance, audioMs: number): void => {
    const dur = Math.max(BUBBLE_MIN_MS, (audioMs > 0 ? audioMs : 0) + BUBBLE_TAIL_MS);
    deps.writeBubble(utt.petId, utt.text, utt.image, dur);
  };

  async function pump(): Promise<void> {
    if (pumping || disposed) return;
    pumping = true;
    try {
      for (;;) {
        if (active !== null) return;
        const now = deps.now();
        expireQueue(now);
        const index = pickIndex(queue, now);
        if (index < 0) {
          queue = queue.filter((job) => now - job.enqueuedAt <= LEVEL_EXPIRE_MS[job.utt.level]);
          return;
        }
        const [job] = queue.splice(index, 1);
        await runJob(job);
      }
    } finally {
      pumping = false;
    }
  }

  const speak = (utt: Utterance): Promise<MouthResult> =>
    new Promise<MouthResult>((resolve) => {
      if (disposed) {
        resolve({ ok: false, message: 'shut' });
        return;
      }
      if (deps.isListening()) {
        log(`mute face=${utt.session} level=${utt.level} why=listening chars=${utt.text.length}`);
        resolve({ ok: false, message: 'listening' });
        return;
      }
      const job: MouthJob = { utt, enqueuedAt: deps.now(), settle: resolve };

      // 嘴空着：直接说（2~5 级都不排队 —— 及时性优先）
      if (active === null && queue.length === 0) {
        void (async () => {
          // runJob 内部会自己 settle
          await runJob(job);
          void pump();
        })();
        return;
      }

      // 嘴忙：1 级直接丢，2~5 级先看能不能插队
      if (droppableWhenBusy(utt.level) && active !== null) {
        log(`busy-drop face=${utt.session} level=${utt.level} chars=${utt.text.length}`);
        resolve({ ok: false, message: 'busy' });
        return;
      }

      if (active !== null && canInterrupt(utt.level, active.utt.level, 'speaking')) {
        const victim = active;
        log(`preempt by=${utt.level} victim=${victim.utt.level} face=${utt.session}`);
        epoch += 1;
        deps.stopPlayback();
        deps.clearBubble(victim.utt.petId);
        finishActive({ ok: false, interrupted: true, message: 'preempted' });
      }

      // 同一条话只留一份
      const dup = queue.findIndex((item) => item.utt.id === utt.id);
      if (dup >= 0) {
        const old = queue[dup];
        queue.splice(dup, 1);
        dropJob(old, { ok: false, message: 'duplicate' });
      }

      if (utt.level >= 5) {
        // 5 级来了，还没开播的低等级一律作废（他按下按钮就该立刻听到）
        const keep: MouthJob[] = [];
        for (const item of queue) {
          if (canInterrupt(5, item.utt.level, 'queued')) {
            dropJob(item, { ok: false, interrupted: true, message: 'preempted' });
          } else {
            keep.push(item);
          }
        }
        queue = keep;
      }

      queue.push(job);
      while (queue.length > MOUTH_QUEUE_MAX) {
        const worst = worstIndex(queue);
        if (worst < 0) break;
        const [gone] = queue.splice(worst, 1);
        dropJob(gone, { ok: false, message: 'queue-full' });
        if (gone === job) return;
      }
      void pump();
    });

  const show = (utt: Pick<Utterance, 'petId' | 'text' | 'image'>): void => {
    if (disposed) return;
    if (deps.isListening()) {
      log(`show-mute pet=${utt.petId} chars=${utt.text.length}`);
      return;
    }
    deps.writeBubble(utt.petId, utt.text, utt.image, BUBBLE_MIN_MS + BUBBLE_TAIL_MS);
  };

  const interrupt = (reason: string): void => {
    const dropped = stopEverything(reason, false);
    log(`interrupt why=${reason} dropped=${dropped}`);
  };

  const status = (): MouthStatus => ({
    speaking: active !== null,
    level: active === null ? null : active.utt.level,
    queued: queue.length,
    text: active === null ? '' : active.utt.text,
  });

  return {
    speak,
    show,
    interrupt,
    status,
    /** 内部用：销毁时把队列全部作废（不给调用方挂死） */
    dispose: () => {
      disposed = true;
      stopEverything('shut', false);
      clearGuard();
    },
  } as Mouth & { dispose: () => void };
}