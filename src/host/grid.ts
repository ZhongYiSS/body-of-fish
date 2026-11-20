/**
 * 宫格拼图（哥哥 11-19 m30759/m30766 要的）：把过去几张截图拼成 3×2 一张，
 * 让识图模型一眼看到「刚才那两分钟发生了什么」，而不是只看一张单帧。
 *
 * 干什么：把 N 张 PNG（最多 6 张）用 ffmpeg xstack 拼成一张，每格左上角烧时间戳。
 * 什么时候用：陪伴模式判「值不值得开口」那一步（watchSheet 里调 eyes.look 之前）。
 * 什么时候别用：手动「看一眼」——那边要的是「现在这一屏」，拼图反而糊（哥哥 m30766 定的）。
 * 常见坑：
 *   1. filtergraph 里 `:` 是参数分隔符，Windows 字体路径 `C:/...` 必须写成 `C\:/...`；
 *      时间文本 `12:04:05` 也要写成 `12\:04\:05`，不然 ffmpeg 把它当参数。
 *   2. 输入必须等长——帧不够就拿最后一帧重复占位，少一个输入 xstack 会直接报错。
 *   3. 输出只取一帧（`-frames:v 1`），否则 ffmpeg 会一直等下一帧挂住。
 *   4. 每格先 scale（保持比例）+ pad 补黑边，别硬拉——11-18 那个「折纸」变形就是这么来的。
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';

export const GRID_COLS = 3;
export const GRID_ROWS = 2;
export const GRID_FRAMES = GRID_COLS * GRID_ROWS;
export const CELL_W = 512;
export const CELL_H = 340;

/** 一张要拼进去的图：文件路径 + 拍下来的时刻（毫秒）。 */
export interface GridFrame {
  file: string;
  at: number;
}

export interface GridInput {
  frames: readonly GridFrame[];
  out: string;
  ffmpegPath?: string;
  cols?: number;
  rows?: number;
  cellW?: number;
  cellH?: number;
  timeoutMs?: number;
}

export interface GridResult {
  ok: boolean;
  out: string;
  frames: number;
  bytes: number;
  ms: number;
  message?: string;
}

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/segoeui.ttf',
  'C:/Windows/Fonts/arial.ttf',
];

/** 挑一个能用的字体（烧时间戳用）；都没有就返回空串，此时不烧字也不报错。 */
export function pickFont(): string {
  for (const item of FONT_CANDIDATES) {
    if (existsSync(item)) return item;
  }
  return '';
}

/** 把 `:` 与 `\` 转义成 filtergraph 能吃的写法。 */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/:/gu, '\\:').replace(/'/gu, "\\'");
}

/** 字体路径要**两个**反斜杠：filtergraph 解一层、drawtext 再解一层（实测，少一层直接报
 *  `No option name near '/Windows/...'`）。 */
export function escapeFontPath(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/:/gu, '\\\\:');
}

/** 时间戳文本 `HH:MM:SS`（本地时区）。 */
export function stampText(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 帧不够就重复最后一帧补齐；一张都没有返回空数组。 */
export function padFrames(frames: readonly GridFrame[], count = GRID_FRAMES): GridFrame[] {
  const keep = frames.filter((frame) => frame.file !== '').slice(-count);
  if (keep.length === 0) return [];
  const padded = keep.slice();
  while (padded.length < count) {
    padded.push(keep[keep.length - 1] as GridFrame);
  }
  return padded;
}

/** xstack 的 layout 字符串：`0_0|512_0|1024_0|0_340|...`。 */
export function layoutOf(
  cols = GRID_COLS,
  rows = GRID_ROWS,
  cellW = CELL_W,
  cellH = CELL_H,
): string {
  const cells: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      cells.push(`${col * cellW}_${row * cellH}`);
    }
  }
  return cells.join('|');
}

/** 一个格子的滤镜：等比缩放 → 补边 → 左上角烧时间。 */
export function cellFilter(
  index: number,
  at: number,
  options: { cellW?: number; cellH?: number; font?: string } = {},
): string {
  const w = options.cellW ?? CELL_W;
  const h = options.cellH ?? CELL_H;
  const font = options.font ?? '';
  const parts = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x14181C`,
  ];
  if (font !== '') {
    const text = escapeFilterValue(stampText(at));
    const fontFile = escapeFontPath(font);
    parts.push(
      `drawtext=fontfile=${fontFile}:text='${text}':x=12:y=10:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=6`,
    );
  }
  return `[${index}:v]${parts.join(',')}[g${index}]`;
}

/** 拼出完整的 ffmpeg 参数（纯函数，方便测）。 */
export function gridArgs(input: GridInput): string[] {
  const cols = input.cols ?? GRID_COLS;
  const rows = input.rows ?? GRID_ROWS;
  const cellW = input.cellW ?? CELL_W;
  const cellH = input.cellH ?? CELL_H;
  const frames = padFrames(input.frames, cols * rows);
  const font = pickFont();
  const args = ['-hide_banner', '-loglevel', 'error'];
  for (const frame of frames) args.push('-i', frame.file);
  const chains = frames.map((frame, index) => cellFilter(index, frame.at, { cellW, cellH, font }));
  const inputs = frames.map((_, index) => `[g${index}]`).join('');
  chains.push(
    `${inputs}xstack=inputs=${frames.length}:layout=${layoutOf(cols, rows, cellW, cellH)}:fill=black`,
  );
  // 出 JPEG（送识图用）：-q:v 4 ≈ 每格字还认得清，整张 3×2 约 300~600KB
  args.push('-filter_complex', chains.join(';'), '-frames:v', '1', '-q:v', '4', '-y', input.out);
  return args;
}

/** 跑一次 ffmpeg（失败把 stderr 带出来，别吞）。 */
function runFfmpeg(bin: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      bin,
      args as string[],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error !== null) {
          const detail = String(stderr ?? '').trim() || error.message;
          reject(new Error(detail));
          return;
        }
        resolve();
      },
    );
  });
}

/** 真拼一张：返回字节数与耗时（失败不抛，回 ok:false）。 */
export async function composeGrid(input: GridInput): Promise<GridResult> {
  const started = Date.now();
  const frames = padFrames(input.frames, (input.cols ?? GRID_COLS) * (input.rows ?? GRID_ROWS));
  if (frames.length === 0) {
    return { ok: false, out: input.out, frames: 0, bytes: 0, ms: 0, message: '没有可拼的帧' };
  }
  const bin = input.ffmpegPath !== undefined && input.ffmpegPath.trim() !== '' ? input.ffmpegPath : 'ffmpeg';
  const timeoutMs = input.timeoutMs ?? 20_000;
  const args = gridArgs({ ...input, frames });
  try {
    await runFfmpeg(bin, args, timeoutMs);
  } catch (error) {
    return {
      ok: false,
      out: input.out,
      frames: frames.length,
      bytes: 0,
      ms: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const ok = existsSync(input.out);
  const bytes = ok ? statSync(input.out).size : 0;
  if (!ok) {
    return { ok: false, out: input.out, frames: frames.length, bytes: 0, ms: Date.now() - started, message: '拼图没生成' };
  }
  return { ok: true, out: input.out, frames: frames.length, bytes, ms: Date.now() - started };
}

/** 删除临时输入/输出（失败忽略）。 */
export function removeQuietly(files: readonly string[]): void {
  for (const file of files) {
    try {
      unlinkSync(file);
    } catch {
      /* 删不掉就算了 */
    }
  }
}