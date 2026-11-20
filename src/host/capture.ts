/**
 * capture.ts —— 抓屏的唯一执行口（所有 ffmpeg 调用都从这里走）。
 *
 * 干什么：把「起 ffmpeg、收字节、超时掐死」收成一份实现，三种用法共用：
 *   - `capturePng()`      整屏一张 PNG（要落盘留存的时候用：Alt+G 的截图）
 *   - `captureJpeg()`     整屏一张 JPEG（**送识图用这个**，2026-11-20 A/B 见下）
 *   - `captureGray()`     64×36 灰度小图（陪伴算指纹，写文件）
 *   - `runFfmpeg()`       其它自定义参数（陪伴流由 `watch-mode` 自己管进程）
 *
 * 什么时候用：任何要截屏的地方。参数一律用 `capture-source.ts` 的 `ddaInput/ddaVf`
 *            拼，别再自己写 gdigrab。
 * 什么时候别用：测试里注入假 `capture`，不要真起进程。
 *
 * 常见坑：
 *   - **超时必须自己掐**：ffmpeg 卡在等帧时不会自己退，`kill()` 之后 `close` 仍会来一次，
 *     所以收尾只能 settle 一次（否则 Promise 二次 resolve，或者错误被吞）。
 *   - 同一瞬间可能有两处一起要图（一眼看 + 回看），`capturePng` / `captureJpeg` 都会把
 *     250ms 内的同参数请求合并成一次进程——省一次 GPU 拷贝，也避免两张图差一帧对不上。
 *   - **识图为什么用 JPEG**（2026-11-20 实测，同一帧、同一道读小字题）：
 *     PNG 1,964,692B / 5.9s / 6 题全对；JPEG qv4 322,861B / 6 全对；qv6 255KB 掉到 5/6；
 *     缩到 1280 宽只剩 3~4/6（字糊）。所以**宽度别低于 1536、质量别差于 qv5**。
 *   - **模型端像素预算约 1.1MP**：1920×1200 与 2560×1600 都只计 1029 prompt tokens，
 *     送更大没用。4K 屏（宽 >2400）按 1920 取，别压到 1536（0.4 倍太小）。
 *   - `-y` 必写：目标文件存在时 ffmpeg 默认问一句，没人应答就卡住。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ddaInput, ddaVf } from './capture-source';


/**
 * 【汐儿 · 11-19 m30590】抓屏引擎自己挑：**必须有 ddagrab**。
 *
 * 为什么会出事：`watchFfmpeg()` 以前硬编码 `D:\AI\GPT-SoVITS\ffmpeg.exe`，那份没编
 * ddagrab（`-filters` 查不到），于是陪伴抓屏三次 `No such filter: 'ddagrab'` 之后
 * 自己按「连着三次没起来」停下——哥哥看到的就是「打开陪伴过一会儿它自己关了」。
 *
 * 现在：按候选顺序找第一份**带 ddagrab** 的；一份都没有才退回「存在的那份 + gdigrab」。
 * 探测结果缓存，只在第一次调用时跑一次 `ffmpeg -filters`（约 30~80ms）。
 */
const FFMPEG_CANDIDATES: readonly string[] = [
  process.env.DSH_PET_FFMPEG?.trim() ?? '',
  'D:\\AI\\RVC\\工具\\ffmpeg\\ffmpeg.exe',
  join(homedir(), '.dsh', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  'D:\\AI\\GPT-SoVITS\\ffmpeg.exe',
  'ffmpeg',
].filter((item) => item !== '');

let cachedBin: string | null = null;
let cachedDda: boolean | null = null;

/** 这份 ffmpeg 支不支持 ddagrab（结果缓存）。 */
export function hasDdagrab(bin: string): boolean {
  try {
    const out = execFileSync(bin, ['-hide_banner', '-filters'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.includes('ddagrab');
  } catch {
    return false;
  }
}

/** 选出要用的 ffmpeg：优先带 ddagrab 的；都不带就用第一个真存在的。 */
export function resolvedFfmpeg(): string {
  if (cachedBin !== null) return cachedBin;
  const existing = FFMPEG_CANDIDATES.filter((item) => item === 'ffmpeg' || existsSync(item));
  const withDda = existing.find((item) => hasDdagrab(item));
  cachedBin = withDda ?? existing[0] ?? 'ffmpeg';
  cachedDda = withDda !== undefined;
  return cachedBin;
}

/** 当前选的这份能不能 ddagrab（决定用哪套抓屏参数）。 */
export function currentUsesDdagrab(): boolean {
  if (cachedDda === null) resolvedFfmpeg();
  return cachedDda === true;
}

export const CAPTURE_TIMEOUT_MS = 15_000;
/** 抓图默认出的图宽（高按比例），回看与一眼看都用这个 */
export const STILL_WIDTH = 1536;
/** JPEG 质量（ffmpeg -q:v，2 最好、31 最差）；4 = 约 320KB、字还认得清 */
export const STILL_QUALITY = 4;
/** 宽到这个数以上就当 4K 屏：按 1920 取，别压成 1536 */
export const WIDE_SCREEN_WIDTH = 2400;

/**
 * 「按屏幕宽决定出图宽」的 ffmpeg 表达式：窄屏原样、普通屏 1536、超宽屏 1920。
 * 高度一律 -2（保持比例且取偶数，JPEG 的 yuvj420p 要求偶数边）。
 */
export function stillScaleExpression(): string {
  return `scale='trunc(if(gt(iw,${WIDE_SCREEN_WIDTH}),1920,min(iw,${STILL_WIDTH}))/2)*2':-2`;
}

export interface RunOptions {
  ffmpegPath?: string;
  timeoutMs?: number;
  /** 输出写文件时不收 stdout（默认 true = 收字节） */
  expectStdout?: boolean;
}

/** 起一次 ffmpeg，把 stdout 全收回来；非 0 退出或超时都 reject。 */
export function runFfmpeg(args: string[], options: RunOptions = {}): Promise<Buffer> {
  const bin = options.ffmpegPath?.trim() || resolvedFfmpeg();
  const timeoutMs = options.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const expectStdout = options.expectStdout !== false;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    let done = false;
    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        try {
          child.kill();
        } catch {
          /* 已经退了 */
        }
        reject(new Error(`ffmpeg 超时（${timeoutMs}ms）`));
      });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => settle(() => reject(error)));
    child.on('close', (code) => {
      settle(() => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `抓屏退出 ${String(code)}`));
          return;
        }
        if (expectStdout && chunks.length === 0) {
          reject(new Error('抓图没有输出'));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
  });
}

export interface CapturePngOptions extends RunOptions {
  /** 出图宽度，高度按比例；缺省 STILL_WIDTH */
  width?: number;
}

/** 整屏一张 PNG（按宽度等比缩放，不拉伸）。 */
export function capturePng(options: CapturePngOptions = {}): Promise<Buffer> {
  const width = Math.max(160, Math.round(options.width ?? STILL_WIDTH));
  const bin = options.ffmpegPath?.trim() || resolvedFfmpeg();
  const dda = hasDdagrab(bin);
  return runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error',
      ...ddaInput(undefined, dda), '-frames:v', '1',
      '-vf', ddaVf(`scale=${width}:-1,format=rgb24`, dda),
      '-f', 'image2pipe', '-c:v', 'png', 'pipe:1',
    ],
    { ...options, ffmpegPath: bin },
  );
}

export interface CaptureJpegOptions extends RunOptions {
  /** 出图宽度，高度按比例；缺省按屏幕宽现算（见 stillScaleExpression） */
  width?: number;
  /** JPEG 质量，缺省 STILL_QUALITY */
  quality?: number;
}

/** 整屏一张 JPEG（送识图：体积小五倍，字照样认得清）。 */
export function captureJpeg(options: CaptureJpegOptions = {}): Promise<Buffer> {
  const bin = options.ffmpegPath?.trim() || resolvedFfmpeg();
  const dda = hasDdagrab(bin);
  const quality = Math.min(31, Math.max(2, Math.round(options.quality ?? STILL_QUALITY)));
  const scale =
    options.width === undefined
      ? stillScaleExpression()
      : `scale='trunc(${Math.max(160, Math.round(options.width))}/2)*2':-2`;
  return runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error',
      ...ddaInput(undefined, dda), '-frames:v', '1',
      '-vf', ddaVf(`${scale},format=yuvj420p`, dda),
      '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', String(quality), 'pipe:1',
    ],
    { ...options, ffmpegPath: bin },
  );
}

/** 同上，但 250ms 内的同参数请求合并成一次（省一次抓屏）。 */
let pendingPng: { key: string; at: number; promise: Promise<Buffer> } | null = null;

export function capturePngShared(options: CapturePngOptions = {}): Promise<Buffer> {
  const key = `${options.ffmpegPath?.trim() ?? ''}|${Math.round(options.width ?? STILL_WIDTH)}`;
  const now = Date.now();
  if (pendingPng !== null && pendingPng.key === key && now - pendingPng.at < 250) return pendingPng.promise;
  const promise = capturePng(options).finally(() => {
    if (pendingPng?.promise === promise) pendingPng = null;
  });
  pendingPng = { key, at: now, promise };
  return promise;
}

let pendingJpeg: { key: string; at: number; promise: Promise<Buffer> } | null = null;

export function captureJpegShared(options: CaptureJpegOptions = {}): Promise<Buffer> {
  const key = `${options.ffmpegPath?.trim() ?? ''}|${Math.round(options.width ?? 0)}|${options.quality ?? STILL_QUALITY}`;
  const now = Date.now();
  if (pendingJpeg !== null && pendingJpeg.key === key && now - pendingJpeg.at < 250) return pendingJpeg.promise;
  const promise = captureJpeg(options).finally(() => {
    if (pendingJpeg?.promise === promise) pendingJpeg = null;
  });
  pendingJpeg = { key, at: now, promise };
  return promise;
}

export interface CaptureGrayOptions extends RunOptions {
  /** 输出路径（rawvideo 灰度） */
  file: string;
  width?: number;
  height?: number;
}

/** 64×36 灰度小图写到文件（陪伴算指纹用），返回字节数。 */
export async function captureGray(options: CaptureGrayOptions): Promise<number> {
  const width = Math.max(8, Math.round(options.width ?? 64));
  const height = Math.max(8, Math.round(options.height ?? 36));
  const bin = options.ffmpegPath?.trim() || resolvedFfmpeg();
  const dda = hasDdagrab(bin);
  const out = await runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error',
      ...ddaInput(undefined, dda), '-frames:v', '1',
      '-vf', ddaVf(`scale=${width}:${height},format=gray`, dda),
      '-f', 'rawvideo', '-y', options.file,
    ],
    { ...options, ffmpegPath: bin, expectStdout: false },
  );
  return out.length === 0 ? statSync(options.file).size : out.byteLength;
}

/**
 * 整屏 JPEG 直接写文件（**识图看的那张**：陪伴/一眼看都走它）。
 *
 * 为什么是文件：`eyes.look()` 吃路径，图还会留在 `shots/look/` 里方便回看。
 * 宽度缺省按屏幕宽现算（窄屏原样 / 普通屏 1536 / 宽屏 1920，见 stillScaleExpression）。
 */
export async function captureJpegFile(options: CaptureJpegOptions & { file: string }): Promise<number> {
  const quality = Math.min(31, Math.max(2, Math.round(options.quality ?? STILL_QUALITY)));
  const scale =
    options.width === undefined
      ? stillScaleExpression()
      : `scale='trunc(${Math.max(160, Math.round(options.width))}/2)*2':-2`;
  const bin = options.ffmpegPath?.trim() || resolvedFfmpeg();
  const dda = hasDdagrab(bin);
  const out = await runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error',
      ...ddaInput(undefined, dda), '-frames:v', '1',
      '-vf', ddaVf(`${scale},format=yuvj420p`, dda),
      '-q:v', String(quality),
      '-y', options.file,
    ],
    { ...options, ffmpegPath: bin, expectStdout: false },
  );
  return out.length === 0 ? statSync(options.file).size : out.byteLength;
}

/** 64×36 灰度直接回字节（不落文件；陪伴的 `defaultCapture` 用）。 */
export async function captureGrayBytes(options: RunOptions & { width?: number; height?: number } = {}): Promise<Buffer> {
  const width = Math.max(8, Math.round(options.width ?? 64));
  const height = Math.max(8, Math.round(options.height ?? 36));
  const bin = options.ffmpegPath?.trim() || resolvedFfmpeg();
  const dda = hasDdagrab(bin);
  return runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error',
      ...ddaInput(undefined, dda), '-frames:v', '1',
      '-vf', ddaVf(`scale=${width}:${height},format=gray`, dda),
      '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ],
    { ...options, ffmpegPath: bin },
  );
}

/** 整屏 PNG 直接写文件（Alt+G 那张能点开看的图）。 */
export async function capturePngFile(options: CapturePngOptions & { file: string }): Promise<number> {
  const width = Math.max(160, Math.round(options.width ?? 960));
  const bin = options.ffmpegPath?.trim() || resolvedFfmpeg();
  const dda = hasDdagrab(bin);
  const out = await runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error',
      ...ddaInput(undefined, dda), '-frames:v', '1',
      '-vf', ddaVf(`scale=${width}:-1`, dda),
      '-y', options.file,
    ],
    { ...options, ffmpegPath: bin, expectStdout: false },
  );
  return out.length === 0 ? statSync(options.file).size : out.byteLength;
}