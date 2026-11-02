/**
 * 桌宠 2.0 · 模型网关契约
 *
 * 哥哥 10-30 的清单：**所有要调模型的功能都必须是可选后端** ——
 * 聊天能走"会话"或"自己的 key"；识图、声音能选本地或网络；空 key 就明说，别静默降级。
 *
 * 四条铁律（与 pet-core.ts 同源）：
 *   1. 只有类型 + 纯函数守卫，不碰网络、不碰文件（实现放在 adapters/ 下）。
 *   2. 任何地方要调模型都必须从 ModelGateway 走；core 里不许直接 fetch 供应商。
 *   3. 不许 import src/shared —— DSH 单文件加载会拆 chunk，一引就加载失败。
 *   4. 失败一律结构化返回（ModelError），不允许"假装成功"。
 */

/** 三类能力：说话、看图片、出声。 */
export type ModelCapability = 'chat' | 'vision' | 'tts';

/**
 * 后端三选一：
 *  - session：走 DSH 的当前会话（零 key，只有 chat 支持）
 *  - remote ：OpenAI 兼容服务（字段名与 src/standalone/ai-config.ts 对齐：baseUrl / model / apiKey）
 *  - local  ：本机服务（LM Studio、识图.py、GPT-SoVITS 都是这一种）
 */
/**
 * 本地发声服务的**协议**。
 *
 * - `openai`（默认）：OpenAI 兼容的 `POST /audio/speech`，回音频字节；
 * - `sovits`：GPT-SoVITS 的 `GET /tts?...`（家里那只「本鱼嗓子」就是它）。
 *
 * 为什么要分协议而不是"自动探测"：两者请求形状完全不同，猜错了只回一句看不懂的
 * 400/404；让用户在设置页点明"我这台是哪一种"，失败原因才看得懂。
 * 参考音与参考文本是 GPT-SoVITS 必需的（它靠这几秒音频定音色），所以一起放这里。
 */
export interface SpeakProtocolOptions {
  /**
   * 朗读协议。四个值各有各的说话方式：
   *   openai —— 标准 `/audio/speech`（大多数付费/自建接口）
   *   sovits —— GPT-SoVITS 的 `/tts`（本机嗓子，音色靠参考音）
   *   system —— Windows 自带 SAPI（**离线、免费、不要 key**，音色是机器音）
   *   edge   —— 微软 Edge 的在线朗读（免费、要联网，音色自然）
   */
  protocol?: 'openai' | 'sovits' | 'system' | 'edge';
  /** GPT-SoVITS 参考音：服务端能读到的**本机绝对路径** */
  refAudioPath?: string;
  /** 参考音里念的那句话（越准音色越稳） */
  promptText?: string;
  promptLang?: string;
  textLang?: string;
  /** 语速，1 = 原速 */
  speedFactor?: number;
}

export type Backend =
  | { kind: 'session' }
  | ({ kind: 'remote'; baseUrl: string; model: string; apiKey?: string } & SpeakProtocolOptions)
  | ({ kind: 'local'; endpoint: string; model?: string } & SpeakProtocolOptions);

/** 某个能力的配置：开关 + 后端。 */
export interface CapabilityConfig {
  enabled: boolean;
  backend: Backend;
}

export type ModelConfig = Record<ModelCapability, CapabilityConfig>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  text: string;
  /** 本地图片绝对路径（素材不过桥，与现有约定一致） */
  image?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export type ChatDelta =
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; error: ModelError };

export type ModelErrorCode =
  | 'not-configured'
  | 'endpoint-down'
  | 'auth'
  | 'timeout'
  | 'bad-response'
  | 'unsupported';

export interface ModelError {
  code: ModelErrorCode;
  /** 给哥哥看的中文一句话（设置页直接显示，不要堆栈） */
  message: string;
}

export interface ModelStatus {
  ready: boolean;
  reason?: ModelError;
}

/** core 只认这个接口；具体哪个后端由配置决定。 */
export interface ModelGateway {
  chat(request: ChatRequest): AsyncIterable<ChatDelta>;
  /** 返回一句看图结论；失败抛错由调用方转成 ModelError */
  vision(image: Uint8Array, prompt: string, signal?: AbortSignal): Promise<string>;
  speak(text: string, options?: { voice?: string; signal?: AbortSignal }): Promise<Uint8Array>;
  /** 设置页三张卡的红/绿状态 */
  status(): Partial<Record<ModelCapability, ModelStatus>>;
  /** 设置页「测一下」 */
  test(capability: ModelCapability): Promise<{ ok: boolean; message: string }>;
}

/** 只有 chat 能走会话：识图和发声都不存在"会话后端"。 */
const SESSION_ALLOWED: ReadonlySet<ModelCapability> = new Set<ModelCapability>(['chat']);

export function allowsSession(capability: ModelCapability): boolean {
  return SESSION_ALLOWED.has(capability);
}

/** 一个后端是否配齐了。session 恒为"配齐"，由连接状态另判。 */
export function isBackendComplete(backend: Backend): boolean {
  if (backend.kind === 'session') return true;
  if (backend.kind === 'local') return backend.endpoint.trim().length > 0;
  return backend.baseUrl.trim().length > 0 && backend.model.trim().length > 0;
}

/**
 * 校验一份配置能不能用；不能用时给出**具体**原因（设置页要能照着改）。
 * 返回 null 表示没问题。
 */
export function diagnoseConfig(capability: ModelCapability, config: CapabilityConfig): ModelError | null {
  if (!config.enabled) return { code: 'not-configured', message: '这个功能现在是关着的' };
  const backend = config.backend;
  if (backend.kind === 'session' && !allowsSession(capability)) {
    return { code: 'unsupported', message: '只有聊天能走 DSH 会话，识图和声音请选本地或网络' };
  }
  // Windows 自带语音 / Edge 在线朗读：都不要地址、不要 key。
  // 必须在下面那些"填地址填 key"的检查**之前**放行，否则哥哥选了系统语音反而被要求填一堆东西。
  if (capability === 'tts' && backend.kind !== 'session' && (backend.protocol === 'system' || backend.protocol === 'edge')) {
    return null;
  }
  if (backend.kind === 'remote') {
    if (!backend.baseUrl.trim()) return { code: 'not-configured', message: '还没填服务地址（baseUrl）' };
    if (!backend.model.trim()) return { code: 'not-configured', message: '还没填模型名' };
    if (!backend.apiKey?.trim()) return { code: 'not-configured', message: '还没填 API key' };
    if (capability === 'tts' && backend.protocol === 'sovits' && !backend.refAudioPath?.trim()) {
      return { code: 'not-configured', message: 'GPT-SoVITS 还差参考音：填一条本机音频的绝对路径（它靠这几秒定音色）' };
    }
    return null;
  }
  if (backend.kind === 'local') {
    if (!backend.endpoint.trim()) return { code: 'not-configured', message: '还没填本机服务地址' };
    if (capability === 'tts' && backend.protocol === 'sovits' && !backend.refAudioPath?.trim()) {
      return { code: 'not-configured', message: 'GPT-SoVITS 还差参考音：填一条本机音频的绝对路径（它靠这几秒定音色）' };
    }
    return null;
  }
  return null;
}
