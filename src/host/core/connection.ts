/**
 * 双模式连接：桌宠独立跑（它拥有 Electron 壳、core 在它进程里）时，DSH 后开也能接上。
 *
 * 哥哥 m00722 第 3 条：「桌宠独立启动后再打开 DSH，用『手动检测连接』把会话接上」。
 *
 * 协议很小，就一份文件 + 一次探测：
 *  1. 独立模式启动时写 `$DSH_HOME/dsh-pet/standalone-runtime.json`（见 src/standalone/runtime-state.ts，
 *     已有：port / token / settingsUrl / pluginRoot / pid / startedAt）；
 *  2. DSH 侧读这份文件 → 拿 port + token 打一次 `GET /dsh-pet-7340/state`；
 *  3. 通了就是"接上了"，此后 DSH 这边的入口只做转发，不再起第二个壳（否则会出现两只桌宠）。
 *
 * 铁律：
 *  - 只读文件、只发一次探测，**绝不因为这个判断去起/杀进程**（决定权在调用方）；
 *  - 失败一律给人话（"没在跑"/"token 不对"/"等了 1.5 秒没回应"），设置页直接显示；
 *  - token 只走请求头 `x-dsh-pet-token`（与独立模式自己的关机鉴权同一个头）。
 */

export interface StandaloneInfo {
  port: number;
  token: string;
  settingsUrl: string;
  pluginRoot: string;
  pid?: number;
  startedAt?: string;
}

/** 解析运行时文件内容；形状不对就当没有（手改坏的别把启动流程弄崩）。 */
export function parseStandaloneRuntime(raw: unknown): StandaloneInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.name !== undefined && obj.name !== 'dsh-pet-standalone') return null;
  const port = typeof obj.port === 'number' ? obj.port : Number(obj.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const token = typeof obj.token === 'string' ? obj.token.trim() : '';
  if (!token) return null;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    port,
    token,
    settingsUrl: str(obj.settingsUrl),
    pluginRoot: str(obj.pluginRoot),
    ...(typeof obj.pid === 'number' ? { pid: obj.pid } : {}),
    ...(typeof obj.startedAt === 'string' ? { startedAt: obj.startedAt } : {}),
  };
}

export interface ProbeResult {
  ok: boolean;
  message: string;
}

/**
 * 探一次：独立模式还活着吗。
 * @param baseUrl 只允许本机回环（跨机没有意义，也不该把 token 发出去）
 */
export async function probeStandalone(
  info: StandaloneInfo,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, message: '这个环境没有 fetch，探不了' };
  const timeoutMs = options.timeoutMs ?? 1500;
  const url = `http://127.0.0.1:${info.port}/dsh-pet-7340/state`;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'x-dsh-pet-token': info.token },
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: '连上了同端口的服务，但 token 对不上（可能不是桌宠）' };
    }
    if (!response.ok) return { ok: false, message: `桌宠回了 HTTP ${response.status}` };
    const json = (await response.json()) as { pets?: unknown };
    if (!json || typeof json !== 'object' || typeof json.pets !== 'object') {
      return { ok: false, message: '回的格式不像桌宠（没有 pets 字段）' };
    }
    return { ok: true, message: `接上了（端口 ${info.port}）` };
  } catch (error) {
    if (signal.aborted) return { ok: false, message: `等了 ${timeoutMs} 毫秒没回应` };
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `连不上 127.0.0.1:${info.port}：${reason}` };
  }
}
