import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestSecurity {
  /** Process capability: private launcher manifest only, never an HTTP response or log. */
  readonly token: string;
  authenticatedUrl(baseUrl: string): string;
  authorize(req: IncomingMessage, res: ServerResponse): boolean;
}

/**
 * 拒绝一个请求。`reason` 是给排查用的机器可读标签（【本鱼 · 11-15】外部用户报 403 时，
 * 桥只看得见一句话，分不清「没带令牌 / 格式不对 / 令牌不对」）。
 */
export function rejectRequest(res: ServerResponse, status: number, error: string, reason?: string): false {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(reason === undefined ? { error } : { error, reason }));
  return false;
}

function publicRead(req: IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let path: string;
  try {
    /**
     * 【11-16 体检】先解码再判：URL.pathname 不解码，于是
     * `/dsh-pet-1/%2e%2e/standalone-pet/settings` 能蹭「/dsh-pet-N/ 免令牌」这条前缀，
     * 再被路由按解码后的路径分派到真正要令牌的设置接口。解不出、或解完带 `..`，
     * 一律当不安全（要令牌），宁可多拒不多放。
     */
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  } catch {
    return false;
  }
  if (path.includes('..')) return false;
  if (['/standalone-ai/settings', '/standalone-pet/settings', '/standalone-pet/profiles', '/shutdown'].includes(path)) return false;
  if (/^\/dsh-pet-\d+\/(?:whisper|chat)(?:\/|$)/.test(path)) return false;
  return (
    [
      '/',
      '/health',
      '/standalone-ai/',
      '/standalone-ai/settings.js',
      '/standalone-ai/settings.css',
      '/standalone-pet/',
      '/standalone-pet/pet.js',
      '/standalone-pet/pet.css',
      // 右键「碎碎念 → 自定义间隔…」的小窗：和主设置页一样是"公开的壳"——
      // 令牌在 #hash 里（浏览器不发 hash 给服务器），页面本身必须免令牌才能打开；
      // 真正读写配置的 /standalone-pet/settings 仍然要令牌（见上面那条）。
      '/standalone-pet/whisper',
      '/standalone-pet/whisper.js',
      '/standalone-pet/whisper.css',
    ].includes(path) ||
    /^\/dsh-pet-\d+\//.test(path)
  );
}

/** Origin/Fetch-Metadata are CSRF checks; the custom capability header also excludes HTML forms. */
export function createRequestSecurity(): RequestSecurity {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    authenticatedUrl(baseUrl) {
      const base = new URL(baseUrl);
      if (
        base.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(base.hostname) ||
        base.username ||
        base.password
      ) {
        throw new Error('设置地址必须是本机 HTTP 地址');
      }
      return `${base.origin}/standalone-ai/#token=${token}`;
    },
    authorize(req, res) {
      /**
       * 【11-16 体检】Host 头谁都能写，socket 的对端地址不能。
       * 本服务只绑回环，正常一定对得上；对不上说明是从外面转进来的，直接拒。
       * （测试里的假 req 没有 remoteAddress，按「本机」放行，不影响判据。）
       */
      const remote = req.socket.remoteAddress;
      if (remote !== undefined && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        return rejectRequest(res, 403, '仅允许本机访问', 'not-loopback');
      }
      const host = req.headers.host;
      const port = req.socket.localPort;
      if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
        return rejectRequest(res, 403, '仅允许当前本机地址');
      }
      if (
        (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) ||
        req.headers['sec-fetch-site'] === 'cross-site'
      ) {
        return rejectRequest(res, 403, '不允许跨站请求');
      }
      try {
        if (publicRead(req)) return true;
      } catch {
        return rejectRequest(res, 400, '请求地址无效');
      }
      const supplied = req.headers['x-dsh-pet-token'];
      const denied = '请从桌宠菜单重新打开设置';
      if (typeof supplied !== 'string' || supplied === '') {
        return rejectRequest(res, 403, denied, 'missing-token');
      }
      if (!/^[A-Za-z0-9_-]{43}$/.test(supplied)) {
        // 带上引号/空格/`SESSDATA=` 那种脏值最容易落在这里
        return rejectRequest(res, 403, denied, 'bad-token-format');
      }
      if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
        return rejectRequest(res, 403, denied, 'token-mismatch');
      }
      return true;
    },
  };
}

/** Upstream plugin handlers write wildcard CORS; remove it at the actual HTTP boundary. */
export function secureResponse(res: ServerResponse, pathname?: string): void {
  const writeHead = res.writeHead.bind(res);
  const isPublicOp = pathname === '/' || pathname === '/health';
  res.writeHead = ((status: number, ...args: unknown[]) => {
    const filtered = isPublicOp
      ? args
      : args.map((value) => {
          if (Array.isArray(value)) {
            return value.reduce<string[]>((result, item, index) => {
              if (index % 2 === 0 && !String(item).toLowerCase().startsWith('access-control-')) {
                return [...result, String(item), String(value[index + 1])];
              }
              return result;
            }, []);
          }
          if (value !== null && typeof value === 'object') {
            return Object.fromEntries(
              Object.entries(value).filter(([name]) => !name.toLowerCase().startsWith('access-control-')),
            );
          }
          return value;
        });
    if (!isPublicOp) {
      for (const name of res.getHeaderNames()) {
        if (name.toLowerCase().startsWith('access-control-')) res.removeHeader(name);
      }
    }
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    return Reflect.apply(writeHead, res, [status, ...filtered]);
  }) as typeof res.writeHead;
}
