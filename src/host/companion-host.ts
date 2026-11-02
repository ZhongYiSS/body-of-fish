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
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { THUMB_BYTES } from './companion';

/** 跑一个命令，收下 stdout（stderr 只留最后一行用于报错）。 */
function run(command: string, args: string[], timeoutMs = 10_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令超时：${command}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      err = String(chunk).slice(-500);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${command} 退出码 ${code}：${err.trim()}`));
    });
  });
}

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
  /** 全屏截图的宽度（高度按 16:9 算给 ffmpeg，实际按屏幕比例裁切） */
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
  const width = options.width ?? 960;
  let shot: string | undefined;
  let seq = 0;

  return {
    async capture(): Promise<Uint8Array> {
      mkdirSync(dir, { recursive: true });
      seq += 1;
      const png = join(dir, `shot-${seq % 4}.png`);
      const raw = join(dir, `thumb-${seq % 4}.raw`);
      // 两个进程并发：一个出能看的整图，一个出算指纹的小图
      await Promise.all([
        run(ffmpeg, [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'gdigrab', '-framerate', '1', '-i', 'desktop',
          '-frames:v', '1', '-vf', `scale=${width}:-1`, '-y', png,
        ]),
        run(ffmpeg, [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'gdigrab', '-framerate', '1', '-i', 'desktop',
          '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-y', raw,
        ]),
      ]);
      shot = png;
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
