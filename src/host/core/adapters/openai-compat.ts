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
  /** 额外的请求头（独立模式的设置里填的，比如 opencode Go 要的 x-opencode-session）。
   *  只补不抢：content-type / authorization 这些传输与鉴权头一律不许被覆盖。 */
  extraHeaders?: Record<string, string>;
}

/** 传输与鉴权类头：调用方填的同名头一律忽略，避免把鉴权改坏。 */
const RESERVED_HEADERS = new Set([
  'content-type',
  'accept',
  'authorization',
  'x-api-key',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'cookie',
  'set-cookie',
]);

/** 把自定义头并进一份基础头（保留基础头优先）。 */
function withExtraHeaders(base: Record<string, string>, extra?: Record<string, string>): Record<string, string> {
  if (!extra) return base;
  const out = { ...base };
  for (const [rawKey, value] of Object.entries(extra)) {
    const key = String(rawKey ?? '').trim();
    if (!key || typeof value !== 'string') continue;
    if (RESERVED_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
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
/** 值得等 1.5 秒再试一次的状态码（限流 + 网关抖动） */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

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

/**
 * 按魔数认图格式（PNG / JPEG / GIF / WEBP）。
 *
 * 为什么要它：0.6 起识图改送 JPEG，但调用链里没有一处传 mime，
 * 以前全靠默认 'image/png'——真送 JPEG 时 data URL 会写错格式，有的端点会直接拒。
 * 认不出来就按 PNG（我们只会出这两样）。
 */
export function sniffImageMime(bytes: Uint8Array): string {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/png';
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
      headers: withExtraHeaders(
        {
          'content-type': 'application/json',
          ...(backend.apiKey?.trim() ? { authorization: `Bearer ${backend.apiKey.trim()}` } : {}),
        },
        backend.extraHeaders,
      ),
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
  const firstRaw = await response.text();
  let retried = false;
  // 【11-18】429/5xx：等 1.5 秒重试一次。这一层还没开始读流，重试不会让她说两遍；
  // 401/403 不重试（重试也一样错），网络断了也不重试（只是再等一遍超时）。
  if (!response.ok && RETRY_STATUS.has(response.status)) {
    retried = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_500);
      timer.unref?.();
    });
    if (options.signal?.aborted === true) throw new ModelCallError('timeout', '这次调用被取消了');
    try {
      response = await fetchImpl(chatCompletionsUrl(backend.baseUrl), {
        method: 'POST',
        headers: withExtraHeaders(
          {
            'content-type': 'application/json',
            ...(backend.apiKey?.trim() ? { authorization: `Bearer ${backend.apiKey.trim()}` } : {}),
          },
          backend.extraHeaders,
        ),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ModelCallError('endpoint-down', `重试时连不上 ${backend.baseUrl}：${reason}`);
    }
  }
  // 重试过才重新读；没重试直接用第一份（同一份 body 读两次会报 Body is unusable）
  const raw = retried ? await response.text() : firstRaw;
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


/**
 * 流式识图（【汐儿 · 11-10 m17986 第三刀】）。
 *
 * 为什么要流式：合并成一次调用之后，那句话排在三、四行，等整段写完才开口，
 * 白等了模型生成后面那截。流式一到就把文本回调出去，上层可以「说到哪算哪」。
 *
 * 只在 options.onDelta 存在时才走这条路；端点不认 stream/字段被拒时，调用方退回整段请求。
 */
async function streamVision(
  backend: RemoteBackend,
  body: Record<string, unknown>,
  options: CompatOptions & { onDelta?: (chunk: string) => void },
): Promise<string> {
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
      headers: withExtraHeaders(
        {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(backend.apiKey?.trim() ? { authorization: `Bearer ${backend.apiKey.trim()}` } : {}),
        },
        backend.extraHeaders,
      ),
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (error) {
    if (timeout.aborted) throw new ModelCallError('timeout', '流式识图等太久没回应');
    const reason = error instanceof Error ? error.message : String(error);
    throw new ModelCallError('endpoint-down', `连不上 ${backend.baseUrl}：${reason}`);
  }
  if (!response.ok) throw mapHttpError(response.status, await response.text());
  if (!response.body) throw new ModelCallError('bad-response', '流式响应没有 body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let cut = buffered.indexOf('\n');
    while (cut >= 0) {
      const line = buffered.slice(0, cut).trim();
      buffered = buffered.slice(cut + 1);
      cut = buffered.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta !== '') {
          text += delta;
          options.onDelta?.(delta);
        }
      } catch {
        /* 半行 JSON 不算错，下一轮拼上 */
      }
    }
  }
  if (text === '') throw new ModelCallError('bad-response', '识图流式回了个空结论');
  return text;
}

/** 看图说一句话（data URL 塞进 user 消息）。 */
/**
 * 【11-20 0.6 第 3 步】识图慢的第二个大头：**这个端点默认把 token 花在思考上**。
 * 同一张 1536 宽 jpg、同一句提示词（真实实测）：
 *   默认 → 13,574ms（reasoning 652 token）；`thinking:{type:'disabled'}` → 1,665ms（reasoning 0）。
 * 看图不需要长篇推理，思考反而把 max_tokens 吃光——400 token 档下正文直接是空的。
 * 有的端点不认这两个字段（400），所以按顺序试三档，记住能过的那一档。
 */
const VISION_KNOBS: ReadonlyArray<Record<string, unknown>> = [
  { thinking: { type: 'disabled' }, reasoning_effort: 'none' },
  { reasoning_effort: 'none' },
  {},
];

/** 每个 baseUrl 记住「哪一档能过」，省掉每次先撞一次 400 */
const visionKnobOk = new Map<string, number>();

/** 参数被拒（400/422 这类「字段不认识」）才值得换下一档 */
function isKnobRejected(error: unknown): boolean {
  if (!(error instanceof ModelCallError)) return false;
  return error.code === 'bad-response' || error.code === 'unsupported';
}

export async function compatVision(
  backend: RemoteBackend,
  imageBytes: Uint8Array,
  prompt: string,
  options: CompatOptions & { mime?: string; onDelta?: (chunk: string) => void } = {},
): Promise<string> {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: toDataUrl(imageBytes, options.mime ?? sniffImageMime(imageBytes)) } },
      ],
    },
  ];
  /**
   * 【11-09 晚 m16721】识图为什么慢：不是图大，是**模型在思考**。
   * 同一张 1280×800 拼图打 opencode Go 的 `deepseek-v4.1-flash`：
   * 默认 2877 个 reasoning token → **28.9 秒**；加 `reasoning_effort:'none'` → 0 个 → **7.5 秒**，
   * 读出来的内容反而更干净（「Codex CLI / WSL / 窗口标题」）。看图不需要长篇推理。
   * 有些 OpenAI 兼容端点不认这个字段（400），那就去掉再试一次——宁可多 200ms，也不能因为参数被拒就不识图。
   */
  /**
   * max_tokens 是给「看图说话」的长尾兜底：正常情况下她只回一两句，
   * 但端点偶尔会一直往下写，卡住整轮（哥哥说的「看一眼半天不吭声」）。800 够说三五句。
   */
  const body = { model: backend.model, messages, temperature: 0.8, stream: false, max_tokens: 800 };
  const knobStart = Math.min(visionKnobOk.get(backend.baseUrl) ?? 0, VISION_KNOBS.length - 1);
  const knobLast = VISION_KNOBS.length - 1;
  for (let i = knobStart; i <= knobLast; i += 1) {
    const knob = VISION_KNOBS[i] as Record<string, unknown>;
    if (options.onDelta) {
      /**
       * 【11-16 体检】流式中途断了**不能整段重来**：前面已经吐出去的字收不回来，
       * 再问一遍会让同一次「看一眼」说两遍（气泡说完又重说），还白花一份合成钱。
       * 已经吐过字就用已吐的收场；一个字都没吐（端点不支持流式 / 连不上）才退回整段请求。
       */
      let emitted = '';
      const track = (chunk: string): void => {
        emitted += chunk;
        options.onDelta?.(chunk);
      };
      try {
        const streamed = await streamVision(backend, { ...body, ...knob }, { ...options, onDelta: track });
        if (streamed.trim() !== '' || emitted.trim() !== '') {
          visionKnobOk.set(backend.baseUrl, i);
          return streamed.trim() !== '' ? streamed : emitted;
        }
      } catch (error) {
        if (emitted.trim() !== '') {
          visionKnobOk.set(backend.baseUrl, i);
          return emitted;
        }
        /* 参数被拒 → 换下一档；其它（连不上/半路断）就退回整段请求再试同一档 */
        if (isKnobRejected(error)) continue;
      }
    }
    let json: unknown;
    try {
      json = await postJson(backend, { ...body, ...knob }, options);
    } catch (error) {
      /* 只有「参数不认识」才换下一档：网络断了/超时了，换个参数再打一遍只是白等 */
      if (isKnobRejected(error) && i < knobLast) continue;
      throw error;
    }
    const text = extractText(json);
    /* 空正文不换档：关掉思考还回空，说明是模型/额度的事，换个参数更慢更糟 */
    if (!text) throw new ModelCallError('bad-response', '识图回了个空结论');
    visionKnobOk.set(backend.baseUrl, i);
    return text;
  }
  throw new ModelCallError('bad-response', '识图这条路三档参数都试过了，都不行');
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
      headers: withExtraHeaders(
        {
          'content-type': 'application/json',
          ...(backend.apiKey?.trim() ? { authorization: `Bearer ${backend.apiKey.trim()}` } : {}),
        },
        backend.extraHeaders,
      ),
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
