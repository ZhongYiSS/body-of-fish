import { z } from 'zod';

/** No backend import: mocks and standalone HTTP can be exercised without any AI client. */
export interface StandaloneSettingsService {
  getSettings(): unknown;
  saveSettings(input: unknown): Promise<unknown>;
  testConnection?(input: {
    protocol?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; message: string; reply?: string }>;
}

const endpoint = z
  .string()
  .max(2048)
  .refine((value) => {
    if (value === '') return true;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }, '接口地址必须是 HTTP(S) 地址，且不能含账号、查询参数或片段');
const settingsSchema = z
  .object({
    protocol: z.enum(['openai-compatible', 'anthropic']).optional(),
    baseUrl: endpoint.optional(),
    model: z.string().max(200).optional(),
    apiKey: z.string().max(8192).optional(),
    clearApiKey: z.boolean().optional(),
    enabled: z.boolean().optional(),
    automaticWhispers: z.boolean().optional(),
    whisperIntervalSec: z.number().int().min(60).max(86400).optional(),
    maxTokens: z.number().int().min(128).max(4096).optional(),
    timeoutMs: z.number().int().min(1000).max(60000).optional(),
    // 【汐儿 · 11-16】设置页「模型」页签能填请求头（opencode Go 这类网关要带自定义头）。
    // 这里必须放行，否则整页保存被 .strict() 判成非法——具体清洗在 ai-config 的 sanitizeHeaders。
    extraHeaders: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export function validateSettings(input: unknown): z.infer<typeof settingsSchema> {
  const result = settingsSchema.safeParse(input);
  if (!result.success) throw new Error('设置无效：请检查协议、接口地址、间隔（至少 60 秒）和输出上限（128–4096）');
  return result.data;
}

const publicNames = [
  'protocol',
  'baseUrl',
  'model',
  'enabled',
  'automaticWhispers',
  'whisperIntervalSec',
  'maxTokens',
  'timeoutMs',
  // 【汐儿 · 11-16】不回显它，设置页那栏永远是空的，保存一次就把用户填的头冲掉；它也不是密钥。
  'extraHeaders',
  'hasKey',
] as const;
export function publicSettings(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object') return {};
  const record = input as Record<string, unknown>;
  return Object.fromEntries(
    publicNames
      .filter((name) => Object.prototype.hasOwnProperty.call(record, name))
      .map((name) => [name, record[name]]),
  );
}
