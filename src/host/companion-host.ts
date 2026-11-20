/**
 * 陪伴模式的**宿主适配层**：把 companion.ts 里那些"注入进来的副作用"落到真实实现上。
 *
 * companion.ts 自己是干净的（不碰网络、不碰文件、不 import shared），
 * 真正截屏、识图、冒泡、出声都在这里接：
 *
 *   截屏  → ffmpeg gdigrab，抓一张 PNG（给识图看）+ 一张 64×36 灰度 raw（算指纹）
 *   识图  → services.eyes.look（模型网关的 vision 后端，本地/网络都行）
 *   冒泡  → services.bubble.say（对外服务，Sticky 语义与手点一样）
 *   出声  → services.voice.speak（tts 后端）→ 播放用 ffplay
 *
 * 为什么截两次：指纹要的是**同一时刻**的小图（省内存、算得快），识图要的是能看清的整图。
 * 一次 ffmpeg 只能出一样，所以并发跑两个进程；只有陪伴开着的时候才会跑（默认关）。
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { captureGray, captureJpegFile } from './capture';
import { THUMB_BYTES } from './companion';

export interface ScreenCapture {
  /** 64×36 灰度 rawvideo（2304 字节），给 companion 算指纹 */
  capture(): Promise<Uint8Array>;
  /** 最近一次截到的整图路径（识图用）；还没截过 → undefined */
  lastShotPath(): string | undefined;
}

export interface ScreenCaptureOptions {
  /** ffmpeg 可执行文件；缺省用 PATH 里的 ffmpeg */
  ffmpegPath?: string;
  /** 工作目录（临时图存这里，退出不清也无所谓，覆盖写） */
  dir: string;
  /** 全屏截图的宽度；不传就按屏幕宽现算（1536 / 宽屏 1920），高度按比例 */
  width?: number;
}

/**
 * 造一个"截屏 + 保全图"的实现。
 *
 * 注意：**这是本机会碰硬件的能力**，所以只在陪伴模式真的开着时才会被调用；
 * 默认配置里陪伴是关的，不会有人偷偷截屏。
 */
export function createScreenCapture(options: ScreenCaptureOptions): ScreenCapture {
  const ffmpeg = options.ffmpegPath?.trim() || 'ffmpeg';
  const dir = options.dir;
  const width = options.width;
  let shot: string | undefined;
  let seq = 0;

  return {
    async capture(): Promise<Uint8Array> {
      mkdirSync(dir, { recursive: true });
      seq += 1;
      // 识图看的那张改 JPEG（2026-11-20 m31592）：1536~1920 宽、qv4，约 320~460KB，
      // 比原来 960 宽的 PNG 又清楚又小。算指纹的小图仍是 raw（2304 字节）。
      const jpg = join(dir, `shot-${seq % 4}.jpg`);
      // 【11-20 体检】指纹（2304 字节的灰度小图）和给人看的截图原来混在同一层，
      // 翻目录时一堆 .raw 看不出哪个是图。挪进 thumbs/，顺手清掉老位置留下的那 4 个。
      const thumbDir = join(dir, 'thumbs');
      mkdirSync(thumbDir, { recursive: true });
      for (let i = 0; i < 4; i += 1) rmSync(join(dir, `thumb-${i}.raw`), { force: true });
      const raw = join(thumbDir, `thumb-${seq % 4}.raw`);
      // 0.6 起截图只有 jpg（原先是 960 宽的 png）。同一个槽位写过 jpg 就把老 png 清掉，
      // 免得两次改版留下的旧格式越攒越多（哥哥 m32229：「该合并的合并」）。
      rmSync(join(dir, `shot-${seq % 4}.png`), { force: true });
      // 两个进程并发：一个出能看的整图，一个出算指纹的小图（都走 capture.ts，超时一致）
      await Promise.all([
        captureJpegFile({ ffmpegPath: ffmpeg, file: jpg, ...(width === undefined ? {} : { width }) }),
        captureGray({ ffmpegPath: ffmpeg, file: raw }),
      ]);
      shot = jpg;
      const bytes = readFileSync(raw);
      if (bytes.byteLength < THUMB_BYTES) {
        throw new Error(`截图太小：${bytes.byteLength} 字节（期望 ${THUMB_BYTES}）`);
      }
      return new Uint8Array(bytes.subarray(0, THUMB_BYTES));
    },
    lastShotPath(): string | undefined {
      return shot;
    },
  };
}
