/**
 * 模型网关的**实现层**：把「配置里的三个后端」落到具体调用上。
 *
 * 分工：
 *  - 本文件负责"选谁、怎么把失败翻成人话、状态怎么报"；
 *  - 真正的网络细节在 `./adapters/openai-compat`（网络与本地共用一份）；
 *  - `session` 后端不在这里实现 —— 它必须走宿主的 dsh-llm，由 index.ts 注入一个
 *    `sessionChat` 回调（独立模式下没有会话，回调为 null，设置页会显示"没接上 DSH"）。
 *
 * 铁律：core 不认识 DSH；这里只认「有这么一个回调」，不知道它背后是 Cordis 还是别的。
 */
import {
  ModelCallError,
  compatChat,
  compatSpeak,
  compatVision,
  type CompatMessage,
} from './adapters/openai-compat';
import { sovitsSpeak } from './adapters/gpt-sovits';
import { sapiSpeak } from './adapters/windows-tts';
import { edgeSpeak } from './adapters/edge-tts';
import {
  type Backend,
  type CapabilityConfig,
  type ChatDelta,
  type ChatRequest,
  type ModelCapability,
  type ModelConfig,
  type ModelError,
  type ModelGateway,
  type ModelStatus,
  diagnoseConfig,
  isBackendComplete,
} from './model-gateway';

/** 会话后端：由宿主半侧注入（走 dsh-llm 的当前选中模型）。 */
export interface SessionChat {
  chat(request: ChatRequest): Promise<string>;
}

/**
 * Edge 朗读「明显太短 = 等于没说话」的门槛（字节）。
 * 一句正常的中文短句在 24kHz/48kbps mp3 下也有 10KB 上下；几百字节到 2KB 多半是空话音。
 * 只用来决定「要不要退回系统语音」，不参与任何音质判断。
 */
const MIN_EDGE_AUDIO_BYTES = 2_000;

export interface ModelGatewayDeps {
  /** 每次调用都重新读：设置页改完配置不用重启 */
  readConfig(): ModelConfig;
  /** 不可用（独立模式 / DSH 没连上）时给 null */
  session: SessionChat | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 把 ChatRequest 的消息整理成 OpenAI 兼容形状（图片走 data URL 的部分留待需要时再读盘）。 */
function toCompatMessages(request: ChatRequest): CompatMessage[] {
  return request.messages.map((m) => ({
    role: m.role,
    content: m.text,
  }));
}

function asError(error: unknown): ModelError {
  if (error instanceof ModelCallError) return error.toModelError();
  const reason = error instanceof Error ? error.message : String(error);
  return { code: 'bad-response', message: reason };
}

/** 三个能力的当前状态：开关 + 后端是否配齐 + 会话是否在。 */
export function statusOf(config: ModelConfig, hasSession: boolean): Partial<Record<ModelCapability, ModelStatus>> {
  const out: Partial<Record<ModelCapability, ModelStatus>> = {};
  for (const capability of ['chat', 'vision', 'tts'] as const) {
    const item = config[capability];
    const reason = diagnoseConfig(capability, item) ?? sessionReason(item.backend, hasSession);
    out[capability] = reason ? { ready: false, reason } : { ready: true };
  }
  return out;
}

/** session 后端的额外判定：配了会话但会话没接上，也算没配齐。 */
function sessionReason(backend: Backend, hasSession: boolean): ModelError | null {
  if (backend.kind !== 'session') return null;
  if (hasSession) return null;
  return { code: 'not-configured', message: '还没接上 DSH 会话（先开 DSH，或点「检测连接」）' };
}

/**
 * 造一个网关。注意：**配置是每次调用读的** —— 设置页保存后立刻生效，不用重启。
 */
export function createModelGateway(deps: ModelGatewayDeps): ModelGateway {
  const options = { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs };

  /** 取某能力的后端；没配齐就抛结构化失败，绝不静默降级到别的后端。 */
  const backendFor = (capability: ModelCapability): Backend => {
    const config = deps.readConfig();
    const item: CapabilityConfig | undefined = config[capability];
    if (!item) throw new ModelCallError('not-configured', '这个功能没有配置');
    const problem = diagnoseConfig(capability, item) ?? sessionReason(item.backend, deps.session !== null);
    if (problem) throw new ModelCallError(problem.code, problem.message);
    return item.backend;
  };

  const gateway: ModelGateway = {
    async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
      try {
        const backend = backendFor('chat');
        let text: string;
        if (backend.kind === 'session') {
          const session = deps.session;
          if (!session) throw new ModelCallError('not-configured', '还没接上 DSH 会话');
          text = await session.chat(request);
        } else {
          text = await compatChat(
            { baseUrl: backend.kind === 'local' ? backend.endpoint : backend.baseUrl, model: modelOf(backend), apiKey: apiKeyOf(backend) },
            toCompatMessages(request),
            { ...options, signal: request.signal },
          );
        }
        yield { type: 'text', text };
        yield { type: 'done' };
      } catch (error) {
        yield { type: 'error', error: asError(error) };
      }
    },

    async vision(image: Uint8Array, prompt: string, signal?: AbortSignal): Promise<string> {
      const backend = backendFor('vision');
      if (backend.kind === 'session') {
        throw new ModelCallError('unsupported', '只有聊天能走会话，识图请选本地或网络');
      }
      return compatVision(
        { baseUrl: backend.kind === 'local' ? backend.endpoint : backend.baseUrl, model: modelOf(backend), apiKey: apiKeyOf(backend) },
        image,
        prompt,
        { ...options, signal },
      );
    },

    async speak(text: string, speakOptions?: { voice?: string; signal?: AbortSignal }): Promise<Uint8Array> {
      const backend = backendFor('tts');
      if (backend.kind === 'session') {
        throw new ModelCallError('unsupported', '只有聊天能走会话，声音请选本地或网络');
      }
      // 协议决定走哪个适配器：`sovits` = GPT-SoVITS 的 GET /tts，`system` = Windows 自带（离线免费），
      // `edge` = 微软在线朗读，其余按 OpenAI 兼容
      if (backend.protocol === 'system') {
        return sapiSpeak(text, { voice: speakOptions?.voice });
      }
      if (backend.protocol === 'edge') {
        // 【汐儿 · 11-03】Edge 是免费服务，网络抖一下就会失败：适配器已重试一次「空音频」，
        // 偶尔还会回一段几乎没声的短 mp3（实测 < 2KB 基本是空话音）。这两种都退回系统语音，
        // 让哥哥顶多听到一句稍平的朗读，而不是对着空气等半天、或者干脆没声。
        try {
          const audio = await edgeSpeak(text, { voice: speakOptions?.voice });
          if (audio.byteLength >= MIN_EDGE_AUDIO_BYTES) return audio;
          console.warn(`[dsh-pet] Edge 回了疑似空音频（${audio.byteLength} 字节），改用系统语音`);
        } catch (error) {
          console.warn(
            `[dsh-pet] Edge 朗读失败，改用系统语音：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return sapiSpeak(text, { voice: speakOptions?.voice });
      }
      if (backend.protocol === 'sovits') {
        return sovitsSpeak(
          {
            endpoint: backend.kind === 'local' ? backend.endpoint : backend.baseUrl,
            refAudioPath: backend.refAudioPath,
            promptText: backend.promptText,
            promptLang: backend.promptLang,
            textLang: backend.textLang,
            speedFactor: backend.speedFactor,
          },
          text,
          { signal: speakOptions?.signal, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
        );
      }
      return compatSpeak(
        { baseUrl: backend.kind === 'local' ? backend.endpoint : backend.baseUrl, model: modelOf(backend), apiKey: apiKeyOf(backend) },
        text,
        { ...options, voice: speakOptions?.voice, signal: speakOptions?.signal },
      );
    },

    status(): Partial<Record<ModelCapability, ModelStatus>> {
      return statusOf(deps.readConfig(), deps.session !== null);
    },

    async test(capability: ModelCapability): Promise<{ ok: boolean; message: string }> {
      try {
        const backend = backendFor(capability);
        if (capability === 'chat') {
          const text =
            backend.kind === 'session'
              ? await (deps.session as SessionChat).chat({
                  messages: [{ role: 'user', text: '只回两个字：在的' }],
                })
              : await compatChat(
                  { baseUrl: backend.kind === 'local' ? backend.endpoint : backend.baseUrl, model: modelOf(backend), apiKey: apiKeyOf(backend) },
                  [{ role: 'user', content: '只回两个字：在的' }],
                  { ...options, timeoutMs: options.timeoutMs ?? 20_000 },
                );
          return { ok: text.length > 0, message: text.slice(0, 40) || '回了空话' };
        }
        if (capability === 'vision') {
          const png = ONE_PIXEL_PNG;
          const text =
            backend.kind === 'session'
              ? ''
              : await compatVision(
                  { baseUrl: backend.kind === 'local' ? backend.endpoint : backend.baseUrl, model: modelOf(backend), apiKey: apiKeyOf(backend) },
                  png,
                  '这张图里有什么？只回一句。',
                  { ...options, timeoutMs: options.timeoutMs ?? 20_000 },
                );
          return { ok: text.length > 0, message: text.slice(0, 40) || '回了空结论' };
        }
        // 测试也要按真实协议走：填了 sovits 却拿 /audio/speech 去试，只会得到"地址不对"，骗人
        if (backend.kind === 'session') {
          return { ok: false, message: '只有聊天能走会话，声音请选本地或网络' };
        }
        const audio =
          backend.protocol === 'system'
            ? await sapiSpeak('在的', { timeoutMs: options.timeoutMs })
            : backend.protocol === 'edge'
              ? await edgeSpeak('在的')
              : backend.protocol === 'sovits'
            ? await sovitsSpeak(
                {
                  endpoint: backend.kind === 'local' ? backend.endpoint : backend.baseUrl,
                  refAudioPath: backend.refAudioPath,
                  promptText: backend.promptText,
                  promptLang: backend.promptLang,
                  textLang: backend.textLang,
                  speedFactor: backend.speedFactor,
                },
                '在的',
                { ...options, timeoutMs: options.timeoutMs ?? 60_000 },
              )
            : await compatSpeak(
                { baseUrl: backend.kind === 'local' ? backend.endpoint : backend.baseUrl, model: modelOf(backend), apiKey: apiKeyOf(backend) },
                '在的',
                { ...options, timeoutMs: options.timeoutMs ?? 20_000 },
              );
        return { ok: audio.byteLength > 0, message: audio.byteLength > 0 ? `拿到 ${audio.byteLength} 字节音频` : '回了空音频' };
      } catch (error) {
        const modelError = asError(error);
        return { ok: false, message: modelError.message };
      }
    },
  };
  return gateway;
}

/** local 后端的 model 可省（LM Studio / 识图脚本按端点自己选）；remote 必填但类型上可能是空串。 */
function modelOf(backend: Backend): string {
  if (backend.kind === 'remote') return backend.model;
  if (backend.kind === 'local') return backend.model ?? '';
  return '';
}

function apiKeyOf(backend: Backend): string | undefined {
  return backend.kind === 'remote' ? backend.apiKey : undefined;
}

/** 1×1 透明 PNG：识图「测一下」的输入，不泄漏任何真实图片。 */
export const ONE_PIXEL_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);
