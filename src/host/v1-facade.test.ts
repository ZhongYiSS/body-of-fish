/**
 * 对外门面 `/v1/*` 的契约（11-17 第 5 批补）：统一信封 + 八条真门面 + SSE。
 * 只读源码做契约断言（路由层要起 HTTP 才好测，这里钉死形状与映射）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const host = readFileSync(join(here, 'index.ts'), 'utf8');

/** 去掉行注释，免得注释里的关键字骗过断言。 */
const codeOnly = (text: string): string =>
  text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const code = codeOnly(host);

describe('/v1 真门面', () => {
  it('统一信封：成功 { ok: true, data }、失败 { ok: false, error }', () => {
    assert.match(code, /const v1Envelope = \(result: RouteResult\): RouteResult => \{/u);
    assert.match(code, /obj: ok \? \{ ok: true, data: result\.obj \} : \{ ok: false, error: result\.obj \}/u);
  });

  it('八条门面都在：state / config / say / look / show / do / media / events', () => {
    for (const name of ['state', 'config', 'say', 'look', 'show', 'do', 'media']) {
      assert.match(code, new RegExp(`if \\(rest === '${name}'|if \\(rest\\.startsWith\\('${name}/'\\)`, 'u'), `缺少 ${name}`);
    }
    assert.match(code, /\/v1\/events/u, '缺少 events（SSE）');
  });

  it('show 走只冒泡那条（内部 /broadcast），不是出声', () => {
    assert.match(code, /if \(rest === 'show'\) return method === 'POST' \? v1Forward\('broadcast', 'POST', body\)/u);
  });

  it('do 只认五种动作，别的一律 400', () => {
    assert.match(code, /const V1_DO_ROUTES: Readonly<Record<string, string>> = \{/u);
    for (const kind of ['anim', 'throw', 'lock', 'position', 'lyric']) {
      assert.match(code, new RegExp(`\\b${kind}: '${kind}'`, 'u'), `V1_DO_ROUTES 缺 ${kind}`);
    }
    assert.match(code, /do\.kind 只收 anim \/ throw \/ lock \/ position \/ lyric/u);
  });

  it('media 翻成内部的 thumb 路由', () => {
    assert.match(code, /v1Forward\(`thumb\/\$\{rest\.slice\('media\/'\.length\)\}`/u);
  });

  it('认不出的 /v1/* 仍然按别名落到内部路由（旧调用不断）', () => {
    assert.match(code, /const v1 = await handleV1Rest\(rest, method, body\);/u);
    assert.match(code, /if \(v1 !== undefined\) return v1;/u);
    assert.match(code, /noteSense\(`v1 alias rest=/u);
  });

  it('SSE：每 1 秒推变化的 state、15 秒一个心跳、断开就收摊', () => {
    assert.match(code, /'content-type': 'text\/event-stream; charset=utf-8'/u);
    assert.match(code, /emit\('state', text\);/u);
    assert.match(code, /const emit = \(name: string, payload: string\): void => \{/u);
    assert.match(code, /emit\('say', JSON\.stringify\(\{ pet: petId/u);
    assert.match(code, /emit\('hint', JSON\.stringify\(\{ pet: petId/u);
    assert.match(code, /\}, 1_000\);/u);
    assert.match(code, /: ping\\n\\n/u);
    assert.match(code, /\}, 15_000\);/u);
    assert.match(code, /req\.on\('close', stop\);/u);
    assert.match(code, /res\.on\('close', stop\);/u);
  });
});