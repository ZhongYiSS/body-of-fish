/**
 * 微软 Edge 在线朗读（免费、要联网、音色自然）。
 *
 * 走 `msedge-tts`（已装进 package.json 依赖并随打包内联进 lib/standalone.js，
 * 所以安装包里自带、用户机器不用再装 —— 哥哥 10-31 定「直接放在安装包里」）。
 *
 * 为什么不用 Node 自带 WebSocket：Edge 的朗读接口要自定义 Origin/User-Agent 头，
 * 内置 WebSocket 发不了，连上去直接被拒（10-31 实测）。
 *
 * 输出是 mp3；mime 由 `create-pet-services` 的字节嗅探判定，这里不管。
 */
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export interface EdgeOptions {
  /** 音色名，如 zh-CN-XiaoxiaoNeural；留空用默认女声 */
  voice?: string;
  /** 语速，如 '+0%' / '-10%'；留空用原速 */
  rate?: string;
  timeoutMs?: number;
}

/** 本鱼用的默认音色：晓晓（中文女声，自然度高、免费） */
export const DEFAULT_EDGE_VOICE = 'zh-CN-XiaoxiaoNeural';

const DEFAULT_TIMEOUT_MS = 30_000;

function collect(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Edge 朗读超时了（联网不通或服务忙）'));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeAllListeners?.();
    };
    stream.on('data', (chunk: Buffer | Uint8Array) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('error', (error: Error) => {
      cleanup();
      reject(new Error(`Edge 朗读失败：${error.message}`));
    });
    stream.on('end', () => {
      cleanup();
      const audio = Buffer.concat(chunks);
      if (audio.length === 0) {
        reject(new Error('Edge 朗读回了空音频'));
        return;
      }
      resolve(new Uint8Array(audio));
    });
  });
}

export async function edgeSpeak(text: string, options: EdgeOptions = {}): Promise<Uint8Array> {
  const voice = options.voice?.trim() || DEFAULT_EDGE_VOICE;
  // 空音频是网络侧偶发（实测同一台机器：01:40 回空、01:44 同一条 1.3 秒出 15KB），重试一次基本都回来。
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(text, options.rate ? { rate: options.rate } : undefined);
      return await collect(audioStream as NodeJS.ReadableStream, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    } catch (error) {
      // 认得出是网络问题就给一句能照着办的话；其余原样带上（别吞掉真正的原因）
      const message = error instanceof Error ? error.message : String(error);
      lastError = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|Network/i.test(message)
        ? new Error(`Edge 朗读连不上（要联网）：${message}`)
        : error instanceof Error
          ? error
          : new Error(message);
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      try {
        tts.close();
      } catch {
        /* 关不掉就算了，别把已拿到的音频丢掉 */
      }
    }
  }
  throw lastError ?? new Error('Edge 朗读失败');
}
