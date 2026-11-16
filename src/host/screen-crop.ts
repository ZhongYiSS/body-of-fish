/**
 * screen-crop.ts —— 把整屏帧裁成「指定窗口那一块」（本鱼 · 11-16 m21257）
 *
 * 为什么在内存里裁，而不是让 gdigrab 只抓窗口那块：
 *   `watch-mode.ts` 里记着 11-10 那次失败 —— `GetWindowRect` 给的是**逻辑像素**，
 *   gdigrab 的 `-offset_x / -video_size` 按**物理像素**算，150% 缩放就差 1.5 倍，
 *   结果「插件只看到屏幕左上角，而且看不出是坏的」。所以现在固定整屏抓，
 *   窗口矩形先按屏幕缩放比换算成帧坐标，再在内存里裁 —— 换算错了最多裁偏，
 *   不会出现「抓不到画面」这种硬伤；而且越界、太小一律回退整屏。
 *
 * 两条底线（哥哥 m21310：「截屏的重点是稳定，不要出现只截一部分的情况」）：
 *   1. 矩形先外扩 `CROP_PAD` 像素（宁多截，不少截），再夹进屏幕；
 *   2. 宽或高小于 `CROP_MIN_SIDE`、或面积不到屏幕 1% → 判定不可信，回 `null`（调用方退回整屏）。
 */

import type { Rect } from './screen-target';

/** 外扩边距：宁可多截一圈边框，也不要把窗口边缘切掉 */
export const CROP_PAD = 8;
/** 太小的矩形不可信（多半是 GetWindowRect 拿错了窗口） */
export const CROP_MIN_SIDE = 240;

/**
 * 窗口矩形 → 可信的裁剪矩形。
 * @param rect   窗口矩形（屏幕物理像素）
 * @param screen 屏幕尺寸（只要 w/h）
 * @returns 夹好、扩好的矩形；不可信时 `null`
 */
export function normalizeRect(rect: Rect, screen: Rect, pad = CROP_PAD): Rect | null {
  const sw = Math.round(screen.w);
  const sh = Math.round(screen.h);
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return null;
  const w = Math.round(rect.w);
  const h = Math.round(rect.h);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w <= 0 || h <= 0) return null;
  if (sw <= 0 || sh <= 0) return null;
  const left = Math.max(0, Math.round(rect.x) - pad);
  const top = Math.max(0, Math.round(rect.y) - pad);
  const right = Math.min(sw, Math.round(rect.x) + w + pad);
  const bottom = Math.min(sh, Math.round(rect.y) + h + pad);
  const cw = right - left;
  const ch = bottom - top;
  if (cw < CROP_MIN_SIDE || ch < CROP_MIN_SIDE) return null;
  if (cw * ch < sw * sh * 0.01) return null;
  return { x: left, y: top, w: cw, h: ch };
}

export interface CroppedFrame {
  readonly data: Buffer;
  readonly w: number;
  readonly h: number;
}

/**
 * 从整屏 RGB 帧里裁一块。
 * @returns 裁好的帧（带宽高）；参数不可信时 `null`（调用方用整帧）
 */
export function cropFrame(
  frame: Buffer,
  frameW: number,
  frameH: number,
  screen: Rect,
  rect: Rect,
): CroppedFrame | null {
  const box = normalizeRect(rect, screen);
  if (box === null) return null;
  const scaleX = frameW / screen.w;
  const scaleY = frameH / screen.h;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return null;
  const x0 = Math.max(0, Math.min(frameW - 1, Math.round(box.x * scaleX)));
  const y0 = Math.max(0, Math.min(frameH - 1, Math.round(box.y * scaleY)));
  const x1 = Math.max(x0 + 1, Math.min(frameW, Math.round((box.x + box.w) * scaleX)));
  const y1 = Math.max(y0 + 1, Math.min(frameH, Math.round((box.y + box.h) * scaleY)));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 16 || h < 16) return null;
  const out = Buffer.alloc(w * h * 3);
  for (let row = 0; row < h; row += 1) {
    const from = ((y0 + row) * frameW + x0) * 3;
    frame.copy(out, row * w * 3, from, from + w * 3);
  }
  return { data: out, w, h };
}
