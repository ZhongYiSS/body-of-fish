/**
 * capture-source 的测试：抓屏输入参数 + 保持比例缩放。
 * 这里的数字都来自实测：本机屏 2560×1600、DSH 窗口 1941×1243、WPS 最大化 2560×1528。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DDA_DOWNLOAD, ddaInput, ddaVf, fitInside } from './capture-source.ts';

describe('抓屏输入：ddagrab', () => {
  it('不传帧率就用 ddagrab 自己的节奏', () => {
    assert.deepEqual(ddaInput(), ['-f', 'lavfi', '-i', 'ddagrab=0']);
  });

  it('帧率写在 ddagrab 的参数里，不用 -framerate', () => {
    assert.deepEqual(ddaInput(12), ['-f', 'lavfi', '-i', 'ddagrab=0:framerate=12']);
  });

  it('滤镜链必须先下载 d3d11 帧', () => {
    assert.equal(ddaVf(''), DDA_DOWNLOAD);
    assert.equal(ddaVf('scale=1536:960,format=rgb24'), 'hwdownload,format=bgra,scale=1536:960,format=rgb24');
    // 只有空白的尾巴别拼出多余的逗号
    assert.equal(ddaVf('   '), DDA_DOWNLOAD);
  });
});

describe('缩放：保持长宽比', () => {
  it('整屏 1536×960 进 1280×800 的框 = 1280×800（1.6:1 正好）', () => {
    assert.deepEqual(fitInside(1536, 960, 1280, 800), { width: 1280, height: 800 });
  });

  it('DSH 窗口 1941×1243 不再被拉成 1280×800', () => {
    const box = fitInside(1941, 1243, 1280, 800);
    // 高度先顶到 800，宽度跟着比例走（以前是硬压成 1280×800，横向挤 2.5%）
    assert.deepEqual(box, { width: 1249, height: 800 });
    // 比例误差不超过一个像素
    assert.ok(Math.abs(box.width / box.height - 1941 / 1243) < 0.01);
  });

  it('竖窗口不会被横向拉两倍', () => {
    const box = fitInside(900, 1200, 1280, 800);
    assert.deepEqual(box, { width: 600, height: 800 });
  });

  it('小窗口原样返回，不放大', () => {
    assert.deepEqual(fitInside(400, 300, 1280, 800), { width: 400, height: 300 });
  });

  it('坏数字不抛，退回框本身', () => {
    assert.deepEqual(fitInside(0, 0, 1280, 800), { width: 1280, height: 800 });
    assert.deepEqual(fitInside(-5, 100, 640, 400), { width: 640, height: 400 });
  });
});