/**
 * 宫格拼图的纯函数测试（哥哥 11-19 m30766：3×2、每格烧时间）。
 * 真拼一张要 ffmpeg，这里只测参数与补位逻辑；真机实测 6 帧 → 600KB / 410ms。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CELL_H,
  CELL_W,
  GRID_FRAMES,
  cellFilter,
  escapeFilterValue,
  escapeFontPath,
  gridArgs,
  layoutOf,
  padFrames,
  stampText,
} from './grid.ts';

const frame = (i: number): { file: string; at: number } => ({ file: `/tmp/f${i}.png`, at: i });

test('宫格：3×2 的 layout 是六个坐标', () => {
  assert.equal(GRID_FRAMES, 6);
  assert.equal(layoutOf(), `0_0|${CELL_W}_0|${CELL_W * 2}_0|0_${CELL_H}|${CELL_W}_${CELL_H}|${CELL_W * 2}_${CELL_H}`);
});

test('宫格：帧不够就重复最后一帧补齐，一张都没有返回空', () => {
  const padded = padFrames([frame(0), frame(1)]);
  assert.equal(padded.length, 6);
  assert.deepEqual(padded.slice(2).map((item) => item.file), Array(4).fill('/tmp/f1.png'));
  assert.deepEqual(padFrames([]), []);
  // 超过 6 张只取最后 6 张
  const many = padFrames(Array.from({ length: 9 }, (_, i) => frame(i)));
  assert.deepEqual(many.map((item) => item.file), ['/tmp/f3.png', '/tmp/f4.png', '/tmp/f5.png', '/tmp/f6.png', '/tmp/f7.png', '/tmp/f8.png']);
});

test('宫格：时间戳文本是 HH:MM:SS', () => {
  const at = new Date(2026, 10, 19, 17, 4, 9).getTime();
  assert.equal(stampText(at), '17:04:09');
});

test('宫格：文本转义单反斜杠、字体路径转义双反斜杠', () => {
  assert.equal(escapeFilterValue('17:04:09'), '17\\:04\\:09');
  assert.equal(escapeFontPath('C:/Windows/Fonts/msyh.ttc'), 'C\\\\:/Windows/Fonts/msyh.ttc');
});

test('宫格：每一格先 scale 再 pad，不硬拉', () => {
  const filter = cellFilter(0, 0, { font: '' });
  assert.match(filter, /^\[0:v\]scale=512:340:force_original_aspect_ratio=decrease,pad=512:340:/u);
  assert.ok(!filter.includes('drawtext'), '没字体就不烧字');
});

test('宫格：ffmpeg 参数里六个输入 + xstack + 只取一帧', () => {
  const args = gridArgs({ frames: [frame(0)], out: 'out.png' });
  assert.equal(args.filter((item) => item === '-i').length, 6);
  assert.ok(args.some((item) => item.includes('xstack=inputs=6')));
  // 出 JPEG 送识图：只取一帧 + qv4（质量再降字就糊了，见 vision-jpeg.test.ts）
  assert.deepEqual(args.slice(-6), ['-frames:v', '1', '-q:v', '4', '-y', 'out.png']);
});