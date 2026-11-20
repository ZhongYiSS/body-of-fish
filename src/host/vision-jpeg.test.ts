/**
 * 0.6 第 2 步「识图改 JPEG」的钉子测试。
 *
 * 钉三件事：
 *   1) `stillScaleExpression()` 的宽度规则（窄屏原样 / 普通屏 1536 / 4K 屏 1920）；
 *   2) `sniffImageMime()` 按魔数认格式（JPEG 那双 FF D8 FF 不能认成 PNG）；
 *   3) 宫格出图带 `-q:v 4`（不然送出去的是低质量 JPEG，字会糊）。
 *
 * 不跑真 ffmpeg、不碰屏幕。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { STILL_QUALITY, stillScaleExpression, WIDE_SCREEN_WIDTH } from './capture';
import { gridArgs } from './grid';
import { sniffImageMime } from './core/adapters/openai-compat';

test('出图宽度规则：普通屏 1536、超宽屏 1920、窄屏原样', () => {
  const expr = stillScaleExpression();
  assert.ok(expr.includes('1536'), '要能缩到 1536');
  assert.ok(expr.includes('1920'), '4K 屏要按 1920 取');
  assert.ok(expr.includes(String(WIDE_SCREEN_WIDTH)), '阈值要写进表达式');
  assert.ok(expr.includes('min(iw'), '窄屏不许放大');
  assert.ok(expr.includes('trunc'), '要取偶数边（JPEG 的 yuvj420p 要求）');
});

test('JPEG 质量默认 qv4（约 320KB，字还认得清）', () => {
  assert.equal(STILL_QUALITY, 4);
});

test('sniffImageMime：JPEG 不能认成 PNG', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(sniffImageMime(jpeg), 'image/jpeg');
});

test('sniffImageMime：PNG / GIF / WEBP / 认不出来', () => {
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'image/png');
  assert.equal(sniffImageMime(Buffer.from('GIF89a', 'ascii')), 'image/gif');
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert.equal(sniffImageMime(webp), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from([1, 2, 3])), 'image/png');
});

test('宫格出图：带 -q:v 4，输出走 JPEG', () => {
  const frame = { file: 'a.jpg', at: 0 };
  const args = gridArgs({ frames: [frame], out: 'grid.jpg' });
  const q = args.indexOf('-q:v');
  assert.ok(q > 0, '缺 -q:v');
  assert.equal(args[q + 1], '4');
  assert.equal(args[args.length - 1], 'grid.jpg');
});