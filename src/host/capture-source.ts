/**
 * capture-source.ts —— 抓屏用哪套输入、缩放要不要保持长宽比。
 *
 * 干什么：
 *   1) 给出 ffmpeg 的抓屏输入参数（ddagrab，Desktop Duplication）；
 *   2) 给出「d3d11 帧先下载成普通帧」的那段滤镜前缀；
 *   3) fitInside()：把任意长宽比的图缩进一个框里，**保持比例**。
 *
 * 什么时候用：任何要截屏的地方（陪伴流、回看单张、一眼看、指纹小图）。
 *
 * 什么时候别用：测试里一律注入假的 capture，不要真起 ffmpeg。
 *
 * 常见坑（都是踩出来的）：
 *   - **别用 gdigrab**：它靠 BitBlt 从屏幕 DC 取像素，和 DWM 合成不同步时会拿到
 *     「折纸一样」的旧块 / 缺块（哥哥 11-18 报的「整体变形、像折纸」）。ddagrab 读的是
 *     合成之后的桌面帧，稳定得多。本机两套 ffmpeg（RVC 与 .dsh/tools）都带 ddagrab。
 *   - ddagrab 吐的是 **d3d11 硬件帧**，后面任何 scale/format 之前必须
 *     `hwdownload,format=bgra`，否则滤镜链直接报错。
 *   - ddagrab 的帧率写在它自己的参数里（`ddagrab=0:framerate=12`），
 *     不能像 gdigrab 那样用 `-framerate`；也别再串一个 fps 滤镜去救。
 *   - **别把任意长宽比硬压成固定尺寸**：1941×1243 塞进 1280×800 就是单向拉伸，
 *     字会糊；窄窗口更惨（横拉 2 倍）。要缩只用 fitInside()。
 */

/**
 * 抓屏输入：`-f lavfi -i ddagrab=0:framerate=N`（不传 fps 就是它自己的默认节奏）。
 *
 * 【汐儿 · 11-19 m30590】`useDda=false` 时退回 gdigrab。哥哥机器上 `watchFfmpeg()`
 * 曾经硬编码 `D:\AI\GPT-SoVITS\ffmpeg.exe`，那份**没有 ddagrab**（`-filters` 里查不到），
 * 结果陪伴抓屏连着三次 `No such filter: 'ddagrab'` 直接自动停。能不能用由 `capture.ts`
 * 的 `hasDdagrab()` 探测，这里只按开关拼参数。
 */
export function ddaInput(fps?: number, useDda = true): string[] {
  if (!useDda) {
    const args = ['-f', 'gdigrab', '-i', 'desktop'];
    if (fps !== undefined) args.splice(2, 0, '-framerate', String(fps));
    return args;
  }
  const source = fps === undefined ? 'ddagrab=0' : `ddagrab=0:framerate=${fps}`;
  return ['-f', 'lavfi', '-i', source];
}

/** d3d11 帧下载成普通帧的前缀：任何 scale / format 之前都得先过它。 */
export const DDA_DOWNLOAD = 'hwdownload,format=bgra';

/** 拼滤镜链：`hwdownload,format=bgra,<rest>`（rest 为空就只下载）。gdigrab 出的已经是普通帧，不加前缀。 */
export function ddaVf(rest: string, useDda = true): string {
  if (!useDda) return rest.trim();
  const tail = rest.trim();
  return tail === '' ? DDA_DOWNLOAD : `${DDA_DOWNLOAD},${tail}`;
}

export interface FitBox {
  width: number;
  height: number;
}

/**
 * 保持长宽比地缩进 `maxW × maxH` 的框里（只缩不放）。
 * 源比框还小就原样返回 —— 放大只会多花 token，不会多出信息。
 */
export function fitInside(srcW: number, srcH: number, maxW: number, maxH: number): FitBox {
  if (!(srcW > 0) || !(srcH > 0) || !(maxW > 0) || !(maxH > 0)) {
    return { width: Math.max(1, Math.round(maxW) || 1), height: Math.max(1, Math.round(maxH) || 1) };
  }
  const scale = Math.min(maxW / srcW, maxH / srcH, 1);
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}