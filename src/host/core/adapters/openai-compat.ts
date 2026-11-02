/**
 * OpenAI 兼容后端适配器（网络 / 本地同构）
 *
 * 为什么是它：哥哥要的「自己的 key」「本地模型」「网络模型」三类后端里，后两类几乎全是
 * OpenAI 兼容协议 —— OpenAI 自己、DeepSeek、Moonshot、LM Studio、vLLM、Ollama 的 /v1、
 * 各家一键部署，全都能说 `POST {baseUrl}/chat/completions`。所以一份实现覆盖两种 kind，
 * 差别只在 baseUrl 是本机还是外网。
 *
 * 铁律：
 *  1. 不读配置、不碰文件 —— 参数进来什么就用什么（配置读取在 create-model-gateway）。
 *  2. 失败一律抛 `ModelCallError`（带 ModelErrorCode），调用方转成结构化失败，不假装成功。
 *  3. 超时自己管：`AbortSignal.timeout` + 外部 signal 二合一，避免设置页「测一下」卡死。
 *  4. 图片走 data URL（本机文件由调用方读成字节），不依赖任何图床。
 */
import type { ModelError, ModelErrorCode } from '../model-gateway';

/** 一次模型调用的失败：code 给程序判断，message 给哥哥看。 */
export class ModelCallError extends Error {
  readonly code: ModelErrorCode;

  constructor(code: ModelErrorCode, message: string) {
    super(message);
    this.name = 'ModelCallError';
    this.code = code;
  }

  toModelError(): ModelError {
    return { code: this.code, message: this.message };
  }
}

export interface RemoteBackend {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/** 网络/本地后端共用的调用参数。 */
export interface CompatOptions {
  /** 单次调用超时（毫秒）；缺省 60s —— 本地模型首 token 慢，别按 5s 卡 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

// 哥哥 11-01：本地视觉模型（LM Studio 的 Qwen3-VL-8B）**冷启动一次要 50–60 秒**，
// 60s 的默认超时正好卡在边上——「看一眼」时好时坏、还静默。放到 120s，冷启动也够。
const DEFAULT_TIMEOUT_MS = 120_000;

/** 拼 `{baseUrl}/chat/completions`：容忍结尾斜杠、容忍 baseUrl 已经带 `/v1` 或已带全路径。 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

export interface CompatContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface CompatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | CompatContentPart[];
}

/** 把字节 + mime 包成 data URL（识图走这条；不落盘、不外传）。 */
export function toDataUrl(bytes: Uint8Array, mime = 'image/png'): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * 把 HTTP 层的失败翻译成哥哥能照改的话。
 * 401/403 → key 不对；404 → 地址或模型名不对；429 → 额度/频率；5xx → 对面挂了。
 */
export function mapHttpError(status: number, body: string): ModelCallError {
  const detail = body.trim().slice(0, 200);
  if (status === 401 || status === 403) {
    return new ModelCallError('auth', `key 不被认可（HTTP ${status}）${detail ? `：${detail}` : ''}`);
  }
  if (status === 404) {
    return new ModelCallError(
      'endpoint-down',
      `地址或模型名不对（HTTP 404）${detail ? `：${detail}` : ''}。检查 baseUrl 是否要带 /v1`,
    );
  }
  if (status === 429) {
    return new ModelCallError('endpoint-down', `对面限流或没额度了（HTTP 429）${detail ? `：${detail}` : ''}`);
  }
  if (status >= 500) {
    return new ModelCallError('endpoint-down', `对面服务出错（HTTP ${status}）${detail ? `：${detail}` : ''}`);
  }
  return new ModelCallError('bad-response', `调用失败（HTTP ${status}）${detail ? `：${detail}` : ''}`);
}

/** 从响应体里抠 `choices[0].message.content`（兼容 content 为字符串或分段数组）。 */
export function extractText(json: unknown): string {
  const obj = json as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
  };
  const choice = obj?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const text = (part as { text?: unknown })?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('')
      .trim();
  }
  return '';
}

async function postJson(
  backend: RemoteBackend,
  body: unknown,
  options: CompatOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new ModelCallError('endpoint-down', '这个环境没有 fetch，调不了网络模型');
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(chatCompletionsUrl(backend.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(backend.apiKey?.trim() ? { authorization: `Bearer ${backend.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (timeout.aborted) {
      throw new ModelCallError('timeout', `等了 ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} 秒没回应`);
    }
    if (options.signal?.aborted) throw new ModelCallError('timeout', '这次调用被取消了');
    const reason = error instanceof Error ? error.message : String(error);
    throw new ModelCallError('endpoint-down', `连不上 ${backend.baseUrl}：${reason}`);
  }
  const raw = await response.text();
  if (!response.ok) throw mapHttpError(response.status, raw);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ModelCallError('bad-response', `对面回的不是 JSON：${raw.slice(0, 120)}`);
  }
}

/**
 * 一次纯文本对话（无流式）。
 * 桌宠的聊天/碎碎念都是"一句话"，流式没有收益，反而多一层状态机 —— 这里只要整段。
 */
export async function compatChat(
  backend: RemoteBackend,
  messages: CompatMessage[],
  options: CompatOptions = {},
): Promise<string> {
  const json = await postJson(
    backend,
    { model: backend.model, messages, temperature: 1, stream: false },
    options,
  );
  const text = extractText(json);
  if (!text) throw new ModelCallError('bad-response', '模型回了个空字符串');
  return text;
}

/** 看图说一句话（data URL 塞进 user 消息）。 */
export async function compatVision(
  backend: RemoteBackend,
  imageBytes: Uint8Array,
  prompt: string,
  options: CompatOptions & { mime?: string } = {},
): Promise<string> {
  const json = await postJson(
    backend,
    {
      model: backend.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: toDataUrl(imageBytes, options.mime) } },
          ],
        },
      ],
      temperature: 0.8,
      stream: false,
    },
    options,
  );
  const text = extractText(json);
  if (!text) throw new ModelCallError('bad-response', '识图回了个空结论');
  return text;
}

/** 发声：OpenAI 兼容 `/audio/speech` 直出音频字节。 */
export async function compatSpeak(
  backend: RemoteBackend,
  text: string,
  options: CompatOptions & { voice?: string } = {},
): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new ModelCallError('endpoint-down', '这个环境没有 fetch，调不了网络语音');
  }
  const url = chatCompletionsUrl(backend.baseUrl).replace(/\/chat\/completions$/, '/audio/speech');
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(backend.apiKey?.trim() ? { authorization: `Bearer ${backend.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify({
        model: backend.model,
        input: text,
        voice: options.voice ?? 'alloy',
        response_format: 'mp3',
      }),
      signal,
    });
  } catch (error) {
    if (timeout.aborted) throw new ModelCallError('timeout', '语音合成超时了');
    const reason = error instanceof Error ? error.message : String(error);
    throw new ModelCallError('endpoint-down', `连不上语音服务：${reason}`);
  }
  if (!response.ok) throw mapHttpError(response.status, await response.text());
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength === 0) throw new ModelCallError('bad-response', '语音服务回了空音频');
  return buffer;
}
