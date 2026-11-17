/**
 * 对外门面 `/v1/*` 的契约（第 5 批）：别名映射、两条前缀都注册、`/v1` 要令牌。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const host = readFileSync(join(here, 'index.ts'), 'utf8');
const security = readFileSync(join(here, '..', 'standalone', 'request-security.ts'), 'utf8');

describe('/v1 对外门面', () => {
  it('同一份 handler 挂在内部与 /v1 两条前缀上', () => {
    assert.match(host, /const petRouteHandler = async \(req: IncomingMessage, res: ServerResponse\)/u);
    assert.match(host, /path: ROUTE_PREFIX, handler: petRouteHandler/u);
    assert.match(host, /path: '\/v1', handler: petRouteHandler/u);
  });

  it('"/v1/state" 会被翻成内部 "/dsh-pet-7340/state"', () => {
    assert.match(host, /const viaV1 = rawPath\.startsWith\('\/v1\/'\);/u);
    assert.match(host, /rawPath\.slice\('\/v1\/'\.length\)/u);
    assert.match(host, /noteSense\(`v1 alias rest=/u);
  });

  it('"/v1" 不在免令牌名单里（外部调用必须带 x-dsh-pet-token）', () => {
    // 免令牌名单里只有 `/dsh-pet-<端口>/` 这条通配，没有 `/v1`
    assert.doesNotMatch(security, /\/v1/u);
    assert.match(security, /\^\\\/dsh-pet-/u);
  });
});
