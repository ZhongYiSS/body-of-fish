/**
 * 干什么：钉住「留空 = 跟随 AI 设置」只有**一个**补全口，别再有人手写一份。
 * 为什么：11-20 m34651 的实况是 chat 被历史快照钉死在 DeepSeek 官方、识图模型名没人补
 *        —— 根因就是补全逻辑散在各处、每处各漏一样。
 * 什么时候别用：换掉 fillRemoteBackends 这个实现时，这个文件应该跟着一起改。
 * 常见坑：断言的是**源码文本**（不 import 宿主），所以注释里出现同样的字符串也会命中——
 *        下面每条都挑了不会被注释重复的写法。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, '..', 'index.ts'), 'utf8');
const coreSrc = readFileSync(join(here, '..', 'core', 'model-config.ts'), 'utf8');

describe('AI 设置补全的唯一入口', () => {
  test('core 里只有一处实现', () => {
    assert.equal(coreSrc.match(/export function fillRemoteBackends\(/gu)?.length, 1);
  });

  test('宿主的 fillCloudBackend 只是委托，不再自己拼字段', () => {
    assert.match(indexSrc, /const fillCloudBackend = [^=]+=>\s*fillRemoteBackends\(config, standaloneConn\(\)\);/u);
    // 旧实现的特征串：手写 spread 出来的 baseUrl/apiKey（漏了 model 那一版）
    assert.equal(indexSrc.includes('baseUrl: cap.backend.baseUrl || conn.baseUrl'), false);
    assert.equal(indexSrc.includes('chatBackend.baseUrl || conn?.baseUrl'), false);
  });

  test('/summarize 也走同一个口（原来手补地址和 key，模型名留空就报「还没填模型名」）', () => {
    assert.match(indexSrc, /const summarizeConfig = fillRemoteBackends\(parseModelConfig\(found\.conf\.model\), standaloneConn\(\)\);/u);
  });

  test('四处自己 parse 的网关都补过（servicesProvider / 旁听吐槽 / services 试一下）', () => {
    assert.equal(indexSrc.match(/const modelConfig = fillCloudBackend\(parseModelConfig\(conf\.model\)\);/gu)?.length, 3);
    assert.match(indexSrc, /const config = fillCloudBackend\(parseModelConfig\(found\?\.conf\.model\)\);/u);
  });
});