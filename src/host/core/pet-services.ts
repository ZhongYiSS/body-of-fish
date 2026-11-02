/**
 * 桌宠 2.0 · 对外服务契约（DSH / QQ / 别的插件都能用桌宠的嘴、眼、气泡）
 *
 * 哥哥 10-30 补的第 4 条：
 *   "声音和识图也要保留接口，方便 DSH 通过桌宠发音和识图，气泡也要做好接口。"
 *
 * 所以分成两向：
 *   - 向内（ModelGateway）：桌宠要调模型时，可选会话 / 网络 / 本地。
 *   - 向外（PetServices）：别人要用桌宠的**嘴**（TTS）、**眼**（识图）、**气泡**（说话配图）时，
 *     走这个契约。桌宠是家里唯一长着嘴和眼睛的，别人别各自再造一套。
 *
 * 铁律：
 *   1. 只有类型 + 纯函数守卫，不碰网络文件。
 *   2. **对外只有一份真相**：bubble/voice/eyes 最终都要落到 core 的同一套状态与网关上，
 *      不允许"对外接口自己再实现一遍"。
 *   3. 不许 import src/shared（DSH 单文件加载会拆 chunk）。
 *   4. 跨进程（QQ、别的应用）走 HTTP 路由，进程内（DSH 插件）走 `ctx.get('petApi7340')`；
 *      两条入口共用同一实现。
 */
import type { ModelStatus } from './model-gateway.ts';
import type { PetStateView } from './pet-core.ts';

/** 气泡请求：桌宠说话的唯一入口（碎碎念、对话、陪伴、外部插件都走它）。 */
export interface BubbleRequest {
  /** 哪只宠物；单宠物场景固定 'main' */
  petId: string;
  text: string;
  /** 本地图片绝对路径（素材不过桥，与现有约定一致） */
  image?: string;
  /** 显示时长（毫秒）；0 = 一直留着，等 clear */
  duration?: number;
  /** 重要提示：不被新的碎碎念/闲聊顶掉 */
  sticky?: boolean;
  /** 说话同时切动作名（assets/webm 里的名字） */
  anim?: string;
  /** 来源标记，方便排查是谁在说话 */
  source?: 'chat' | 'companion' | 'dsh' | 'qq' | 'system';
}

export interface BubbleHandle {
  id: string;
  clear(): Promise<void>;
}

/** 气泡当前长什么样；给设置页、手机端、调试用。 */
export interface BubbleView {
  id: string;
  text: string;
  image?: string;
  sticky: boolean;
  at: number;
}

export interface VoiceRequest {
  text: string;
  /** GPT-SoVITS 的参考音/角色名；不填用配置默认 */
  voice?: string;
  /** 语速/音高这类调参，透传给后端，不认识的字段由后端忽略 */
  params?: Record<string, string | number>;
}

export interface VoiceResult {
  audio: Uint8Array;
  mime: string;
  /** 走了哪个后端，便于排查"到底用的本地还是网络" */
  backend: 'local' | 'remote';
}

export interface EyeRequest {
  /** 本地图片路径，或直接给字节 */
  image: string | Uint8Array;
  /** 想让它看什么；不填用默认提示词 */
  prompt?: string;
}

export interface EyeResult {
  text: string;
  backend: 'local' | 'remote';
}

/** 别人能拿到的全部能力。 */
export interface PetServices {
  bubble: {
    say(request: BubbleRequest): Promise<BubbleHandle>;
    clear(petId: string): Promise<void>;
    current(petId: string): BubbleView | null;
  };
  voice: {
    /** 桌宠出声；内部走 ModelGateway.tts，不另起一套 */
    speak(request: VoiceRequest): Promise<VoiceResult>;
    available(): ModelStatus;
  };
  eyes: {
    /** 桌宠看图；内部走 ModelGateway.vision */
    look(request: EyeRequest): Promise<EyeResult>;
    available(): ModelStatus;
  };
  /** 只读快照：别人想知道宠物现在在说什么、什么动作 */
  snapshot(): PetStateView;
}

/**
 * 气泡优先级：sticky 的不能被非 sticky 顶掉。返回 true 表示"新的可以覆盖旧的"。
 * 这是纯函数，方便在 core 里只写一次判定。
 */
export function canReplace(current: BubbleView | null, incoming: Pick<BubbleRequest, 'sticky'>): boolean {
  if (!current) return true;
  if (current.sticky && !incoming.sticky) return false;
  return true;
}

/** 外部来源的默认显示时长（毫秒）：短一点，别把桌宠变成弹幕机 */
export const EXTERNAL_BUBBLE_MS = 8_000;

/** 一条气泡请求至少要有话说或者有图；两个都空直接拒绝，别让桌宠冒个空气泡。 */
export function isEmptyBubble(request: Pick<BubbleRequest, 'text' | 'image'>): boolean {
  return request.text.trim().length === 0 && !request.image;
}
