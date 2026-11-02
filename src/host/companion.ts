/**
 * 陪伴模式（host 半侧）：定时看一眼屏幕，画面变了就用本鱼的语气陪一句。
 *
 * 这是从旧插件 `dsh-pet-extras/lib/modules/companion.js`（2048 行）搬过来的**编排层**，
 * 只保留"陪伴"这一条主线：
 *
 *   定时截图 → 缩到 64×36 灰度算指纹 → 和上一张比 → 变了才看图说 1–3 句
 *   → 冒气泡 +（可选）配表情包 →（可选）出声 → 连续几次没变就自己关。
 *
 * 和旧版最大的区别：旧版靠 `POST /dsh-pet-7340/broadcast`、`D:\AI\工具箱\识图.py`、
 * `说话.py` + `ffmpeg.exe` 这些**脚本和 HTTP 回环**往外走；新版把所有副作用（截屏、识图、
 * 冒泡、出声、放音、挑表情）都变成 `CompanionDeps` 里注入的函数，自己**不碰网络、不碰文件**
 * （默认的截屏/放音实现除外，它们只在调用方不注入时兜底）。这样宿主可以把它接到
 * `services.bubble.say`、`services.eyes.look`、`services.voice.speak` 上，测试也能全用假的。
 *
 * 铁律：
 *   1. 不许 import src/shared（DSH 单文件加载会拆 chunk）。
 *   2. 模块顶层不启动任何 timer；`start()` 才起，`stop()` 必须收干净。
 *   3. 任何一步出错都不许把循环弄死；`look` 连续失败 3 次才主动停（别对着坏接口空转）。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 缩略图宽度：64 格。旧版一直用这个尺寸，指纹就是 64×36 的灰度字节。 */
export const THUMB_WIDTH = 64;
/** 缩略图高度：36 格。 */
export const THUMB_HEIGHT = 36;
/** 一帧灰度缩略图的字节数：64×36 = 2304。 */
export const THUMB_BYTES = THUMB_WIDTH * THUMB_HEIGHT;

/**
 * 单个像素"算不算变了"的灰度差门槛：|a-b| > 10 才算。
 *
 * 为什么是 10：缩放、JPEG 压缩、字幕抗锯齿、渐变壁纸都会让同一点在两次截图里差个几级灰度；
 * 差 1–10 的像素基本都是噪声。若直接对整屏求平均绝对差，一点点整体亮度漂移就能把均值
 * 抬高、误报"画面变了"，于是每拍都白花一次识图 token。用"超过 10 的像素占比"更稳。
 */
export const PIXEL_DELTA = 10;

/**
 * 画面变化阈值：变化的像素占比 ≥ 2% 才算真的变了。
 *
 * 旧版 `changeThreshold` 默认就是 0.02，设置页也写着"0.02 = 2% 像素"。为什么是 2%：
 * 64×36 = 2304 格里约 46 格真的变了才算画面变了——鼠标动一下、光标闪一下
 * （缩到 64×36 后往往不到 1 格）不会触发一次识图；而切窗口、翻页、打字打出一行
 * 都会轻松超过 46 格。这是"省 token"和"别漏看"之间的折中。
 */
export const CHANGE_THRESHOLD = 0.02;

/** 默认看屏幕的间隔：15 秒。 */
export const DEFAULT_INTERVAL_MS = 15_000;

/** 默认连续几次画面没变就自动歇：10 次（本鱼 11-02 从 2 调大——2 次太短，哥哥刚觉得「陪伴没声音」它自己就停了）。 */
export const DEFAULT_IDLE_STOP_AFTER = 10;

/** 默认看图指令：短、口语、像在旁边陪人。 */
export const DEFAULT_PROMPT = '看图说一到两句，20 字以内，像在旁边陪人。';

/**
 * `look` 连续失败几次就自动停。
 *
 * 为什么是 3：偶发一次超时/429 很常见，立刻停太脆；但连续 3 次都失败说明接口、
 * key 或本地服务真的坏了，再定时打下去只是空转、刷错误日志，所以主动停。
 */
export const MAX_LOOK_FAILURES = 3;

export interface CompanionConfig {
  /** 看屏幕的间隔（毫秒），默认 15000。 */
  intervalMs?: number;
  /** 连续几次画面没变就自动关，默认 2。 */
  idleStopAfter?: number;
  /** 要不要出声，默认 false（旧版默认是机器音，新版默认安静，避免吓人）。 */
  voice?: boolean;
  /** 看图指令，默认「看图说一到两句，20 字以内，像在旁边陪人。」 */
  prompt?: string;
}

export interface CompanionDeps {
  /**
   * 截一张当前屏幕的**指纹字节**：必须是 64×36 灰度 rawvideo（2304 字节）。
   *
   * 不传时用 `defaultCapture()`：ffmpeg gdigrab 抓全屏、直接缩到 64×36 灰度。
   * 注意：鉴图用的是同一份字节，所以调用方若要给模型看高清图，应该在包装
   * `look` 时自己再截一张，或让默认实现同时返回；见下方 `defaultCapture` 的注释。
   */
  capture?(): Promise<Uint8Array>;
  /**
   * 看图说一句（由网关的 eyes.look 包装进来）。
   *
   * 注意：收到的是 `capture()` 那一份字节，默认实现下就是 64×36 灰度指纹（2304 字节），
   * 不是能直接给人看的高清图。识图后端要看清屏幕的话，包装层得自己再截一张；
   * 这个接口只保证"看的是同一时刻的那块屏幕"，不替调用方管图片格式。
   */
  look(image: Uint8Array, prompt: string): Promise<string>;
  /** 冒一个气泡（由 services.bubble.say 包装）。 */
  bubble(text: string, opts?: { image?: string }): Promise<void>;
  /** 出声（可缺省；由 services.voice.speak 包装）。 */
  speak?(text: string): Promise<Uint8Array>;
  /**
   * 把音频放出来（可缺省）。
   * 不传时用 `defaultPlay()`：写临时文件 + ffplay。
   */
  play?(audio: Uint8Array): Promise<void>;
  /** 抽一张表情包名（可缺省；由 memes 池给）。 */
  pickMeme?(): string | undefined;
  /** 取当前时间（毫秒）；目前只用于未来扩展与测试，默认 Date.now。 */
  now?(): number;
  /** 记日志；默认 console.log。 */
  log?: (message: string) => void;
  /** 陪伴配置。 */
  config?: CompanionConfig;
}

/** 这一轮发生了什么。 */
export type CompanionTickResult = 'changed' | 'same' | 'stopped' | 'skipped';

export interface CompanionHandle {
  start(): void;
  stop(): void;
  /** 跑一轮（测试用）：返回这一轮发生了什么 */
  tickOnce(): Promise<CompanionTickResult>;
  status(): { running: boolean; ticks: number; idle: number };
}

/**
 * 默认截图：ffmpeg 抓全屏，缩到 64×36 灰度原始字节。
 *
 * 等价命令（旧版是两步：先存 raw.png，再缩；这里一步用管道，少碰两次磁盘）：
 *
 *   ffmpeg -hide_banner -loglevel error \
 *     -f gdigrab -framerate 1 -i desktop -frames:v 1 \
 *     -vf "scale=64:36,format=gray" \
 *     -f rawvideo -pix_fmt gray pipe:1
 *
 * 为什么用 ffmpeg 的 gdigrab、不用 PowerShell：旧版踩过 `capture.ps1` 被 AMSI 判成
 * 恶意脚本（ScriptContainedMaliciousContent），而且 %TEMP% 下 ffmpeg 有时写不进文件。
 * 走 stdout 管道既绕开临时文件，也避开杀软。
 *
 * 为什么直接缩到 64×36：指纹只需要 2304 字节，原图不进内存；识图那张高清图由
 * 调用方在包装 `look` 时另截（网关的 eyes.look 收的是图片字节，不是 64×36 灰度）。
 *
 * 默认找 `D:\AI\GPT-SoVITS\ffmpeg.exe`（家里一直用的那套）；可用环境变量
 * `DSH_PET_FFMPEG` 覆盖成别的路径。**测试不要调用它**——一律注入假的 `capture`。
 */
export function defaultCapture(): Promise<Uint8Array> {
  const ffmpeg = process.env.DSH_PET_FFMPEG?.trim() || 'D:\\AI\\GPT-SoVITS\\ffmpeg.exe';
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'gdigrab',
    '-framerate',
    '1',
    '-i',
    'desktop',
    '-frames:v',
    '1',
    '-vf',
    'scale=64:36,format=gray',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ];

  return new Promise<Uint8Array>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      // 只留最后一段给人看；ffmpeg 出错时通常真正的原因在末尾
      stderr = (stderr + String(chunk)).slice(-400);
    });
    child.once('error', (error) => {
      reject(new Error('起不来 ffmpeg（' + ffmpeg + '）：' + error.message));
    });
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error('ffmpeg 抓屏失败（退出码 ' + code + '）：' + stderr.slice(0, 200)));
        return;
      }
      const out = Buffer.concat(chunks);
      if (out.length < THUMB_BYTES) {
        reject(new Error('ffmpeg 只给了 ' + out.length + ' 字节，不够一帧 64×36 灰度'));
        return;
      }
      // 只取第一帧：-frames:v 1 正常就一帧，多出来的（理论上没有）丢掉，保证指纹长度固定
      resolve(out.subarray(0, THUMB_BYTES));
    });
  });
}

/**
 * 默认放音：把音频写进临时目录，用 ffplay 放出，放完删文件。
 *
 * 为什么写临时文件：ffplay 不能从 stdin 稳定吃裸字节流（旧版也试过，音频一坏就静默退出），
 * 写文件最稳；临时目录每次新建，避免两次说话互相覆盖。
 *
 * 默认找 PATH 里的 `ffplay`，可用 `DSH_PET_FFPLAY` 覆盖。旧版家里真正带 ffplay 的是
 * RVC 那套（GPT-SoVITS 目录只有 ffmpeg）；宿主接线时最好显式传 `play`，别依赖 PATH。
 *
 * **测试不要调用它**——一律注入假的 `play`，否则会真起进程。
 */
export async function defaultPlay(audio: Uint8Array): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pet-voice-'));
  // GPT-SoVITS 回来的是 wav；ffplay 其实按内容探测格式，扩展名只是给人看的
  const file = join(dir, 'say.wav');
  await writeFile(file, audio);

  try {
    await new Promise<void>((resolve, reject) => {
      const ffplay = process.env.DSH_PET_FFPLAY?.trim() || 'ffplay';
      const child = spawn(
        ffplay,
        ['-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit', '-i', file],
        { windowsHide: true, stdio: 'ignore' },
      );
      child.once('error', (error) => {
        reject(new Error('起不来 ffplay（' + ffplay + '）：' + error.message));
      });
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('ffplay 退出码 ' + code));
      });
    });
  } finally {
    // 放完就删；删不掉也只是留个临时文件，不该影响下一拍
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 把任何 thrown 值变成一句能写进日志的话。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 和上一张比：画面到底变了没有。
 *
 * 算法与旧版 `diffRatio` 一致（不是严谨的"平均绝对差"，而是**变化像素占比**）：
 *   1. 逐像素算 |a-b|，超过 `PIXEL_DELTA`（10）记作这个像素"动了"；
 *   2. "动了"的像素数 / 总像素数 ≥ `CHANGE_THRESHOLD`（2%）→ 判为变了。
 *
 * 为什么用占比而不是平均绝对差：见 `PIXEL_DELTA` / `CHANGE_THRESHOLD` 的注释——
 * 整屏亮度漂移会把平均差整体抬高，占比只关心"真的有多少格变了"，更适合判断
 * "哥哥是不是切了窗口/翻了页"。长度不一致（第一次、或调用方给错）一律当变了。
 */
function frameChanged(next: Uint8Array, prev: Uint8Array | null): boolean {
  if (!prev || next.length !== prev.length) return true;
  if (next.length === 0) return false;
  let changed = 0;
  for (let i = 0; i < next.length; i++) {
    if (Math.abs(next[i] - prev[i]) > PIXEL_DELTA) changed += 1;
  }
  return changed / next.length >= CHANGE_THRESHOLD;
}

/** 把配置里的脏值收敛成能用的值；非法值一律退回默认，绝不让 0 间隔把循环打成空转。 */
function resolveConfig(config: CompanionConfig | undefined): Required<CompanionConfig> {
  const interval = Number(config?.intervalMs);
  const idleStop = Number(config?.idleStopAfter);
  const prompt = typeof config?.prompt === 'string' ? config.prompt.trim() : '';
  return {
    intervalMs: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_MS,
    idleStopAfter:
      Number.isFinite(idleStop) && idleStop >= 1 ? Math.floor(idleStop) : DEFAULT_IDLE_STOP_AFTER,
    voice: config?.voice === true,
    prompt: prompt.length > 0 ? prompt : DEFAULT_PROMPT,
  };
}

/**
 * 造一个陪伴器。它只做编排：截屏、识图、冒泡、出声、放音、挑表情全部来自 `deps`。
 *
 * 生命周期：
 *   - `start()` 起一个 `setTimeout` 自调度的循环（**模块顶层没有 timer**），重复调用无副作用；
 *   - `stop()` 清掉 timer 并让在途的那一拍作废（用 generation 令牌挡住迟到的气泡/声音）；
 *   - `tickOnce()` 是给测试用的单拍入口：没 `start()` 也能跑，但 `stop()` 之后一律 `'skipped'`。
 */
export function createCompanion(deps: CompanionDeps): CompanionHandle {
  const cfg = resolveConfig(deps.config);
  const capture = deps.capture ?? defaultCapture;
  const play = deps.play ?? defaultPlay;

  // 日志本身也可能被注入成会抛的函数；日志炸了不能把陪伴炸死
  const log = (message: string): void => {
    try {
      (deps.log ?? console.log)(`[companion] ${message}`);
    } catch {
      // 记日志失败没有第二层兜底，ignore
    }
  };

  let running = false;
  /** 被 `stop()` 显式停过；此时 `tickOnce()` 必须回 `'skipped'` */
  let stopped = false;
  let ticks = 0;
  /** 连续"画面没变"的次数；画面一变就归零 */
  let idle = 0;
  /** `look` 连续失败次数；成功一次就归零 */
  let lookFailures = 0;
  /** 同一时刻只跑一拍：截图/识图很慢，叠起来会双倍花 token 也可能双倍冒泡 */
  let busy = false;
  /**
   * 运行代号：`stop()` 与 `start()` 都会 +1。
   * 每一拍开始时记下自己的代号，任何 await 回来先对一下——对不上说明中途被停过/重启过，
   * 立刻收手，绝不在 `stop()` 之后还冒泡或出声。
   */
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 上一张指纹；第一次没有 → 视为"变了"（和旧版 `prevThumb = null` 一致） */
  let prevThumb: Uint8Array | null = null;

  /** 自调度：这一拍跑完再排下一拍，不叠加；`stop()` 之后不再排。 */
  function schedule(): void {
    if (!running) return;
    const scheduledFor = generation;
    const handle = setTimeout(() => {
      timer = undefined;
      void (async () => {
        try {
          await tickOnce();
        } catch (error) {
          // tickOnce 内部已兜住每一步；这里只是最后一道保险，防止未预期的 rejection
          log('这一拍出了没预料到的错：' + errorText(error));
        } finally {
          // 关键：只有还在同一次运行里才续排。stop() 后 restart 会换代号，
          // 旧回调若此时才回来，不能再排一个 timer（会变成两个循环）。
          if (running && scheduledFor === generation) schedule();
        }
      })();
    }, cfg.intervalMs);
    // 桌宠宿主自己会一直活着；timer 不该单独把进程吊住（测试里尤其明显）
    handle.unref?.();
    timer = handle;
  }

  function stop(): void {
    const wasRunning = running;
    running = false;
    stopped = true;
    // 换代号：在途的截图/识图/出声回来时会发现代号对不上，不再产生副作用
    generation += 1;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (wasRunning) log('陪伴停下');
  }

  function start(): void {
    // 幂等：已经在跑就什么都不做，避免叠出第二个 timer
    if (running) return;
    running = true;
    stopped = false;
    idle = 0;
    lookFailures = 0;
    // 与旧的 stop 划清界限：上一轮在途的拍子不许再续排/再冒泡
    generation += 1;
    log(`开始陪伴（每 ${Math.round(cfg.intervalMs / 1000)} 秒看一眼，连续 ${cfg.idleStopAfter} 次没变就歇）`);
    schedule();
  }

  async function tickOnce(): Promise<CompanionTickResult> {
    if (stopped) return 'skipped';
    if (busy) return 'skipped';

    busy = true;
    ticks += 1;
    const myGeneration = generation;
    try {
      // ── 1. 截屏 ───────────────────────────────────────────────────────
      let shot: Uint8Array;
      try {
        shot = await capture();
      } catch (error) {
        // 截不到屏 ≠ 画面没变：不累计 idle，也不调 look；记一顿继续下一拍
        log('截图失败，这一拍跳过：' + errorText(error));
        return 'same';
      }
      if (myGeneration !== generation) return 'skipped';
      if (shot.length < THUMB_BYTES) {
        // 长度不对时 frameChanged 会当"变了"，但拿这种字节去识图多半也是坏图，直接跳过
        log(`截图只有 ${shot.length} 字节（应 ≥ ${THUMB_BYTES}），这一拍跳过`);
        return 'same';
      }

      // ── 2. 比指纹 ─────────────────────────────────────────────────────
      const changed = frameChanged(shot, prevThumb);
      prevThumb = shot;

      if (!changed) {
        idle += 1;
        if (idle >= cfg.idleStopAfter) {
          // 旧版到线就直接关计时器：哥哥人不在/一直没动时，最省 token 的做法是停，
          // 而不是继续每 15 秒截一张屏。这里不冒"我先歇着"的气泡——停止本身是静默副作用，
          // 免得测试/宿主把自动关也当成一次说话。
          log(`画面连续 ${idle} 次没变，自动停下（省点 token）`);
          stop();
          return 'stopped';
        }
        return 'same';
      }

      // ── 3. 画面变了：看一眼 ───────────────────────────────────────────
      idle = 0;

      let text: string;
      try {
        text = await deps.look(shot, cfg.prompt);
      } catch (error) {
        lookFailures += 1;
        log(`识图失败（连续 ${lookFailures}/${MAX_LOOK_FAILURES} 次）：` + errorText(error));
        if (lookFailures >= MAX_LOOK_FAILURES) {
          log('识图连续失败太多次，先停，别对着坏接口空转');
          stop();
          return 'stopped';
        }
        // 画面确实变了，只是这一句没说成；让调用方看到 changed，下一拍继续
        return 'changed';
      }
      if (myGeneration !== generation) return 'skipped';
      lookFailures = 0;

      const said = typeof text === 'string' ? text.trim() : '';
      if (said.length === 0) {
        // 模型偶尔会吐空/只有空白；空气泡会被宿主拒掉，这一拍干脆不冒
        log('识图回来了但没说话，这一拍不冒泡');
        return 'changed';
      }

      // ── 4. 冒泡（可选配表情包）────────────────────────────────────────
      let image: string | undefined;
      if (deps.pickMeme) {
        try {
          const picked = deps.pickMeme();
          if (typeof picked === 'string' && picked.trim().length > 0) image = picked.trim();
        } catch (error) {
          // 抽表情失败不该影响说话
          log('挑表情包失败，这次不带图：' + errorText(error));
        }
      }

      try {
        await deps.bubble(said, image ? { image } : undefined);
      } catch (error) {
        // 冒泡失败（宿主关了、渲染端没连上）只记日志；声音照旧可以试着出
        log('冒泡失败：' + errorText(error));
      }
      if (myGeneration !== generation) return 'skipped';

      // ── 5. 出声（config.voice 且调用方给了 speak 才走）──────────────────
      // play 没注入时有默认 ffplay 实现；只要 speak 和 play 任一缺失就完全不出声。
      if (cfg.voice && deps.speak) {
        try {
          const audio = await deps.speak(said);
          if (myGeneration !== generation) return 'skipped';
          await play(audio);
        } catch (error) {
          // 嗓子/放音坏了不影响画面检测和下一拍；只记一笔
          log('出声失败：' + errorText(error));
        }
      }

      return 'changed';
    } finally {
      busy = false;
    }
  }

  function status(): { running: boolean; ticks: number; idle: number } {
    return { running, ticks, idle };
  }

  return { start, stop, tickOnce, status };
}
