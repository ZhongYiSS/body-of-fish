/**
 * ffmpeg-choice.test.ts —— 抓屏引擎「不许再把没有 ddagrab 的那份写死」。
 *
 * 为什么要有这组测试（11-19 m30590 真事）：`watchFfmpeg()` 曾经硬编码
 * `D:\AI\GPT-SoVITS\ffmpeg.exe`，而那份**没有编 ddagrab**；陪伴抓屏连着三次
 * `No such filter: 'ddagrab'` 之后按「三次没起来」自动停 —— 哥哥看到的就是
 * 「打开陪伴，过一会儿它自己关了」，日志里一句人话都没有。
 *
 * 这组断言只钉三件事：
 *   1. 三处原来写死路径的地方都改成了 `resolvedFfmpeg()`；
 *   2. `capture.ts` 真的会探测 ddagrab，并且探测得到结果时优先选带它的那份；
 *   3. 一眼看的菜单标题在「没启动过」时用配置里的间隔兜底（不再是 0 → 只写「关」）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8').split('\r\n').join('\n');
/** 去掉注释行：注释里还留着「以前写死 GPT-SoVITS 那份」的历史说明，不算代码。 */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
    .join('\n');

const indexCode = read('./index.ts');
const companionCode = read('./companion.ts');
const captureCode = read('./capture.ts');
const sourceCode = read('./capture-source.ts');
const menuCode = read('./pet-menu.ts');

test('抓屏引擎：三处不再写死 GPT-SoVITS 那份 ffmpeg', () => {
  assert.equal(/GPT-SoVITS/u.test(codeOf(indexCode)), false, 'index.ts 里还有 GPT-SoVITS 的 ffmpeg 路径');
  assert.equal(/GPT-SoVITS/u.test(codeOf(companionCode)), false, 'companion.ts 里还有写死的 ffmpeg 路径');
  assert.match(indexCode, /const watchFfmpeg = \(\): string \| undefined => resolvedFfmpeg\(\);/u);
  assert.match(companionCode, /const ffmpegPath = resolvedFfmpeg\(\);/u);
});

test('抓屏引擎：capture.ts 会探测 ddagrab，并优先选带它的那份', () => {
  assert.match(captureCode, /export function hasDdagrab\(bin: string\): boolean/u);
  assert.match(captureCode, /export function resolvedFfmpeg\(\): string/u);
  assert.match(captureCode, /const withDda = existing\.find\(\(item\) => hasDdagrab\(item\)\);/u);
  assert.match(captureCode, /cachedBin = withDda \?\? existing\[0\] \?\? 'ffmpeg';/u);
});

test('抓屏引擎：没有 ddagrab 时退回 gdigrab，而不是直接报错', () => {
  assert.match(sourceCode, /export function ddaInput\(fps\?: number, useDda = true\): string\[\]/u);
  assert.match(sourceCode, /'gdigrab'/u);
  assert.match(sourceCode, /export function ddaVf\(rest: string, useDda = true\): string/u);
});

test('一眼看标题：没启动过时用配置里的间隔兜底', () => {
  assert.match(indexCode, /const configuredCompanionMs = \(\): number => \{/u);
  const hits = indexCode.split('companionIntervalMs: companionIntervalMs > 0 ? companionIntervalMs : configuredCompanionMs(),').length - 1;
  assert.equal(hits, 2, `兜底应出现在菜单状态与状态行两处，实际 ${hits} 处`);
});

test('副气泡文案：自定义时间说的是秒，不是分钟', () => {
  // 只看真代码：注释里留着「填分钟数」的历史说明（第 47 行），不算文案。
  const codeOnly = codeOf(menuCode);
  assert.match(codeOnly, /自定义窗口打开了：填秒数点保存/u);
  assert.equal(/填分钟数/u.test(codeOnly), false);
});