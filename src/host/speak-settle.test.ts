/**
 * 「任务离队必须兑现 Promise」契约测试（11-16 体检 B1 的防复发）。
 *
 * 背景：嗓子仲裁中心里，每个排队任务都是一个 `new Promise`，resolve 存在 `speakSpecs` 里。
 * 只要有一条「把任务丢掉」的路忘了 resolve，`await sayWithVoice(...)` / `await centerSay(...)` /
 * `await speakOnce()` 就永远不会回来 —— 表现出来就是桥的 `POST /say` 不回包、菜单点了没反应。
 *
 * 所以钉住一条硬规矩：**只有 `dropSpeakJob` 里头才准 `speakSpecs.delete()`**，
 * 别处一律调 `dropSpeakJob`（它负责 delete + settle 两件事）。
 *
 * 这类错误编译器看不出来（删 Map 是合法操作），只能靠读源码断言。用 node:test，不引第三方依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const host = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

/** 数一数某个串出现几次 */
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** 去掉注释行（注释里照样会出现 `speakSpecs.delete()` 这种字样，不能算代码） */
const codeOnly = (source: string): string =>
  source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
    })
    .join('\n');

const hostCode = codeOnly(host);

describe('嗓子仲裁中心：任务离队都要兑现 Promise', () => {
  test('speakSpecs.delete( 只出现在两个帮手函数里', () => {
    assert.equal(
      count(hostCode, 'speakSpecs.delete('),
      2,
      '有地方绕过 dropSpeakJob / takeSpeakSpec 直接删表 —— 被删的那个 await 可能永远挂着',
    );
    const take = hostCode.indexOf('const takeSpeakSpec = ');
    const drop = hostCode.indexOf('const dropSpeakJob = ');
    const at = hostCode.indexOf('speakSpecs.delete(');
    const at2 = hostCode.indexOf('speakSpecs.delete(', at + 1);
    assert.ok(take >= 0 && drop >= 0, '两个帮手函数不见了');
    // 第一处（takeSpeakSpec 里）必须在它自己的函数体范围里
    assert.ok(at > take && at < take + 300, '第一处 speakSpecs.delete 不在 takeSpeakSpec 里');
    assert.ok(at2 > drop && at2 < drop + 600, '第二处 speakSpecs.delete 不在 dropSpeakJob 里');
  });

  test('取任务（takeSpeakSpec）不许顺手 settle', () => {
    const start = hostCode.indexOf('const takeSpeakSpec = ');
    const body = hostCode.slice(start, start + 220);
    assert.ok(!body.includes('settle?.'), 'takeSpeakSpec 不该兑现 Promise —— 它负责的是马上要播的那条');
  });

  test('四条丢弃路径都走 dropSpeakJob', () => {
    // 四个调用点（过期 / 顶掉 / 队列满 / 打断）
    assert.ok(count(hostCode, 'dropSpeakJob(') >= 4, '丢弃路径没有全部改成 dropSpeakJob');
    assert.ok(hostCode.includes('const dropSpeakJob = '), 'dropSpeakJob 定义不见了');
    for (const reason of ["'expired'", "'replaced'", "'queue-full'"]) {
      assert.ok(hostCode.includes(reason), `少了 ${reason} 这个丢弃原因`);
    }
  });

  test('dropSpeakJob 里真的 settle（不是只删表）', () => {
    const start = host.indexOf('const dropSpeakJob = ');
    assert.ok(start >= 0);
    const body = host.slice(start, start + 600);
    assert.match(body, /speakSpecs\.delete\(/, 'dropSpeakJob 没有删表');
    assert.match(body, /settle\?\.\(/, 'dropSpeakJob 没有兑现 Promise —— 这正是 B1 那个 bug');
  });

  test('打断时排队的任务也要兑现（不能只处理正在播的那条）', () => {
    const start = host.indexOf('const centerInterrupt = ');
    const body = host.slice(start, start + 900);
    assert.match(body, /for \(const job of speakQueue\) dropSpeakJob\(/, '打断清队列时没兑现排队任务');
  });
});