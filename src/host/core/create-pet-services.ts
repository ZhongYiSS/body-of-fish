/**
 * 对外服务（PetServices）的**实现层**：气泡 / 嘴 / 眼，一套实现、两条入口。
 *
 * 哥哥 m00766：「声音和识图也需要保留接口，方便 DSH 通过桌宠发音和识图，气泡也需要做好接口」。
 * 于是这里只写一次，供两条路调用：
 *   - 进程内：插件里 `ctx.get('petApi7340').services`（DSH 同级插件直接调，零 HTTP）
 *   - 跨进程：HTTP `POST /services/bubble|voice|eyes`（外部程序 / QQ 那边要用时走这条）
 *
 * 三条纪律：
 *  1. **不许自己拼后端**：嘴和眼一律过 ModelGateway（配置改了立刻生效，且失败原因统一）；
 *  2. 失败**结构化抛出**（ServiceError 带 code + 中文原因），不返回"半个成功"；
 *  3. 气泡的常驻（sticky）不被闲聊顶掉 —— 判定复用契约层的 `canReplace`。
 */
import { readFile } from 'node:fs/promises';

import type {
  BubbleHandle,
  BubbleRequest,
  BubbleView,
  EyeRequest,
  EyeResult,
  PetServices,
  VoiceRequest,
  VoiceResult,
} from './pet-services';
import { canReplace, isEmptyBubble } from './pet-services';
import type { PetCoreRuntime } from './create-pet-core';
import type { PetStateView } from './pet-core';
import type { ModelGateway, ModelStatus } from './model-gateway';

/**
 * 按文件头判音频格式（不看 Content-Type：本机服务常常给 `application/octet-stream`）。
 * 目前只认 wav 和 mp3 两种 —— 桌宠用得上的就这两个，认不出按 mp3 处理（老行为）。
 */
function sniffAudioMime(audio: Uint8Array): string {
  const b = audio;
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) {
    return 'audio/wav'; // "RIFF"…"WAVE"
  }
  if (b.length >= 3 && ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))) {
    return 'audio/mpeg'; // "ID3" 或帧同步字
  }
  return 'audio/mpeg';
}

/** 服务失败：code 给程序判断，message 给调用方/日志看。 */
export class ServiceError extends Error {
  readonly code: 'bad-request' | 'busy' | 'not-configured' | 'failed';

  constructor(code: ServiceError['code'], message: string) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

export interface PetServicesDeps {
  /** 只用到写气泡/读状态这三件（便于测试注入假的） */
  core: Pick<PetCoreRuntime, 'say' | 'state' | 'writePetSection'>;
  gateway: Pick<ModelGateway, 'vision' | 'speak' | 'status'>;
  /** 读本机图片（识图用）；默认 fs.readFile，测试可注入 */
  readImage?(path: string): Promise<Uint8Array>;
  /** 声音后端是本地还是网络（VoiceResult.backend 要给调用方看）；缺省按 remote */
  ttsKind?(): 'local' | 'remote';
  now?(): number;
}

/** 气泡 id：递增 + 时间戳，够唯一、也方便日志里对时间。 */
function makeBubbleId(seq: number, at: number): string {
  return `b${at.toString(36)}-${seq}`;
}

export function createPetServices(deps: PetServicesDeps): PetServices {
  const now = deps.now ?? Date.now;
  const readBytes = deps.readImage ?? ((path: string) => readFile(path));
  /** petId → 当前气泡（进程内存态；桌宠重启就没了，不需要持久化） */
  const bubbles = new Map<string, BubbleView>();
  let seq = 0;

  const clearBubble = async (petId: string): Promise<void> => {
    // 与 POST /bubble/clear 同一份语义：写 `{clear:true}` 叶子，前端收到就收气泡
    deps.core.writePetSection(petId, 'say', { clear: true });
    bubbles.delete(petId);
  };

  const services: PetServices = {
    bubble: {
      async say(request: BubbleRequest): Promise<BubbleHandle> {
        if (isEmptyBubble(request)) {
          throw new ServiceError('bad-request', '气泡里既没字也没图');
        }
        // 常驻气泡不被闲聊顶掉：给调用方一个明确的 busy，而不是悄悄丢掉
        if (!canReplace(bubbles.get(request.petId) ?? null, request)) {
          throw new ServiceError('busy', '上一条是常驻气泡，先收起来再发新的');
        }
        const outcome = deps.core.say({
          petId: request.petId,
          text: request.text,
          image: request.image,
          duration: request.duration,
          anim: request.anim,
          // 【本鱼修 · 10-30】这里原来传 undefined，而 core 的门禁要求 surface 必填
          // （HTTP 路由靠 ?surface=，进程内服务没有 query）→ 每一次 bubble.say 都被判
          // bad-request，陪伴 / 菜单状态 / 碎碎念的气泡全部静默失败。
          // 进程内功能的目标是「哪端在显示就写哪端」，所以显式给 any（`display: none` 仍会被拒）。
          surface: 'any',
        });
        if (!outcome.ok) throw new ServiceError('failed', outcome.message || outcome.reason);
        seq += 1;
        const view: BubbleView = {
          id: makeBubbleId(seq, now()),
          text: request.text,
          ...(request.image ? { image: request.image } : {}),
          sticky: request.sticky === true,
          at: now(),
        };
        bubbles.set(request.petId, view);
        return { id: view.id, clear: () => clearBubble(request.petId) };
      },

      clear: clearBubble,

      current(petId: string): BubbleView | null {
        return bubbles.get(petId) ?? null;
      },
    },

    voice: {
      async speak(request: VoiceRequest): Promise<VoiceResult> {
        if (!request.text.trim()) throw new ServiceError('bad-request', '没话可念');
        try {
          const audio = await deps.gateway.speak(request.text, { voice: request.voice });
          // 音量格式别靠猜：GPT-SoVITS 回 wav、OpenAI 兼容回 mp3，前端要用它决定怎么播
          return { audio, mime: sniffAudioMime(audio), backend: deps.ttsKind?.() ?? 'remote' };
        } catch (error) {
          throw new ServiceError('failed', error instanceof Error ? error.message : String(error));
        }
      },

      available(): ModelStatus {
        return deps.gateway.status().tts ?? { ready: false, reason: { code: 'not-configured', message: '没配置' } };
      },
    },

    eyes: {
      async look(request: EyeRequest): Promise<EyeResult> {
        let bytes: Uint8Array;
        if (typeof request.image === 'string') {
          try {
            bytes = await readBytes(request.image);
          } catch (error) {
            throw new ServiceError(
              'bad-request',
              `读不到这张图：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } else {
          bytes = request.image;
        }
        if (bytes.byteLength === 0) throw new ServiceError('bad-request', '图片是空的');
        try {
          const text = await deps.gateway.vision(bytes, request.prompt ?? '看图说一句，20 字以内。');
          return { text, backend: 'remote' };
        } catch (error) {
          throw new ServiceError('failed', error instanceof Error ? error.message : String(error));
        }
      },

      available(): ModelStatus {
        return deps.gateway.status().vision ?? { ready: false, reason: { code: 'not-configured', message: '没配置' } };
      },
    },

    snapshot(): PetStateView {
      return deps.core.state() as unknown as PetStateView;
    },
  };
  return services;
}
