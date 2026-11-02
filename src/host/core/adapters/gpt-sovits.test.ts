/**
 * GPT-SoVITS 发声适配的守卫用例。
 *
 * 这条链路最容易出的事是「填了地址但没填参考音」和「服务回了错误 JSON 却只报 HTTP 码」，
 * 所以重点测：URL 拼得对、真错把 GSV 的 Exception 原话带出去、空音频别当成成功。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ModelCallError } from './openai-compat.ts';
import { sovitsSpeak, sovitsTtsUrl } from './gpt-sovits.ts';

const TARGET = {
  endpoint: 'http://127.0.0.1:9880',
  refAudioPath: 'D:\\AI\\GPT-SoVITS\\_ref.wav',
  promptText: '哥哥，我是本鱼，今天也要好好吃饭哦！',
};

describe('sovitsTtsUrl（拼参数）', () => {
  test('没写 /tts 就补上，写了就不重复', () => {
    assert.match(sovitsTtsUrl(TARGET, '你好'), /^http:\/\/127\.0\.0\.1:9880\/tts\?/);
    assert.match(sovitsTtsUrl({ ...TARGET, endpoint: 'http://127.0.0.1:9880/' }, '你好'), /\/tts\?/);
    const once = sovitsTtsUrl({ ...TARGET, endpoint: 'http://127.0.0.1:9880/tts' }, '你好');
    assert.equal(once.match(/\/tts/g)?.length, 1);
  });

  test('参考音与它念的话都进查询串，中文不乱码', () => {
    const url = new URL(sovitsTtsUrl(TARGET, '本鱼来了'));
    assert.equal(url.searchParams.get('text'), '本鱼来了');
    assert.equal(url.searchParams.get('ref_audio_path'), TARGET.refAudioPath);
    assert.equal(url.searchParams.get('prompt_text'), TARGET.promptText);
    assert.equal(url.searchParams.get('text_lang'), 'zh');
    assert.equal(url.searchParams.get('prompt_lang'), 'zh');
    assert.equal(url.searchParams.get('text_split_method'), 'cut5');
    assert.equal(url.searchParams.get('media_type'), 'wav');
    assert.equal(url.searchParams.get('streaming_mode'), 'false');
    assert.equal(url.searchParams.get('speed_factor'), '1');
  });

  test('语言与语速可以覆盖', () => {
    const url = new URL(sovitsTtsUrl({ ...TARGET, textLang: 'ja', promptLang: 'en', speedFactor: 1.25 }, 'x'));
    assert.equal(url.searchParams.get('text_lang'), 'ja');
    assert.equal(url.searchParams.get('prompt_lang'), 'en');
    assert.equal(url.searchParams.get('speed_factor'), '1.25');
  });
});

describe('sovitsSpeak（取音频）', () => {
  test('正常回音频字节', async () => {
    const audio = await sovitsSpeak(TARGET, '你好', {
      fetchImpl: (async () => new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46])) as Response) as typeof fetch,
    });
    assert.deepEqual([...audio], [0x52, 0x49, 0x46, 0x46]);
  });

  test('404 → not-configured（地址填错，不是"服务坏了"）', async () => {
    const fetchImpl = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    await assert.rejects(sovitsSpeak(TARGET, 'x', { fetchImpl }), (error: unknown) => {
      assert.ok(error instanceof ModelCallError);
      assert.equal(error.code, 'not-configured');
      assert.match(error.message, /没有 \/tts/);
      return true;
    });
  });

  test('GSV 的 Exception 原话要带出去（别只报 HTTP 400）', async () => {
    const body = JSON.stringify({ message: 'tts failed', Exception: '参考音路径不存在' });
    const fetchImpl = (async () => new Response(body, { status: 400 })) as typeof fetch;
    await assert.rejects(sovitsSpeak(TARGET, 'x', { fetchImpl }), (error: unknown) => {
      assert.ok(error instanceof ModelCallError);
      assert.equal(error.code, 'bad-response');
      assert.match(error.message, /参考音路径不存在/);
      return true;
    });
  });

  test('空音频不当成功', async () => {
    const fetchImpl = (async () => new Response(new Uint8Array(0))) as typeof fetch;
    await assert.rejects(sovitsSpeak(TARGET, 'x', { fetchImpl }), (error: unknown) => {
      assert.ok(error instanceof ModelCallError);
      assert.match(error.message, /空音频/);
      return true;
    });
  });

  test('连不上 → endpoint-down', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;
    await assert.rejects(sovitsSpeak(TARGET, 'x', { fetchImpl }), (error: unknown) => {
      assert.ok(error instanceof ModelCallError);
      assert.equal(error.code, 'endpoint-down');
      return true;
    });
  });
});
