/** Standalone loopback HTTP boundary. Desktop bridge requests never pass through this listener. */
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { RegisteredRoute, StandaloneLogger } from './context';
import { createRequestSecurity, rejectRequest, secureResponse } from './request-security';
import type { RequestSecurity } from './request-security';
import { boundedRequest, MAX_REQUEST_BYTES, MAX_SETTINGS_BYTES } from './request-body';
import { publicSettings, validateSettings } from './settings';
import type { StandaloneSettingsService } from './settings';
import { settingsPage, settingsScript, settingsStyle } from './settings-page';
import { petSettingsPage, petSettingsScript, petSettingsStyle } from './pet-settings-page';
import type { ProfileService } from './ai-profiles';
import { whisperPage, whisperScript, whisperStyle } from './whisper-page';

export const DEFAULT_STANDALONE_PORT = 3080;
export const PORT_SCAN_LIMIT = 25;

/** 独立模式「桌宠外观与行为」设置的最小接口面（实现见 ./pet-settings） */
export interface StandalonePetSettingsService {
  getSettings(): unknown;
  saveSettings(input: unknown): Promise<unknown>;
}

export interface StandaloneServerOptions {
  routes: RegisteredRoute[];
  logger: StandaloneLogger;
  port?: number;
  /**
   * 只认这一个端口，占不到就报错退出（【汐儿 · 11-15】哥哥选 A+B）。
   * 默认 false 会顺延 25 个端口——那正是「两个实例同时活着」的漏洞。
   */
  strictPort?: boolean;
  status?: () => unknown;
  onShutdown?: () => void;
  security?: RequestSecurity;
  ai?: StandaloneSettingsService;
  pet?: StandalonePetSettingsService;
  /** 模型方案（一页签一套：对话 + 看图 + 声音整份快照） */
  profiles?: ProfileService;
  /** Override only for deterministic timeout tests. */
  bodyTimeoutMs?: number;
}
export interface StandaloneServer {
  port: number;
  security: RequestSecurity;
  close(): Promise<void>;
}

function matches(route: RegisteredRoute, pathname: string): boolean {
  if (route.kind === 'exact') return pathname === route.path;
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}
function sendJson(res: ServerResponse, status: number, body: unknown, cors = false): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...(cors ? { 'access-control-allow-origin': '*' } : {}),
  });
  res.end(payload);
}
function sendAsset(res: ServerResponse, body: string, type: string): void {
  res.writeHead(200, {
    'content-type': `${type}; charset=utf-8`,
    'content-length': Buffer.byteLength(body),
    'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  });
  res.end(body);
}
function fail(res: ServerResponse, _error: unknown, logger: StandaloneLogger): void {
  // Never echo or log provider errors: they may contain API keys or credential-bearing URLs.
  logger.error('独立模式路由处理失败（详细内容已省略以保护凭据）');
  if (res.headersSent) res.destroy();
  else sendJson(res, 500, { error: '本机服务暂时无法处理请求' });
}

function settingsHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let windowStart = Date.now();
  let count = 0;
  return async (req, res) => {
    if (!ai) {
      rejectRequest(res, 503, '本机 AI 设置尚未就绪');
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, publicSettings(ai.getSettings()));
      return;
    }
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 GET 或 POST');
      return;
    }
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      count = 0;
    }
    count += 1;
    if (count > 20) {
      rejectRequest(res, 429, '保存过于频繁，请稍后再试');
      return;
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      rejectRequest(res, 415, '请使用 JSON 保存设置');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        req.once('end', resolve);
        req.once('error', reject);
      });
      const input = validateSettings(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      sendJson(res, 200, publicSettings(await ai.saveSettings(input)));
    } catch {
      rejectRequest(res, 400, '设置未保存：请检查接口地址、模型名称、密钥和数值范围');
    }
  };
}

function testHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 POST');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        req.once('end', resolve);
        req.once('error', reject);
      });
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const input = bodyStr ? JSON.parse(bodyStr) : {};
      if (ai?.testConnection) {
        const result = await ai.testConnection(input);
        sendJson(res, 200, result);
      } else {
        sendJson(res, 200, { ok: false, message: '当前环境未配置测试能力' });
      }
    } catch {
      sendJson(res, 400, { ok: false, message: '请求格式无效' });
    }
  };
}

function petSettingsHandler(
  pet: StandalonePetSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let windowStart = Date.now();
  let count = 0;
  return async (req, res) => {
    if (!pet) {
      rejectRequest(res, 503, '桌宠设置尚未就绪');
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, pet.getSettings());
      return;
    }
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 GET 或 POST');
      return;
    }
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      count = 0;
    }
    count += 1;
    if (count > 20) {
      rejectRequest(res, 429, '保存过于频繁，请稍后再试');
      return;
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      rejectRequest(res, 415, '请使用 JSON 保存设置');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        req.once('end', resolve);
        req.once('error', reject);
      });
      const raw = Buffer.concat(chunks);
      if (raw.byteLength > MAX_SETTINGS_BYTES) {
        rejectRequest(res, 413, '设置内容过大');
        return;
      }
      sendJson(res, 200, await pet.saveSettings(JSON.parse(raw.toString('utf8'))));
    } catch (error) {
      rejectRequest(res, 400, error instanceof Error ? error.message : '桌宠设置未保存');
    }
  };
}

/**
 * 模型方案（哥哥 11-11 m19534）：一套方案 = 对话模型 + 看图 + 声音的整份快照。
 *   GET  → { activeId, profiles:[{id,name,savedAt}] }
 *   POST → { action: 'switch'|'snapshot'|'create'|'rename'|'remove', id?, name? } → 同上
 * 切换会真的写盘（AI 设置 + 宠物配置的 model 段），所以照旧要令牌、限频。
 */
function profileHandler(
  service: ProfileService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let windowStart = Date.now();
  let count = 0;
  const tooMany = (): boolean => {
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      count = 0;
    }
    count += 1;
    return count > 20;
  };
  return async (req, res) => {
    if (!service) {
      rejectRequest(res, 503, '模型方案尚未就绪');
      return;
    }
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, service.list());
        return;
      }
      if (req.method !== 'POST') {
        rejectRequest(res, 405, '仅支持 GET 或 POST');
        return;
      }
      if (tooMany()) {
        rejectRequest(res, 429, '点得太快了，请稍等一下');
        return;
      }
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        rejectRequest(res, 415, '请使用 JSON');
        return;
      }
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        req.once('end', resolve);
        req.once('error', reject);
      });
      const raw = Buffer.concat(chunks);
      if (raw.byteLength > MAX_SETTINGS_BYTES) {
        rejectRequest(res, 413, '内容过大');
        return;
      }
      const input: unknown = JSON.parse(raw.toString('utf8') || '{}');
      const dict = input !== null && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
      const action = String(dict.action ?? '');
      const id = typeof dict.id === 'string' ? dict.id : '';
      if (action === 'switch') sendJson(res, 200, await service.switchTo(id));
      else if (action === 'snapshot') sendJson(res, 200, service.snapshot());
      else if (action === 'create') sendJson(res, 200, await service.create(dict.name));
      else if (action === 'rename') sendJson(res, 200, service.rename(id, dict.name));
      else if (action === 'remove') sendJson(res, 200, await service.remove(id));
      else rejectRequest(res, 400, '不认识的动作');
    } catch (error) {
      rejectRequest(res, 400, error instanceof Error ? error.message : '模型方案没改成');
    }
  };
}

function dispatch(
  options: StandaloneServerOptions,
  shutdownSecurity?: RequestSecurity,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => void {
  const settings = settingsHandler(options.ai);
  const tester = testHandler(options.ai);
  const petSettings = petSettingsHandler(options.pet);
  const profiles = profileHandler(options.profiles);
  return (req, res, pathname) => {
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathname === '/' || pathname === '/health') {
      if (method !== 'GET' && method !== 'HEAD') {
        rejectRequest(res, 405, '仅支持 GET');
        return;
      }
      sendJson(res, 200, options.status?.() ?? { name: 'dsh-pet-standalone' }, true);
      return;
    }
    if (pathname === '/shutdown') {
      if (method !== 'POST') {
        rejectRequest(res, 405, '停机请使用 POST');
        return;
      }
      if (shutdownSecurity) {
        const supplied = req.headers['x-dsh-pet-token'];
        if (
          typeof supplied !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(shutdownSecurity.token))
        ) {
          rejectRequest(res, 403, '停机需要提供令牌');
          return;
        }
      }
      sendJson(res, 200, { ok: true, stopping: true });
      queueMicrotask(() => options.onShutdown?.());
      return;
    }
    const assets: Record<string, readonly [string, string]> = {
      '/standalone-ai/': [settingsPage, 'text/html'],
      '/standalone-ai/settings.js': [settingsScript, 'text/javascript'],
      '/standalone-ai/settings.css': [settingsStyle, 'text/css'],
      '/standalone-pet/': [petSettingsPage, 'text/html'],
      '/standalone-pet/pet.js': [petSettingsScript, 'text/javascript'],
      '/standalone-pet/pet.css': [petSettingsStyle, 'text/css'],
      '/standalone-pet/whisper': [whisperPage, 'text/html'],
      '/standalone-pet/whisper.js': [whisperScript, 'text/javascript'],
      '/standalone-pet/whisper.css': [whisperStyle, 'text/css'],
    };
    const asset = assets[pathname];
    if (asset) {
      if (method !== 'GET' && method !== 'HEAD') {
        rejectRequest(res, 405, '仅支持 GET');
        return;
      }
      sendAsset(res, asset[0], asset[1]);
      return;
    }
    if (pathname === '/standalone-ai/settings') {
      void settings(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    if (pathname === '/standalone-ai/test') {
      void tester(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    if (pathname === '/standalone-pet/settings') {
      void petSettings(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    if (pathname === '/standalone-pet/profiles') {
      void profiles(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    const route = options.routes.find((candidate) => matches(candidate, pathname));
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        `dsh-pet-standalone: 没有匹配的路由（已注册：${options.routes.map((item) => item.path).join(', ') || '无'}）`,
      );
      return;
    }
    try {
      void Promise.resolve(route.handler(req, res)).catch((error: unknown) => fail(res, error, options.logger));
    } catch (error) {
      fail(res, error, options.logger);
    }
  };
}

export function createRequestListener(
  options: StandaloneServerOptions,
  injectedSecurity?: RequestSecurity,
): (req: IncomingMessage, res: ServerResponse) => void {
  const security = options.security ?? injectedSecurity;
  const route = dispatch(options, security);
  return (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      rejectRequest(res, 400, '请求地址无效');
      return;
    }
    secureResponse(res, pathname);
    if (security && !security.authorize(req, res)) return;
    // Do not log paths, fragments, query parameters, request bodies or authorization headers.
    options.logger.debug('收到本机 HTTP 请求');
    const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
    const bodyMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '');
    if ((hasBody || bodyMethod) && typeof req.on === 'function') {
      const limit = pathname === '/standalone-ai/settings' ? MAX_SETTINGS_BYTES : MAX_REQUEST_BYTES;
      void boundedRequest(req, res, limit, options.bodyTimeoutMs)
        .then((bounded) => {
          if (bounded) route(bounded, res, pathname);
        })
        .catch((error: unknown) => fail(res, error, options.logger));
    } else route(req, res, pathname);
  };
}

/** 端口被别的程序占着（严格模式下不再顺延）。 */
export class PortBusyError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`端口 ${port} 被占用`);
    this.name = 'PortBusyError';
    this.port = port;
  }
}

async function bindFirstFree(
  server: HttpServer,
  preferred: number,
  logger: StandaloneLogger,
  strict = false,
): Promise<number> {
  const limit = strict ? 1 : PORT_SCAN_LIMIT;
  for (let port = preferred; port < preferred + limit; port += 1) {
    try {
      await new Promise<void>((accept, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          accept();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      if (preferred > 0 && bound !== preferred) logger.warn(`端口 ${preferred} 被占用，改用 ${bound}`);
      return bound;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw strict ? new PortBusyError(preferred) : new Error(`从 ${preferred} 起连续 ${PORT_SCAN_LIMIT} 个端口都被占用`);
}
export async function listenStandaloneServer(options: StandaloneServerOptions): Promise<StandaloneServer> {
  const security = options.security;
  const server = createServer(createRequestListener(options, security));
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.destroy());
  const port = await bindFirstFree(
    server,
    options.port ?? DEFAULT_STANDALONE_PORT,
    options.logger,
    options.strictPort === true,
  );
  options.logger.info(`独立模式服务已监听 http://127.0.0.1:${port}/`);
  return {
    port,
    security: security ?? createRequestSecurity(),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((accept) => server.close(() => accept()));
    },
  };
}
