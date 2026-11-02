/**
 * 配置文件里的 `model` 段 → `ModelConfig`（网关认的形状）。
 *
 * 为什么要这一层：配置文件是给人手改的（注释多、字段平铺），而 core 要的是嵌套的
 * `{kind, backend:{...}}`。转换只做一次、只在这里，别让每个调用点自己猜字段名。
 *
 * 默认值（与 assets/config.jsonc 逐字一致）：
 *  - chat   ：开，走 DSH 会话（老行为：用当前对话的模型）
 *  - vision ：关，本地
 *  - tts    ：关，本地
 * 关着的功能**不静默降级**：状态卡显示"关着"，调用给 not-configured。
 */
import type { Backend, CapabilityConfig, ModelCapability, ModelConfig, SpeakProtocolOptions } from './model-gateway';

/** 配置文件里一个能力的原始形状（全是 unknown，用户可能手写错）。 */
export interface RawCapability {
  enabled?: unknown;
  kind?: unknown;
  baseUrl?: unknown;
  endpoint?: unknown;
  model?: unknown;
  apiKey?: unknown;
  /** 发声协议（见 model-gateway.ts 的 SpeakProtocolOptions）：openai | sovits */
  protocol?: unknown;
  refAudioPath?: unknown;
  promptText?: unknown;
  promptLang?: unknown;
  textLang?: unknown;
  speedFactor?: unknown;
}

const KINDS = new Set(['session', 'remote', 'local']);

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 发声协议那几个字段：只对 tts 有意义，别的能力直接忽略（免得配置里堆无意义的键） */
function speakOptions(raw: RawCapability): SpeakProtocolOptions {
  const protocol = str(raw.protocol);
  const speed = Number(raw.speedFactor);
  // 只有这四个是认识的协议；认不出的（旧文件里手写的怪值）当没写，回落 OpenAI 兼容
  const knownProtocol =
    protocol === 'sovits' || protocol === 'system' || protocol === 'edge'
      ? (protocol as 'sovits' | 'system' | 'edge')
      : undefined;
  return {
    ...(knownProtocol ? { protocol: knownProtocol } : {}),
    ...(str(raw.refAudioPath) ? { refAudioPath: str(raw.refAudioPath) } : {}),
    ...(str(raw.promptText) ? { promptText: str(raw.promptText) } : {}),
    ...(str(raw.promptLang) ? { promptLang: str(raw.promptLang) } : {}),
    ...(str(raw.textLang) ? { textLang: str(raw.textLang) } : {}),
    ...(Number.isFinite(speed) && speed > 0 ? { speedFactor: speed } : {}),
  };
}

function pickBackend(raw: RawCapability, fallbackKind: 'session' | 'local', capability: ModelCapability): Backend {
  const kindRaw = str(raw.kind);
  const kind = KINDS.has(kindRaw) ? kindRaw : fallbackKind;
  if (kind === 'session') return { kind: 'session' };
  // 发声协议只属于 tts：别的能力带上会让人误以为识图也能选 sovits
  const speak = capability === 'tts' ? speakOptions(raw) : {};
  if (kind === 'local') {
    const endpoint = str(raw.endpoint) || str(raw.baseUrl);
    const model = str(raw.model);
    return { kind: 'local', endpoint, ...(model ? { model } : {}), ...speak };
  }
  const baseUrl = str(raw.baseUrl) || str(raw.endpoint);
  const model = str(raw.model);
  const apiKey = str(raw.apiKey);
  return { kind: 'remote', baseUrl, model, ...(apiKey ? { apiKey } : {}), ...speak };
}

/** 单个能力：缺省项按默认（chat 开且走会话，其余关且本地）。 */
export function parseCapability(
  raw: unknown,
  capability: ModelCapability,
  defaults: { enabled: boolean; kind: 'session' | 'local' },
): CapabilityConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as RawCapability;
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : defaults.enabled;
  // 识图/发声不存在会话后端：手写 kind:"session" 时按本地处理（否则网关会判不支持）
  const backend = pickBackend(obj, defaults.kind, capability);
  const sessionForbidden = capability !== 'chat' && backend.kind === 'session';
  return {
    enabled,
    backend: sessionForbidden ? { kind: 'local', endpoint: '' } : backend,
  };
}

/** 整段解析。`raw` 不是对象（缺 section / 手写坏）→ 全默认。 */
export function parseModelConfig(raw: unknown): ModelConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    chat: parseCapability(obj.chat, 'chat', { enabled: true, kind: 'session' }),
    vision: parseCapability(obj.vision, 'vision', { enabled: false, kind: 'local' }),
    tts: parseCapability(obj.tts, 'tts', { enabled: false, kind: 'local' }),
  };
}

/** 写回配置文件时的反向转换（设置页保存用）：只写"和默认不一样"的字段，配置文件别被写脏。 */
export function toConfigSection(config: ModelConfig): Record<string, Record<string, unknown>> {
  const one = (item: CapabilityConfig, capability: ModelCapability): Record<string, unknown> => {
    const out: Record<string, unknown> = { enabled: item.enabled, kind: item.backend.kind };
    if (item.backend.kind === 'remote') {
      out.baseUrl = item.backend.baseUrl;
      out.model = item.backend.model;
      out.apiKey = item.backend.apiKey ?? '';
    }
    if (item.backend.kind === 'local') {
      out.endpoint = item.backend.endpoint;
      out.model = item.backend.model ?? '';
    }
    // 发声协议回写：只在 tts 上出现；system/edge 只写协议名（它们不要地址和 key），
    // sovits 才带参考音那一套。别把默认值写脏。
    if (capability === 'tts' && item.backend.kind !== 'session') {
      const speak = item.backend;
      if (speak.protocol === 'system' || speak.protocol === 'edge') {
        out.protocol = speak.protocol;
      }
      if (speak.protocol === 'sovits') {
        out.protocol = 'sovits';
        out.refAudioPath = speak.refAudioPath ?? '';
        out.promptText = speak.promptText ?? '';
        out.promptLang = speak.promptLang ?? '';
        out.textLang = speak.textLang ?? '';
        out.speedFactor = speak.speedFactor ?? 1;
      }
    }
    return out;
  };
  return {
    chat: one(config.chat, 'chat'),
    vision: one(config.vision, 'vision'),
    tts: one(config.tts, 'tts'),
  };
}
