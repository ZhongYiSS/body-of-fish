/**
 * 双模式连接（检测独立桌宠）的守卫用例：**不联网**，假 fetch。
 * 重点：手改坏的运行时文件不许把启动流程弄崩；探测失败必须给人话。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseStandaloneRuntime, probeStandalone } from './connection.ts';

const GOOD = {
  name: 'dsh-pet-standalone',
  pid: 4242,
  startedAt: '2026-10-30T06:00:00.000Z',
  port: 3081,
  token: 'abc123',
  settingsUrl: 'http://127.0.0.1:3081/settings',
  pluginRoot: 'C:/x',
};

describe('parseStandaloneRuntime（读运行时文件）', () => {
  test('正常文件 → 全字段读出来', () => {
    const info = parseStandaloneRuntime(GOOD);
    assert.equal(info?.port, 3081);
    assert.equal(info?.token, 'abc123');
    assert.equal(info?.pid, 4242);
  });

  test('不是对象 / 端口非法 / 没 token → null（当没有）', () => {
    assert.equal(parseStandaloneRuntime(null), null);
    assert.equal(parseStandaloneRuntime('x'), null);
    assert.equal(parseStandaloneRuntime({ ...GOOD, port: 0 }), null);
    assert.equal(parseStandaloneRuntime({ ...GOOD, port: 70000 }), null);
    assert.equal(parseStandaloneRuntime({ ...GOOD, port: 'abc' }), null);
    assert.equal(parseStandaloneRuntime({ ...GOOD, token: '  ' }), null);
  });

  test('name 是别人写的 → null（别把别的工具的端口当桌宠）', () => {
    assert.equal(parseStandaloneRuntime({ ...GOOD, name: 'other-tool' }), null);
  });

  test('端口是字符串数字 → 认（写入方可能序列化成字符串）', () => {
    assert.equal(parseStandaloneRuntime({ ...GOOD, port: '3081' })?.port, 3081);
  });
});

describe('probeStandalone（探一次）', () => {
  const info = parseStandaloneRuntime(GOOD)!;

  test('200 且带 pets → ok', async () => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      assert.equal(url, 'http://127.0.0.1:3081/dsh-pet-7340/state');
      assert.equal((init.headers as Record<string, string>)['x-dsh-pet-token'], 'abc123');
      return new Response(JSON.stringify({ sections: {}, pets: { main: {} } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await probeStandalone(info, { fetchImpl });
    assert.equal(result.ok, true);
    assert.match(result.message, /3081/);
  });

  test('401 → 明确说 token 对不上（不要误报"没在跑"）', async () => {
    const fetchImpl = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    const result = await probeStandalone(info, { fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.message, /token/);
  });

  test('200 但不是桌宠的形状 → ok:false', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ hello: 'world' }), { status: 200 })) as unknown as typeof fetch;
    const result = await probeStandalone(info, { fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.message, /pets/);
  });

  test('连不上 → 说清端口和原因', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await probeStandalone(info, { fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.message, /127\.0\.0\.1:3081/);
  });

  test('超时 → 说等了多少毫秒', async () => {
    // 假 fetch 要"认" signal：真 fetch 在超时后会 reject，这里照做，否则测不到超时分支
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const result = await probeStandalone(info, { fetchImpl, timeoutMs: 20 });
    assert.equal(result.ok, false);
    assert.match(result.message, /20 毫秒/);
  });
});
