/**
 * watch-mode.ts —— 「看护模式」的选帧引擎（本鱼 · 11-09）
 *
 * 和 `companion.ts`（陪伴）的分工：
 *   · 陪伴 = 每 N 分钟截一张整图，回答「现在是什么」；
 *   · 看护 = 12fps 常驻看一条流，只在「画面真的换了」或「一直在动攒够了」时留 4 帧，
 *     拼成一张 2×2 交给识图，回答「这段时间**从什么变成了什么**」。
 *
 * 选帧思路取自 dsh-see-now（Apache-2.0，github.com/SAOS-3624/dsh-see-now）的
 * 变化分 / 切点 / 积分判据，按桌面场景重新标定（见下面 THRESHOLDS 的注释）。
 * 只借思路与参数刻度，没有拷贝它的代码。
 *
 * 用法：
 *   const watch = createWatchMode({ ffmpegPath, onSheet });
 *   watch.start('normal');
 *   watch.stop();
 *   watch.status();   // → { running, pace, delivered, ... }
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { cropFrame } from './screen-crop';
import { captureJpeg } from './capture';
import { ddaInput, ddaVf, fitInside } from './capture-source';
import { hasDdagrab, resolvedFfmpeg } from './capture';

/** 采集尺寸：宽高都是 42 的倍数（DeepSeek 的视觉 patch 是 42px 一格，对齐了不浪费 token） */
// 【11-09 晚 m16589】哥哥：「截的图只有屏幕左上四分之一」「分辨率太低」。
// 旧值 798×462 是给「变化打分」定的（打分走 64×36 网格，跟分辨率无关），
// 但拼图也复用了它 —— 一格只有 399×231，屏幕上的字全糊。现在提到 1280×800（本机 1707×1067 的 1.6 比例），
// 一格 640×400，字能认；打分成本不变（4 点采样/格），多的只是每帧拷贝和 ffmpeg 缩放。
// 【11-10 m18266】哥哥：「格子大一点吧没关系」——六宫格的格子要看得清，抓屏抬到 1536×960
// （还是 1.6，本机 2560×1600 的一半），单格 768×480 正好 2×2 下采样。
export const CAPTURE_W = 1536;
export const CAPTURE_H = 960;
const CAPTURE_FPS = 12;
const FRAME_BYTES = CAPTURE_W * CAPTURE_H * 3;
/** 抓图 / 编码的 ffmpeg 硬超时（11-16 体检 B3）：卡死就掐掉，别把调用它的那条路一起挂住 */
const FFMPEG_TIMEOUT_MS = 15_000;

/**
 * 单张尺寸（11-16 m21257 去宫格后只剩这一种）。
 * 从 1280×800 降到 1024×640：识图快一点、token 少三成，字还认得清。
 * 宽高都是 42 的倍数（DeepSeek 视觉 patch 是 42px 一格），对齐了不浪费。
 */
export const STILL_W = 1536;
export const STILL_H = 960;

/** 网格打分：64×36，每格取 4 个采样点求平均（同 see-now 的 gridRgb） */
const SCAN_W = 64;
const SCAN_H = 36;

/**
 * ★ 打分口径（2026-11-09 晚按 dsh-see-now 的 src/cuts.js 对齐后的第二版）
 *
 * `scorePairMoving` 返回的是**面积分**：「这一帧有多少比例的格子变了 × 255」，不是幅度均值。
 * 每格的差先按三通道取平均（同它的 hsvDiff），连 ±MC_RADIUS 格邻域里最像的一格都超 MC_TAU
 * 才算「这格变了」。这个口径比幅度均值稳：10% 面积的真变化是 ≈25 分，不会被剩下 90% 没动的
 * 格子摊薄；换成幅度均值只剩 ≈6 分，弹窗、对话框这种小面积变化会被漏成「没变」。
 *
 * 阈值因此分成两套刻度（v1 的 12 分是幅度刻度，照搬过来会直接错一倍多）：
 *   CUT_MC_ABS = 30    → 约 12% 的格子变了就算切点。
 *                        see-now 用 60（≈23.5%），它们网格细、只认「整屏换掉」；
 *                        我们只有 64×36 格，得认得出弹窗，所以压低一档。
 *   INTEGRAL_LIGHT = 5 → 轻变化（打字、光标、流式输出）每帧的参考分，攒满 integralSec 秒就出一张。
 * 静止画面两者都不会自己动：面积分是严格的 0。
 *
 * ⚠ CUT_MC_ABS / CUT_SPIKE / INTEGRAL_LIGHT 都是**每帧**量，只对 12fps 成立。
 * 哪天为了省 CPU 把 CAPTURE_FPS 降下来，这几个必须重新标定（dsh-see-now 踩过：
 * 阈值单位跟帧率绑死，复制到另一个帧率的版本上直接错 30 倍）。
 */
const CUT_MC_ABS = 30;
const CUT_SPIKE = 2.5;
const CUT_MIN_GAP = 0.4;
const SETTLE_FRAMES = 4;
const SETTLE_MAX = 6;
const NOISE_MIN = 1;
/** 轻变化每帧的参考分（面积刻度），只给积分用 */
const INTEGRAL_LIGHT = 5;

/**
 * 运动补偿的搜索半径（格）。64×36 把 798×462 压成这么大，一格约 12×13 像素（成品画面上约 40×44）；
 * 半径 2 能容忍每帧 2 格的整屏平移，12fps 下相当于每秒 24 格的滚动速度。
 *
 * 抄的是 dsh-see-now 那条教训（视频里叫「把幅度门槛换成面积门槛」）：逐格绝对差有个治不好的毛病——
 * 整屏都在动时分数会被顶满，滚网页、拖窗口、连续运镜看起来全都像「画面换了」。
 * 改成「每格去下一帧的邻域里找最像的格，连最像的都差很多才算变」，平移被吃掉，真换场照样顶高。
 */
const MC_RADIUS = 2;
/** 单格算「变了」的门槛（三通道平均差，0–255），同 see-now 的 mcTau=15 */
const MC_TAU = 15;

/**
 * 节奏的「账单感」：这一档最多每分钟出几张图（按 minGapSec 倒算，不含兜底）。
 *
 * 哥哥 11-09 原话：「菜单里要不要把节奏直接写成每分钟几张（比如 陪伴：✓ 正常（≈1.4 张/分钟））？
 * 现在写的是轻/正常/密，账单看不懂」。他点头写，所以标签里带上这个数。
 */
export function watchPaceCost(
  pace: WatchPace,
  paces: Readonly<Record<WatchPace, PaceTuning>> = WATCH_PACES,
): string {
  const perMin = Math.floor(3600 / (paces[pace].minGapSec || 1)) / 60;
  // 整数就写整数，带小数就留一位（密档 450/60 = 7.5，四舍五入成 8 会让人觉得多花了）
  const shown = perMin % 1 === 0 ? perMin.toFixed(0) : perMin.toFixed(1);
  return `最多 ${shown} 张/分`;
}

/** 开口节奏（哥哥 11-09 拍板）：两次开口至少隔 10 秒（当天下午从 15 秒收紧） */
export const WATCH_MIN_GAP_MS = 10_000;
/** 超过 3 分钟没开口就必须说一句（兜底） */
export const WATCH_FALLBACK_MS = 180_000;
/** 识图笔记在环里留多久（20 分钟，避免越长越啰嗦） */
export const WATCH_NOTES_MS = 20 * 60 * 1000;

export type WatchPace = 'calm' | 'normal' | 'dense';

interface PaceProfile {
  /** 两次交付之间最短间隔（秒） */
  readonly minGapSec: number;
  /** 积分门槛：每秒攒 4 分，攒够这么多秒就出一帧 */
  readonly integralSec: number;
  /** 完全没动静时多久兜底出一帧（秒） */
  readonly floorSec: number;
}

/**
 * 三档节奏。默认 normal —— 真有切换立刻出，画面没变化就别频繁截图。
 *
 * 【汐儿 · 11-10 10:00 m17978】哥哥：「A 可以」——兜底从 15/25/45 秒拉到 60/90/180 秒。
 * 原因：旧兜底让「屏幕一点没动」也每 15 秒出一张图、识一次图、判一次要不要说话，
 * 今早 01:39–01:43 四分钟出了 19 张、说了 8 句，全被这种噪音顶出来的。
 * 真变化（切窗口/切视频/换场景）还是立刻出——那才是插话的契机。
 */
export const WATCH_PACES: Readonly<Record<WatchPace, PaceProfile>> = {
  calm: { minGapSec: 30, integralSec: 8, floorSec: 180 },
  normal: { minGapSec: 15, integralSec: 4, floorSec: 90 },
  dense: { minGapSec: 8, integralSec: 2, floorSec: 60 },
};

/** 一档节奏的三个数（设置页可改） */
export interface PaceTuning {
  /** 两次出图最短间隔（秒） */
  readonly minGapSec: number;
  /** 轻变化累计够这么多秒就出一张 */
  readonly integralSec: number;
  /** 完全没变化时多久兜底出一张（秒） */
  readonly floorSec: number;
}

/**
 * 陪伴的调参面板（哥哥 11-10 m18312：「突变相关评分、提示词这一类都放进设置里面」）。
 *
 * 默认值就是代码里标定过的那一套，别在别处再写一份数字——设置页读一次默认值再从默认值出发。
 */
export interface WatchTuning {
  /** 突变：单帧面积分到多少算切点（0–255，越大越迟钝） */
  readonly cutAbs: number;
  /** 突变：还要超过「上一帧分的多少倍」才算（防缓慢推镜） */
  readonly cutSpike: number;
  /** 两次突变之间至少隔多少秒 */
  readonly cutMinGapSec: number;
  /** 判突变后等几帧，看画面停没停 */
  readonly settleFrames: number;
  /** 累计：轻变化每帧的参考分（越小越敏感） */
  readonly integralLight: number;
  /** 单张多大（像素） */
  readonly stillWidth: number;
  readonly stillHeight: number;
  /** 三档节奏 */
  readonly paces: Readonly<Record<WatchPace, PaceTuning>>;
}

export const DEFAULT_TUNING: WatchTuning = {
  cutAbs: CUT_MC_ABS,
  cutSpike: CUT_SPIKE,
  cutMinGapSec: CUT_MIN_GAP,
  settleFrames: SETTLE_FRAMES,
  integralLight: INTEGRAL_LIGHT,
  stillWidth: STILL_W,
  stillHeight: STILL_H,
  paces: WATCH_PACES,
};

/** 历史上的「默认值」两套都低于清晰度门槛，成对命中就当用户没设过（11-20 体检） */
const LEGACY_STILL_SIZES: ReadonlyArray<readonly [number, number]> = [
  [1008, 630],
  [1280, 800],
];

function isLegacyStillSize(width: unknown, height: unknown): boolean {
  return LEGACY_STILL_SIZES.some(([w, h]) => width === w && height === h);
}

/** 把外部来的（配置里、设置页里）半截数字夹到安全范围，缺项回落默认 */
export function normalizeTuning(raw?: Partial<WatchTuning> | null): WatchTuning {
  const pick = (value: unknown, fallback: number, lo: number, hi: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(hi, Math.max(lo, value));
  };
  const pace = (which: WatchPace): PaceTuning => {
    const src = raw?.paces ? raw.paces[which] : undefined;
    const base = DEFAULT_TUNING.paces[which];
    return {
      minGapSec: pick(src?.minGapSec, base.minGapSec, 1, 3600),
      integralSec: pick(src?.integralSec, base.integralSec, 0.2, 3600),
      floorSec: pick(src?.floorSec, base.floorSec, 5, 36_000),
    };
  };
  return {
    cutAbs: pick(raw?.cutAbs, DEFAULT_TUNING.cutAbs, 1, 255),
    cutSpike: pick(raw?.cutSpike, DEFAULT_TUNING.cutSpike, 1, 20),
    cutMinGapSec: pick(raw?.cutMinGapSec, DEFAULT_TUNING.cutMinGapSec, 0, 60),
    settleFrames: Math.round(pick(raw?.settleFrames, DEFAULT_TUNING.settleFrames, 1, 30)),
    integralLight: pick(raw?.integralLight, DEFAULT_TUNING.integralLight, 0.5, 100),
    // 【11-20】1008×630（0.5.0 出厂）和 1280×800（0.5.2 的旧默认）都低于清晰度门槛，
    // 老配置里存的就是这两个数 → 成对命中就当没设过，跟着新默认走（1536×960）。
    stillWidth: Math.round(pick(isLegacyStillSize(raw?.stillWidth, raw?.stillHeight) ? undefined : raw?.stillWidth, DEFAULT_TUNING.stillWidth, 320, 4096)),
    stillHeight: Math.round(pick(isLegacyStillSize(raw?.stillWidth, raw?.stillHeight) ? undefined : raw?.stillHeight, DEFAULT_TUNING.stillHeight, 200, 2560)),
    paces: { calm: pace('calm'), normal: pace('normal'), dense: pace('dense') },
  };
}

export const PACE_LABELS: Readonly<Record<WatchPace, string>> = {
  calm: '轻',
  normal: '正常',
  dense: '密',
};

/** 一张图交出去时附带的信息（识图提示词要用时间顺序，日志要用它排查） */
export interface WatchSheetMeta {
  /** 为什么出这一张：切点 / 积分 / 兜底 */
  readonly reason: 'cut' | 'mark' | 'floor';
  /**
   * 这一张长什么样（哥哥 11-10 m17986 拍板分两类）：
   *   · `single` = 单帧整屏 —— 画面变化小，说话只需要「现在是什么」；
   *   · `grid`   = 2×2 宫格 —— 画面变化大（切点），要让模型自己看「这几秒发生了什么」。
   * 宫格四格间隔从 0.25 秒改成 1 秒（旧间隔太短，四格几乎一模一样，看不出变化）。
   */
  readonly kind: 'single';
  /** 这一张是裁了某个窗口（true）还是整屏（false）——排查「怎么只看到一半」用 */
  readonly cropped: boolean;
  /** 四格各自距候选帧多少秒前（宫格 [3, 2, 1, 0]；单帧 [0]） */
  readonly offsetsSec: readonly number[];
  /** 这一张是本次开启以来第几张 */
  readonly index: number;
  /** 变化分（切点/积分那帧的分数，兜底帧给 0） */
  readonly score: number;
  /** 这张图最后一格（"刚刚"那帧）的拍摄时刻（epoch ms）；用来判「超过 20 秒就别再说了」 */
  readonly shotAtMs: number;
}

/*
 * 【汐儿 · 11-10 01:46 m17821】原来这里有一套「跟前台窗口抓屏」：常驻 PowerShell 每 1000ms 报
 * 前台窗口矩形，再让 gdigrab 只抓那一块（靠输入端的偏移量与画面尺寸那两个裁剪参数）。删掉的原因：
 *
 *   本机屏幕实际 2560×1600（150% 缩放）。PowerShell 与 ffmpeg 都是 DPI-unaware 进程，
 *   但 GetWindowRect 返回的是**缩放后的逻辑坐标**（1707×1067 那一套），
 *   而 gdigrab 的裁剪参数却是按**物理像素**算 —— 差 1.5 倍。
 *   于是「跟到窗口」截出来的永远只有窗口左上那一块，而退回整屏反而完整（哥哥实测）。
 *
 * 现在只有一条路：整屏抓，缩到 CAPTURE_W×CAPTURE_H。少一层检测，也少一堆状态。
 */

export interface WatchHandle {
  start(pace?: WatchPace): { ok: true } | { ok: false; message: string };
  stop(): void;
  /** 换档：正在跑就按新档重启（不打断太久） */
  setPace(pace: WatchPace): { ok: true } | { ok: false; message: string };
  /** 改调参：下一帧就按新的算，不用重启抓屏 */
  setTuning(next?: Partial<WatchTuning> | null): void;
  /** 现在生效的调参（设置页回显用） */
  tuning(): WatchTuning;
  status(): {
    running: boolean;
    pace: WatchPace;
    delivered: number;
    lastDeliverAt: number | null;
    /** 最近一秒的平均变化分，给设置页调参用 */
    score: number;
  };
  /** 进程内累计看过多少张（菜单要显示） */
  deliveredCount(): number;
}

export interface WatchOptions {
  /** ffmpeg 可执行文件；不传就按 PATH 找 */
  readonly ffmpegPath?: string;
  /** 拼好一张就回调一次（已经编码成 PNG 字节）；抛错只记日志，不停看护 */
  readonly onSheet: (png: Buffer, meta: WatchSheetMeta) => Promise<void> | void;
  readonly log?: (message: string) => void;
  /** 多久没有任何交付就自己停（秒）；默认 15 分钟 */
  readonly idleStopSec?: number;
  /** 画面连续这么久完全没变化就自己停（秒）；默认 15 分钟 */
  readonly stillStopSec?: number;
  /**
   * 静止超时时再问一句「真该收工吗？」：返回 false 就重置计时接着看。
   * 用途见 index.ts —— 画面不动 ≠ 人走了（dsh-see-now 那条教训：别拿资源可用性当用户意图）。
   */
  readonly shouldStillStop?: () => boolean;
  /** 因为「一直没变化」自己停下来时回调一次（告别一句用） */
  readonly onStillStop?: () => void;
  /** 抓屏连续起不来、决定彻底停下时回调一次（11-16 体检 B3：让菜单和取景轮询跟着收） */
  readonly onCaptureLost?: () => void;
  /** 调参（突变评分、尺寸、累计、三档节奏）；不传就用代码里标定过的默认 */
  readonly tuning?: Partial<WatchTuning>;
  /**
   * 这一张要不要只截某个窗口（11-16 m21257「全屏 / 自动 / 窗口」三档）。
   * 返回 null = 截整屏；返回矩形就按屏幕缩放比在内存里裁（见 screen-crop.ts）。
   * **每次出图现问一次**，所以切窗口、关窗口下一张就跟上了。
   */
  readonly cropTarget?: () => { rect: { x: number; y: number; w: number; h: number }; screenW: number; screenH: number } | null;
}

// ---------------------------------------------------------------- 笔记解析（纯函数）

/**
 * 该不该现在开口 —— 把「什么时候说话」钉在代码里，不交给模型自觉：
 *   · 离上次开口不到 10 秒 → 闭嘴（`skip`）；
 *   · 10 秒以上、3 分钟以内 → 只有攒到重要性 ≥2 的笔记才问（`ask`），否则省一次模型调用；
 *   · 超过 3 分钟 → 必须开口（`force`）。
 * 这样既守住哥哥要的「30 秒到 3 分钟、兜底 3 分钟」，又不会在只动了下光标时白烧 token。
 */
export function watchShouldAsk(elapsedMs: number, hasImportant: boolean): 'skip' | 'ask' | 'force' {
  if (elapsedMs < WATCH_MIN_GAP_MS) return 'skip';
  if (elapsedMs >= WATCH_FALLBACK_MS) return 'force';
  return hasImportant ? 'ask' : 'skip';
}

/**
 * 解析识图回的那一行「重要性|笔记」。
 *
 * 模型不一定守格式（会带引号、带「笔记：」、多回几行），所以这里做的是**兜底解析**：
 * 认 `1|` `2｜` `3:：` 这些写法；认不出来就整行当笔记、重要性按 1（= 不值得开口）。
 * 这条纪律重要，因为重要性直接决定「10 秒~3 分钟之间要不要开口」。
 */
export function parseWatchNote(text: string): { imp: number; note: string } {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '') ?? '';
  const hit = /^([123])\s*[|｜:：]\s*(.+)$/.exec(line);
  if (hit) {
    return { imp: Number(hit[1]), note: hit[2]!.trim().slice(0, 40) };
  }
  const stripped = line.replace(/^[0-9]\s*[|｜:：]\s*/, '').replace(/^笔记[:：]\s*/, '');
  return { imp: 1, note: stripped.slice(0, 40) };
}

// ---------------------------------------------------------------- 打分（纯函数）

/** 整帧 → 64×36 网格 RGB（每格 4 采样点平均） */
export function gridRgb(rgb: Uint8Array, width: number, height: number, out: Float32Array): Float32Array {
  const sx = width / SCAN_W;
  const sy = height / SCAN_H;
  for (let gy = 0; gy < SCAN_H; gy += 1) {
    const y0 = ((gy + 0.25) * sy) | 0;
    const y1 = ((gy + 0.75) * sy) | 0;
    const r0 = y0 * width;
    const r1 = y1 * width;
    for (let gx = 0; gx < SCAN_W; gx += 1) {
      const x0 = ((gx + 0.25) * sx) | 0;
      const x1 = ((gx + 0.75) * sx) | 0;
      const a = (r0 + x0) * 3;
      const b = (r0 + x1) * 3;
      const c = (r1 + x0) * 3;
      const d = (r1 + x1) * 3;
      const i = gy * SCAN_W + gx;
      out[i * 3] = (rgb[a] + rgb[b] + rgb[c] + rgb[d]) * 0.25;
      out[i * 3 + 1] = (rgb[a + 1] + rgb[b + 1] + rgb[c + 1] + rgb[d + 1]) * 0.25;
      out[i * 3 + 2] = (rgb[a + 2] + rgb[b + 2] + rgb[c + 2] + rgb[d + 2]) * 0.25;
    }
  }
  return out;
}

/** RGB → HSV，各通道归一到 0–255（H 乘 255/360），就地写 out */
export function rgbToHsv(rgb: Float32Array, out: Float32Array): Float32Array {
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 3) {
    const rn = rgb[i] / 255;
    const gn = rgb[i + 1] / 255;
    const bn = rgb[i + 2] / 255;
    const max = rn > gn ? (rn > bn ? rn : bn) : (gn > bn ? gn : bn);
    const min = rn < gn ? (rn < bn ? rn : bn) : (gn < bn ? gn : bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    out[j] = (h / 360) * 255;
    out[j + 1] = max === 0 ? 0 : (d / max) * 255;
    out[j + 2] = max * 255;
  }
  return out;
}

/** 两帧 HSV 的加权绝对差均值（0–255）：色相环形处理，低饱和像素的色相降权 */
export function scorePair(prev: Float32Array, cur: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < cur.length; i += 3) {
    const dh = Math.abs(cur[i] - prev[i]);
    const hueDiff = Math.min(dh, 255 - dh);
    const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255;
    sum += hueDiff * hueWeight
      + Math.abs(cur[i + 1] - prev[i + 1])
      + Math.abs(cur[i + 2] - prev[i + 2]);
  }
  return sum / ((cur.length / 3) * 3);
}

/**
 * 单格差：色相环形 + 低饱和降权的三通道平均，0–255。
 * 注意这里**除以 3**，和 see-now 的 hsvDiff 同口径 —— 所以 MC_TAU=15 能直接照抄。
 */
function cellDiff(prev: Float32Array, pi: number, cur: Float32Array, ci: number): number {
  const dh = Math.abs(cur[ci] - prev[pi]);
  const hueDiff = Math.min(dh, 255 - dh);
  const hueWeight = Math.min(cur[ci + 1], prev[pi + 1]) / 255;
  return (hueDiff * hueWeight
    + Math.abs(cur[ci + 1] - prev[pi + 1])
    + Math.abs(cur[ci + 2] - prev[pi + 2])) / 3;
}

/**
 * 带运动补偿的变化分（面积口径）：数一数「有多少格子真的变了」，再换算成 0–255。
 *
 * 判定一格「变了」的办法：先在**同位置**比一次，超了才去 ±radius 邻域找最像的一格；
 * 连邻域里最像的都还超 MC_TAU 才算变。同位置先测是 see-now 的优化——静止画面里绝大多数
 * 格子第一下就命中，整屏 mcStats 从 0.72ms 降到 0.06ms。
 *
 * 返回 `未匹配格数 / 总格数 * 255`，所以它和 CUT_MC_ABS 是一套刻度；scorePair（幅度刻度）
 * 是另一套，只用来判「画面停没停」（settle），不参与切点。
 */
export function scorePairMoving(prev: Float32Array, cur: Float32Array, radius = MC_RADIUS, tau = MC_TAU): number {
  let changed = 0;
  for (let gy = 0; gy < SCAN_H; gy += 1) {
    for (let gx = 0; gx < SCAN_W; gx += 1) {
      const pi = (gy * SCAN_W + gx) * 3;
      let matched = cellDiff(prev, pi, cur, pi) <= tau;
      if (!matched) {
        const y0 = Math.max(0, gy - radius);
        const y1 = Math.min(SCAN_H - 1, gy + radius);
        const x0 = Math.max(0, gx - radius);
        const x1 = Math.min(SCAN_W - 1, gx + radius);
        for (let cy = y0; cy <= y1 && !matched; cy += 1) {
          for (let cx = x0; cx <= x1; cx += 1) {
            if (cx === gx && cy === gy) continue; // 上面测过了
            if (cellDiff(prev, pi, cur, (cy * SCAN_W + cx) * 3) <= tau) {
              matched = true;
              break;
            }
          }
        }
      }
      if (!matched) changed += 1;
    }
  }
  return (changed / (SCAN_W * SCAN_H)) * 255;
}

/**
 * 静止超时该干什么：`wait` 继续看、`extend` 延长一轮、`stop` 收工。
 *
 * 单独抽出来是因为「画面不动」和「人走了」是两件事——读长文档、看视频、盯着一张图发呆，
 * 画面都会长时间不动。dsh-see-now 的作者为同一类错误付过代价（拿「窗口还活着」当「用户还在看」），
 * 这里把判断权交回 index.ts：最近有人找过她，就 extend 一轮。
 */
export function stillStopDecision(
  lastChangeAt: number,
  stillStopSec: number,
  now: number,
  shouldStillStop?: () => boolean,
): 'wait' | 'extend' | 'stop' {
  if (lastChangeAt === 0) return 'wait';
  if (now - lastChangeAt < stillStopSec * 1000) return 'wait';
  if (shouldStillStop && !shouldStillStop()) return 'extend';
  return 'stop';
}

/**
 * 面积平均缩图：每个目标像素取源图里对应那块矩形的平均值。
 * 抓屏 1536×960 → 单格 768×480 是整数 2×2（最便宜）；突变那张 640×400 是 2.4×2.4，也就几毫秒。
 * 【为什么不用最近邻】字会被吃掉笔画；面积平均在缩小的时候基本等于抗锯齿。
 */
export function boxDownsample(
  frame: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Buffer {
  const out = Buffer.alloc(dstW * dstH * 3, 0);
  const xs = new Int32Array(dstW + 1);
  const ys = new Int32Array(dstH + 1);
  for (let x = 0; x <= dstW; x += 1) xs[x] = Math.min(srcW, Math.round((x * srcW) / dstW));
  for (let y = 0; y <= dstH; y += 1) ys[y] = Math.min(srcH, Math.round((y * srcH) / dstH));
  let dst = 0;
  for (let y = 0; y < dstH; y += 1) {
    const y0 = ys[y]!;
    const y1 = Math.max(y0 + 1, ys[y + 1]!);
    for (let x = 0; x < dstW; x += 1) {
      const x0 = xs[x]!;
      const x1 = Math.max(x0 + 1, xs[x + 1]!);
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        let i = (sy * srcW + x0) * 3;
        for (let sx = x0; sx < x1; sx += 1) {
          r += frame[i]!;
          g += frame[i + 1]!;
          b += frame[i + 2]!;
          i += 3;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      out[dst++] = (r / n) | 0;
      out[dst++] = (g / n) | 0;
      out[dst++] = (b / n) | 0;
    }
  }
  return out;
}

/**
 * 临时抓一张「最近那一帧」的整屏 JPEG—— 回看细节用（哥哥 m18222）。
 * 她看出屏幕上有事、又看不清具体名字/数字时，拿这张单张大图再问一次。
 *
 * 【11-19 截屏收口】进程收在 `capture.ts`：超时、收字节、杀进程只有一份实现。
 * 【11-20 m31592】改出 JPEG：这张图只送识图、不落盘，320KB 比 2MB 传得快五倍。
 */
export function grabStill(ffmpegPath?: string): Promise<Buffer> {
  return captureJpeg({ ...(ffmpegPath === undefined ? {} : { ffmpegPath }) });
}

// ---------------------------------------------------------------- 引擎

export function createWatchMode(options: WatchOptions): WatchHandle {
  const log = options.log ?? ((message: string) => console.log(message));
  const idleStopSec = options.idleStopSec ?? 15 * 60;
  const stillStopSec = options.stillStopSec ?? 15 * 60;

  let child: ChildProcess | null = null;
  let pace: WatchPace = 'normal';
  let tuning = normalizeTuning(options.tuning);
  let running = false;
  let delivered = 0;
  let lastDeliverAt: number | null = null;
  /** 每次启停换代，防止 stop 之后残留的异步副作用 */
  let generation = 0;

  /**
   * 【汐儿 · 11-16 体检 B3】抓屏进程死了要自己爬起来：2 秒 / 5 秒 / 15 秒各试一次，
   * 连着三次都不行就收手并通知外面（菜单跟着变、取景轮询也停）。
   * 以前只把 running 置 false —— 外面看着「陪伴还开着」，其实一张图都不出了。
   */
  let wantRun = false;
  let captureUpAt = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restartCount = 0;

  function clearRestart(): void {
    if (restartTimer !== null) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  function scheduleRestart(reason: string): void {
    if (!wantRun || restartTimer !== null) return;
    restartCount += 1;
    if (restartCount > 3) {
      wantRun = false;
      log(`[watch] 抓屏连着三次没起来（${reason}），先停下——要接着陪就手动再开一次`);
      options.onCaptureLost?.();
      return;
    }
    const delay = restartCount === 1 ? 2_000 : restartCount === 2 ? 5_000 : 15_000;
    log(`[watch] 抓屏断了（${reason}），${Math.round(delay / 1000)} 秒后重试（第 ${restartCount} 次）`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!wantRun) return;
      if (!spawnCapture()) {
        scheduleRestart('重试起不来');
        return;
      }
      running = true;
    }, delay);
  }

  let pending: Buffer[] = [];
  let pendingLen = 0;

  let prevHsv: Float32Array | null = null;
  let prevScore: number | null = null;
  let acc = 0;
  let dirty = false;
  let lastCutAt = -99;
  let lastMarkAt = -99;
  let lastFloorAt = 0;
  let settle: { at: number; hsv: Float32Array; left: number; score: number } | null = null;
  /** 最新一帧（单帧模式直接发它，不再拼图） */
  let lastFrame: Buffer | null = null;
  let frameCount = 0;
  let startedAt = 0;
  let lastScoreSeen = 0;
  /** 最近一次「画面真的变了」的时刻（ms）；连续 too long 没变就自己停 */
  let lastChangeAt = 0;

  /** 出图饿死告警用：上次状态日志时刻 */
  let lastStatusLogAt = 0;

  const gridBuf = new Float32Array(SCAN_W * SCAN_H * 3);
  const hsvBuf = new Float32Array(SCAN_W * SCAN_H * 3);
  const hsvPrev = new Float32Array(SCAN_W * SCAN_H * 3);

  function stop(): void {
    generation += 1;
    wantRun = false;
    clearRestart();
    running = false;
    if (child) {
      const c = child;
      child = null;
      try { c.kill(); } catch { /* 已经死了 */ }
    }
    pending = [];
    pendingLen = 0;
    prevHsv = null;
    prevScore = null;
    acc = 0;
    dirty = false;
    settle = null;
    lastChangeAt = 0;
    lastFrame = null;
  }

  /** gdigrab 的抓取参数：永远整屏（见文件头 11-10 的说明，跟窗口那条路整条删了）。 */
  function captureArgs(bin: string): string[] {
    const dda = hasDdagrab(bin);
    return [
      '-hide_banner',
      '-loglevel',
      'error',
      ...ddaInput(CAPTURE_FPS, dda),
      '-vf',
      ddaVf(`scale=${CAPTURE_W}:${CAPTURE_H},fps=${CAPTURE_FPS}`, dda),
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ];
  }

  /** 起 ffmpeg（start 与「窗口换了」共用）。返回 false 表示起不来。 */
  function spawnCapture(): boolean {
    const bin = options.ffmpegPath || resolvedFfmpeg();
    const mine = generation;
    // 【汐儿 · 11-16 m24046】自动截图横纹 / 缺块的真凶：抓屏进程重启时没清残留的半帧。
    // 旧流死在半帧上，新流的字节从这个偏移接着拼，**之后每一帧都错位**——
    // 落到图上就是横纹、斜切、缺一块。重启前先把半帧桶倒干净。
    pending = [];
    pendingLen = 0;
    try {
      child = spawn(bin, captureArgs(bin), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      log(`[watch] ffmpeg 起不来：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log(`[watch][ffmpeg] ${text}`);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (mine !== generation) return;
      pending.push(chunk);
      pendingLen += chunk.length;
      while (pendingLen >= FRAME_BYTES) {
        const all = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingLen);
        const frame = all.subarray(0, FRAME_BYTES);
        const rest = all.subarray(FRAME_BYTES);
        pending = rest.length ? [rest] : [];
        pendingLen = rest.length;
        onFrame(Buffer.from(frame));
      }
    });
    child.on('exit', (code) => {
      if (mine !== generation) return;
      running = false;
      if (code !== 0 && code !== null) log(`[watch] ffmpeg 退出 code=${code}`);
      scheduleRestart(`退出 code=${code ?? 'null'}`);
    });
    child.on('error', (error) => {
      if (mine !== generation) return;
      running = false;
      log(`[watch] ffmpeg 起不来：${error.message}`);
      scheduleRestart('起不来');
    });
    captureUpAt = Date.now();
    return true;
  }

  function start(next: WatchPace = pace): { ok: true } | { ok: false; message: string } {
    stop();
    pace = next;
    generation += 1;
    wantRun = true;
    restartCount = 0;
    clearRestart();
    startedAt = Date.now();
    lastChangeAt = Date.now();
    if (!spawnCapture()) return { ok: false, message: 'ffmpeg 起不来（抓屏失败）' };
    running = true;
    log(`[watch] 启动 ${CAPTURE_W}×${CAPTURE_H} @${CAPTURE_FPS}fps 节奏=${pace}（整屏）`);
    return { ok: true };
  }

  function onFrame(buf: Buffer): void {
    frameCount += 1;
    // 抓屏真稳了 60 秒才把重试计数清零：否则一开一崩的抖动会无限重试下去。
    if (captureUpAt !== 0 && Date.now() - captureUpAt > 60_000) restartCount = 0;
    // 状态行（m16859）：一眼看出「帧在跑但一张没出」这种饿死，别再靠猜
    const nowWall = Date.now();
    if (nowWall - lastStatusLogAt >= 60_000) {
      lastStatusLogAt = nowWall;
      const starved = lastDeliverAt === null ? -1 : Math.round((nowWall - lastDeliverAt) / 1000);
      log(
        `[watch] 状态 帧=${frameCount} 已出=${delivered} 距上次出图=${starved}s`,
      );
    }
    const now = (Date.now() - startedAt) / 1000;

    const grid = gridRgb(buf, CAPTURE_W, CAPTURE_H, gridBuf);
    const hsv = rgbToHsv(grid, hsvBuf);

    let score: number | null = null;
    if (prevHsv) {
      hsvPrev.set(prevHsv);
      // 面积分不做亮度归一（see-now 的原话：归一化只对幅度口径有意义，一起放大等于把
      // 两条独立标定混成一条）；抖动/冰冷的画面本来就不会被算成「变了」。
      score = scorePairMoving(hsvPrev, hsv);
      lastScoreSeen = score;
      // 只要画面真动了就记一笔：连续 15 分钟一动不动才自动收工（哥哥要的是「他看着我才在」；
      // 6 分钟会误伤读文档/看视频的人，11-09 晚放宽到 15 分钟并加「最近有人找过她」延长）
      if (score >= NOISE_MIN) lastChangeAt = Date.now();
    }
    const snapshot = new Float32Array(SCAN_H * SCAN_W * 3);
    snapshot.set(hsv);
    prevHsv = snapshot;

    // 最新帧永远留着（只发这一张）
    lastFrame = buf;

    if (score === null) {
      prevScore = score;
      return;
    }

    const profile = tuning.paces[pace];

    // 候选切点：等几帧看画面停没停。停住 = 真换了；还在动 = 滚动/运镜，落回积分。
    if (settle) {
      settle.left -= 1;
      if (settle.left > 0) {
        prevScore = score;
        return;
      }
      const settleScore = scorePair(settle.hsv, hsv);
      const stopped = settleScore < SETTLE_MAX;
      const candidate = settle;
      settle = null;
      // 【汐儿 · 11-10 m18266】突变只受 CUT_MIN_GAP（0.4 秒）管，不再被「最短出图间隔」挡住——
      // 刚出过图又来一次大切换（开背包、切场景、弹窗）恰恰是最该说的时刻。
      if (stopped) {
        lastCutAt = candidate.at;
        lastMarkAt = candidate.at;
        acc = 0;
        deliver(candidate.at, 'cut', candidate.score);
      }
      prevScore = score;
      return;
    }

    const base = Math.max(1, prevScore ?? 0);
    if (score >= tuning.cutAbs
      && score > tuning.cutSpike * base
      && now - lastCutAt >= tuning.cutMinGapSec) {
      settle = { at: now, hsv: snapshot, left: tuning.settleFrames, score };
      prevScore = score;
      return;
    }

    if (score >= NOISE_MIN) {
      acc += score;
      dirty = true;
    }
    const need = tuning.integralLight * CAPTURE_FPS * profile.integralSec;
    // 累积变化够了就出一张（11-16 去宫格：不再等六帧攒满）
    if (acc >= need) {
      acc = 0;
      lastMarkAt = now;
      deliver(now, 'mark', score);
    } else if (dirty && now - Math.max(lastMarkAt, lastFloorAt) >= profile.floorSec && now - lastMarkAt >= profile.minGapSec) {
      lastFloorAt = now;
      lastMarkAt = now;
      acc = 0;
      deliver(now, 'floor', 0);
    }
    prevScore = score;

    // 画面连续一段时间完全没变化 → 自己收工（默认 15 分钟）。
    // 但「画面不动」不等于「人走了」：读长文档、看视频、盯着一张图发呆都是这样。
    // 所以超时之后先问 shouldStillStop —— 有人在最近这段时间找过她，就重新计时接着看。
    const still = stillStopDecision(lastChangeAt, stillStopSec, Date.now(), options.shouldStillStop);
    if (still !== 'wait') {
      const span = stillStopSec >= 60 ? `${Math.round(stillStopSec / 60)} 分钟` : `${Math.round(stillStopSec)} 秒`;
      if (still === 'extend') {
        lastChangeAt = Date.now();
        log(`[watch] 连续 ${span}没变化，但刚有人找过她，继续看`);
      } else {
        log(`[watch] 连续 ${span}没变化，自己停了`);
        const bye = options.onStillStop;
        stop();
        bye?.();
        return;
      }
    }

    // 长时间完全没交付 → 自己停，别白烧 CPU
    if (lastDeliverAt !== null && (Date.now() - lastDeliverAt) / 1000 > idleStopSec) {
      log('[watch] 太久没动静，自己停了');
      stop();
    } else if (lastDeliverAt === null && (Date.now() - startedAt) / 1000 > idleStopSec) {
      log('[watch] 一直没动静，自己停了');
      stop();
    }
  }

  function deliver(at: number, reason: WatchSheetMeta['reason'], score: number): void {
    // 交付过就把「有变化」的账销掉：否则屏幕一旦静止过一次，floor 会每 floorSec
    // 白白再问一遍（实测 45 秒里连出两张一模一样的图，白白烧一次识图）。
    dirty = false;
    const frame = lastFrame;
    if (!frame) return;

    // 11-16 m21257：只出单张。要不要只截某个窗口，由调用方现给矩形（screen-crop 负责换算）。
    let src: Buffer = frame;
    let srcW = CAPTURE_W;
    let srcH = CAPTURE_H;
    let cropped = false;
    const target = options.cropTarget?.() ?? null;
    if (target !== null && target.screenW > 0 && target.screenH > 0) {
      const cutOut = cropFrame(frame, CAPTURE_W, CAPTURE_H, { x: 0, y: 0, w: target.screenW, h: target.screenH }, target.rect);
      if (cutOut !== null) {
        src = cutOut.data;
        srcW = cutOut.w;
        srcH = cutOut.h;
        cropped = true;
      } else {
        log('[watch] 裁剪矩形不可信，退回整屏');
      }
    }

    // 【汐儿 · 11-18 m27977】以前是硬压成 stillWidth×stillHeight：裁剪后长宽比各不相同，
    // 1941×1243 塞进 1280×800 就是单向拉伸，窄窗口能把字横拉两倍（哥哥说的「字被拉变形」）。
    // 现在只按最长边缩、保持比例，PNG 尺寸跟着窗口走。
    const fitted = fitInside(srcW, srcH, tuning.stillWidth, tuning.stillHeight);
    const width = fitted.width;
    const height = fitted.height;
    const raw =
      srcW === width && srcH === height ? Buffer.from(src) : boxDownsample(src, srcW, srcH, width, height);
    const index = delivered + 1;
    const meta: WatchSheetMeta = {
      reason,
      kind: 'single',
      cropped,
      offsetsSec: [0],
      index,
      score: Number(score.toFixed(2)),
      shotAtMs: startedAt + at * 1000,
    };
    const mine = generation;
    void encodeJpeg(raw, width, height).then((image) => {
      if (mine !== generation) return;
      delivered = index;
      lastDeliverAt = Date.now();
      log(`[watch] 出图 #${index} ${reason} t=${at.toFixed(2)}s score=${meta.score} ${cropped ? '裁剪' : '整屏'}`);
      return options.onSheet(image, meta);
    }).catch((error: unknown) => {
      log(`[watch] 出图失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * 原始帧 → JPEG 字节（交给识图；ffmpeg 编码几十毫秒）。
   * 用 yuvj420p 所以要偶数边：多挂一个 crop 取偶数，省得窗口尺寸是奇数时编码直接报错。
   */
  function encodeJpeg(raw: Buffer, width: number, height: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const bin = options.ffmpegPath || resolvedFfmpeg();
      const ff = spawn(bin, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`,
        '-i', 'pipe:0', '-frames:v', '1',
        '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2',
        '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1',
      ]);
      const chunks: Buffer[] = [];
      let err = '';
      let done = false;
      const settle = (fn: () => void): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => {
          try { ff.kill(); } catch { /* 已经退了 */ }
          reject(new Error('jpeg 编码超时'));
        });
      }, FFMPEG_TIMEOUT_MS);
      ff.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      ff.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      ff.on('error', (error) => settle(() => reject(error)));
      ff.on('close', (code) => {
        settle(() => {
          if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
          else reject(new Error(err.trim() || `jpeg 编码退出 ${code}`));
        });
      });
      ff.stdin.end(raw);
    });
  }

  return {
    start,
    stop,
    setPace(next: WatchPace) {
      if (!running) {
        pace = next;
        return { ok: true };
      }
      return start(next);
    },
    setTuning(next?: Partial<WatchTuning> | null) {
      tuning = normalizeTuning(next);
      // 间隔肉眼可见地变了就记一笔，排查「改了没生效」用
      log(`[watch] 调参：突变 ${tuning.cutAbs}/${tuning.cutSpike}x/${tuning.cutMinGapSec}s 累计 ${tuning.integralLight} 尺寸 ${tuning.stillWidth}×${tuning.stillHeight}`);
    },
    tuning() {
      return tuning;
    },
    status() {
      return { running, pace, delivered, lastDeliverAt, score: Number(lastScoreSeen.toFixed(2)) };
    },
    deliveredCount() {
      return delivered;
    },
  };
}
