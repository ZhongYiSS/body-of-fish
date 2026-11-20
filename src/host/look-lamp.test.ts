/**
 * 「【在看】」这只灯的时间线（哥哥 11-20 m31853）。
 *
 * 他看到的：按一眼看之后要等一会儿才冒【在看】，而且一闪就没了。
 * 根因：灯挂在 `thinkOnScreen`（截屏 + 识图都做完、只剩生成那 1~2 秒）上，
 * 而整轮是 4~5 秒 —— 亮得晚、灭得早。
 *
 * 这一份是结构契约（读源码）：先后关系靠行为测试抓不稳。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const code = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8').split('\r\n').join('\n');

test('【在看】在「按下那一刻」亮：一眼看进门就点灯，早于截屏/识图', () => {
  const at = code.indexOf('const lookOnce = async (');
  assert.ok(at > 0, '找不到 lookOnce');
  const body = code.slice(at, code.indexOf('const sayOnce = async (', at));
  const lampAt = body.indexOf("pushHint('watch', '【在看】'");
  assert.ok(lampAt > 0, 'lookOnce 里没有点【在看】');
  const shotAt = body.indexOf('await screenCapture.capture()');
  const eyesAt = body.indexOf('.eyes.look(');
  assert.ok(shotAt > 0 && eyesAt > 0, '找不到截屏 / 识图调用');
  assert.ok(lampAt < shotAt, '灯要在截屏之前亮（截屏要 0.5 秒）');
  assert.ok(lampAt < eyesAt, '灯要在识图之前亮（识图 2~5 秒，这是「等太久」的主因）');
  // 所有出口都要灭灯
  assert.ok(/finally \{\s*\/\/ 兜底[\s\S]{0,200}dropHint\('watch'\);/u.test(body), 'lookOnce 缺 finally 灭灯');
});

test('灯只由一处点亮：thinkOnScreen 不再自己点（否则同一件事亮两盏）', () => {
  const at = code.indexOf('const thinkOnScreen = async <T>(');
  assert.ok(at > 0);
  const body = code.slice(at, at + 900);
  assert.ok(!body.includes('pushHint('), 'thinkOnScreen 里不该再点灯');
  assert.ok(body.includes('mind.begin('), 'thinkOnScreen 仍要登记并发的想');
  assert.equal(code.includes('thinkScreen'), false, 'thinkScreen 这盏已并进 watch，不该再出现');
});

test('她开口那一刻灭【在看】，换成【在说】', () => {
  const inner = code.indexOf('const runSpeakTextInner = async (');
  assert.ok(inner > 0);
  const showAt = code.indexOf('const show = (): void => {', inner);
  assert.ok(showAt > 0);
  const showBody = code.slice(showAt, showAt + 1_400);
  const offAt = showBody.indexOf("dropHint('watch')");
  const onAt = showBody.indexOf("pushHint('say'");
  assert.ok(offAt > 0, 'show() 里要灭「在看」');
  assert.ok(onAt > offAt, '先灭「在看」再挂「在说」');
  assert.ok(offAt > showBody.indexOf('bubbleOwner = { petId, source };'), '灭灯要在「真的开始播」之后');
});