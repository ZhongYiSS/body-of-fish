import { z } from 'zod';
import { readAiSettings, writeAiSettings } from './ai-storage';

export interface StandaloneAiPublicSettings {
  /** 自定义请求头（不涉密钥；设置页可编辑，鉴权类头由 transport 兜着） */
  extraHeaders?: Record<string, string>;
  protocol: 'openai-compatible' | 'anthropic';
  baseUrl: string;
  model: string;
  enabled: boolean;
  automaticWhispers: boolean;
  whisperIntervalSec: number;
  maxTokens: number;
  timeoutMs: number;
  hasKey: boolean;
}
export type StandaloneAiSettings = Omit<StandaloneAiPublicSettings, 'hasKey'> & {
  apiKey: string;
  /** 只在配置文件里认（不外露给设置页）：有些网关要带自定义头才能用（如 opencode Go 的 x-opencode-session）。 */
  extraHeaders: Record<string, string>;
};

export const DEFAULT_AI_SETTINGS: Readonly<StandaloneAiSettings> = Object.freeze({
  protocol: 'openai-compatible',
  baseUrl: '',
  model: '',
  enabled: false,
  automaticWhispers: false,
  whisperIntervalSec: 300,
  maxTokens: 1024,
  timeoutMs: 30_000,
  apiKey: '',
  extraHeaders: {},
});

function safeEndpoint(value: string): boolean {
  if (!value) return true;
  if (value !== value.trim() || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) {
      return false;
    }
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function containsControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) return true;
  }
  return false;
}

const fields = {
  protocol: z.enum(['openai-compatible', 'anthropic']),
  baseUrl: z.string().max(2048).refine(safeEndpoint),
  model: z
    .string()
    .trim()
    .max(200)
    .refine((s) => !containsControlChar(s)),
  enabled: z.boolean(),
  automaticWhispers: z.boolean(),
  whisperIntervalSec: z.number().int().min(30).max(86400),
  maxTokens: z.number().int().min(128).max(4096),
  timeoutMs: z.number().int().min(1000).max(60_000),
  // 自定义请求头（有些网关要带才能用，如 opencode Go 的 x-opencode-session）；清洗在 sanitizeHeaders() 里做
  extraHeaders: z.record(z.string(), z.unknown()).default({}),
  apiKey: z
    .string()
    .max(4096)
    .refine((s) => !containsControlChar(s) && !/\s/.test(s)),
};
const persistedSchema = z.object(fields).strict();
// 注意：不能用 persistedSchema.partial() 做补丁——它会把带 .default() 的字段补成 {}，把配置里已有的值冲掉
const patchSchema = z
  .object({ ...fields, extraHeaders: z.record(z.string(), z.unknown()).optional() })
  .partial()
  .extend({ clearApiKey: z.boolean().optional() })
  .strict();

/** 只留干净的字符串头：键名合法、值不成 CRLF、最多 16 条；其余静默丢掉。 */
function sanitizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === null || typeof raw !== 'object') return out;
  let count = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= 16) break;
    if (typeof v !== 'string') continue;
    const key = k.trim();
    if (!key || key.length > 128 || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) continue;
    if (v.length > 1024 || containsControlChar(v)) continue;
    out[key] = v;
    count += 1;
  }
  return out;
}

export function validateSettings(input: unknown, previous: Readonly<StandaloneAiSettings>): StandaloneAiSettings {
  try {
    const patch = patchSchema.parse(input);
    if (patch.clearApiKey && patch.apiKey) throw new Error('Conflicting key changes');
    const { clearApiKey, ...values } = patch;
    // `.partial()` 会把没传的字段留成 `undefined`：直接展开会把它盖到旧值上，把 extraHeaders 之类冲掉
    const defined = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
    const apiKey = clearApiKey ? '' : values.apiKey || previous.apiKey;
    const next = persistedSchema.parse({ ...previous, ...defined, apiKey });
    if (next.enabled && (!next.model || !next.baseUrl || !next.apiKey)) throw new Error('Incomplete settings');
    return { ...next, extraHeaders: sanitizeHeaders(next.extraHeaders) };
  } catch {
    throw new Error('Invalid standalone AI settings.');
  }
}

function redact(settings: Readonly<StandaloneAiSettings>): StandaloneAiPublicSettings {
  const { apiKey, ...publicFields } = settings;
  // 【汐儿 · 11-16 m21833】extraHeaders 不再藏起来：opencode Go 这类网关必须带自定义头，
  // 只能改配置文件太难受。它不是密钥（密钥是 apiKey），而且设置页本来就要令牌才打得开。
  return { ...publicFields, extraHeaders: settings.extraHeaders, hasKey: apiKey.length > 0 };
}

export interface AiConfigStore {
  current(): Readonly<StandaloneAiSettings>;
  publicSettings(): StandaloneAiPublicSettings;
  save(input: unknown): Promise<StandaloneAiPublicSettings>;
}

export function createAiConfig(home: string): AiConfigStore {
  let settings: Readonly<StandaloneAiSettings> = DEFAULT_AI_SETTINGS;
  try {
    const loaded = readAiSettings(home);
    if (loaded !== undefined)
      settings = Object.freeze(validateSettings(persistedSchema.parse(loaded), DEFAULT_AI_SETTINGS));
  } catch (error) {
    // 保留原消息（对外仍是同一句、不泄露路径细节），但把真实原因挂到 cause 上，排障时才看得见
    throw new Error('Cannot securely load standalone AI settings.', { cause: error });
  }
  return {
    current: () => settings,
    publicSettings: () => redact(settings),
    async save(input) {
      const next = validateSettings(input, settings);
      try {
        writeAiSettings(home, next);
      } catch {
        throw new Error('Cannot securely save standalone AI settings.');
      }
      settings = Object.freeze(next);
      return redact(settings);
    },
  };
}
