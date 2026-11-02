/**
 * GPT-SoVITS 发声适配（家里的「本鱼嗓子」，端口 9880）。
 *
 * 为什么单开一个文件而不是塞进 openai-compat：它的请求形状和 OpenAI **完全不是一回事**。
 *   - OpenAI：`POST /audio/speech`，JSON body，回 mp3；
 *   - GPT-SoVITS：`GET /tts?text=…&ref_audio_path=…&prompt_text=…`，回 wav 字节。
 * 硬套一个适配器只会写出两套分支加一堆 if，分开更清楚（这也是 model-gateway 里
 * 用 `protocol` 明确区分的理由）。
 *
 * 契约要点（api_v2.py）：
 *   - `ref_audio_path` 必填，且是**服务端那台机器**能读到的路径（本机就写绝对路径）；
 *   - `prompt_text` 是参考音里念的话，越准音色越稳；
 *   - 失败时回 JSON `{message, Exception}`，HTTP 400。
 */
import { ModelCallError } from './openai-compat';

/** 只要发声需要的字段，别把整个 Backend 塞进来（测试也好造） */
export interface SovitsTarget {
  endpoint: string;
  refAudioPath?: string;
  promptText?: string;
  promptLang?: string;
  textLang?: string;
  speedFactor?: number;
}

export interface SovitsOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** 默认 60 秒：CPU 上合成一句话花十几秒很正常，别用网络的 15 秒去卡它 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** 端点归一：允许用户填 `http://127.0.0.1:9880`、`…/` 或已经带着 `/tts` */
export function sovitsTtsUrl(target: SovitsTarget, text: string): string {
  const base = target.endpoint.trim().replace(/\/+$/, '');
  const url = new URL(/\/tts$/i.test(base) ? base : `${base}/tts`);
  url.searchParams.set('text', text);
  url.searchParams.set('text_lang', target.textLang || 'zh');
  url.searchParams.set('ref_audio_path', target.refAudioPath ?? '');
  url.searchParams.set('prompt_text', target.promptText ?? '');
  url.searchParams.set('prompt_lang', target.promptLang || 'zh');
  url.searchParams.set('text_split_method', 'cut5');
  url.searchParams.set('media_type', 'wav');
  url.searchParams.set('streaming_mode', 'false');
  url.searchParams.set('speed_factor', String(target.speedFactor ?? 1));
  return url.toString();
}

export async function sovitsSpeak(
  target: SovitsTarget,
  text: string,
  options: SovitsOptions = {},
): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new ModelCallError('endpoint-down', '这个环境没有 fetch，调不了本机语音');
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(sovitsTtsUrl(target, text), { method: 'GET', signal });
  } catch (error) {
    if (timeout.aborted) throw new ModelCallError('timeout', '语音合成超时了（60 秒没唱完）');
    const reason = error instanceof Error ? error.message : String(error);
    throw new ModelCallError('endpoint-down', `连不上语音服务：${reason}`);
  }
  if (!response.ok) {
    // GPT-SoVITS 的错在 JSON 里（`Exception` 那句才是真原因），尽量原样带出去
    const raw = await response.text().catch(() => '');
    let detail = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { Exception?: unknown; message?: unknown };
      const exception = typeof parsed.Exception === 'string' ? parsed.Exception : '';
      if (exception) detail = exception;
    } catch {
      // 不是 JSON 就用原文
    }
    if (response.status === 404) throw new ModelCallError('not-configured', `这个地址没有 /tts：${detail}`);
    throw new ModelCallError('bad-response', `语音服务报错（HTTP ${response.status}）：${detail}`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength === 0) throw new ModelCallError('bad-response', '语音服务回了空音频');
  return buffer;
}
