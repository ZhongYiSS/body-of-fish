import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CROP_MIN_SIDE, CROP_PAD, cropFrame, normalizeRect } from './screen-crop.ts';
import {
  WATCH_MODES,
  isPickableWindow,
  normalizeWatchMode,
  pageName,
  pickWindow,
  targetLine,
  watchModeWord,
  type WindowInfo,
} from './screen-target.ts';

const SCREEN = { x: 0, y: 0, w: 2560, h: 1600 };

function win(over: Partial<WindowInfo> = {}): WindowInfo {
  return {
    hwnd: 100,
    title: '记事本',
    exe: 'notepad',
    rect: { x: 200, y: 150, w: 1000, h: 700 },
    ...over,
  };
}

// ---------------------------------------------------------------- 模式

test('模式：三个值，老配置 game/video 当自动', () => {
  assert.deepEqual([...WATCH_MODES], ['full', 'auto', 'window']);
  assert.equal(normalizeWatchMode('full'), 'full');
  assert.equal(normalizeWatchMode(' Window '), 'window');
  assert.equal(normalizeWatchMode('auto'), 'auto');
  // 老配置
  assert.equal(normalizeWatchMode('game'), 'auto');
  assert.equal(normalizeWatchMode('video'), 'auto');
  assert.equal(normalizeWatchMode(undefined), 'auto');
  assert.equal(normalizeWatchMode('乱写'), 'auto');
  assert.equal(watchModeWord('full'), '全屏');
  assert.equal(watchModeWord('window'), '窗口');
  assert.equal(watchModeWord('auto'), '自动');
});

// ---------------------------------------------------------------- 挑窗口

test('挑窗口：自己、桌面、看图窗口、太小的一律不选', () => {
  assert.equal(isPickableWindow(win()), true);
  assert.equal(isPickableWindow(win({ exe: 'BodyOfFish' })), false);
  assert.equal(isPickableWindow(win({ exe: 'dsh-pet.exe' })), false);
  assert.equal(isPickableWindow(win({ title: 'Program Manager' })), false);
  assert.equal(isPickableWindow(win({ title: '任务栏' })), false);
  assert.equal(isPickableWindow(win({ title: '2026-11-16T01-02-03-456Z_cut.png' })), false);
  assert.equal(isPickableWindow(win({ title: '   ' })), false);
  assert.equal(isPickableWindow(win({ rect: { x: 0, y: 0, w: 120, h: 100 } })), false);
});

test('挑窗口：优先手动指定的 hwnd，指定不到就退回第一个可用的', () => {
  const self = win({ hwnd: 1, exe: 'bodyoffish', title: 'dsh-pet 桌宠（桌面模式）' });
  const note = win({ hwnd: 2, title: '未命名 - 记事本' });
  const edge = win({ hwnd: 3, title: 'B站 - 个人 - Microsoft Edge', exe: 'msedge' });
  assert.equal(pickWindow([self, note, edge])?.hwnd, 2);
  assert.equal(pickWindow([self, note, edge], 3)?.hwnd, 3);
  assert.equal(pickWindow([self, note, edge], 999)?.hwnd, 2);
  assert.equal(pickWindow([self])?.hwnd, undefined);
});

test('页面标题：剥浏览器与站点尾巴、去零宽空格', () => {
  assert.equal(pageName('【官方 MV】某某 _哔哩哔哩_bilibili - 个人 - Microsoft​ Edge'), '【官方 MV】某某');
  assert.equal(pageName('泰拉瑞亚 - 维基百科 - Microsoft Edge'), '泰拉瑞亚 - 维基百科');
  assert.equal(pageName('标题 和另外 2 个页面'), '标题');
  assert.equal(pageName('   '), '');
});

test('给提示词的一句话：全屏 / 只看某窗口', () => {
  assert.equal(targetLine(undefined, 'full'), '（整屏）');
  assert.equal(targetLine(win({ title: '未命名 - 记事本' }), 'full'), '整屏，最前面是：未命名 - 记事本');
  assert.equal(targetLine(win({ title: '未命名 - 记事本' }), 'window'), '只看这个窗口：未命名 - 记事本');
  assert.equal(
    targetLine(win({ title: '某视频 _哔哩哔哩_bilibili' }), 'window', 'bilibili.com'),
    '只看这个窗口：某视频（bilibili.com）',
  );
});

// ---------------------------------------------------------------- 裁剪

test('裁剪矩形：外扩边距、夹进屏幕', () => {
  const box = normalizeRect({ x: 100, y: 100, w: 800, h: 600 }, SCREEN);
  assert.deepEqual(box, { x: 100 - CROP_PAD, y: 100 - CROP_PAD, w: 800 + CROP_PAD * 2, h: 600 + CROP_PAD * 2 });
  // 贴边：左边不出界
  const edge = normalizeRect({ x: 0, y: 0, w: 800, h: 600 }, SCREEN);
  assert.deepEqual(edge, { x: 0, y: 0, w: 800 + CROP_PAD, h: 600 + CROP_PAD });
  // 右下角超出屏幕：夹回来
  const over = normalizeRect({ x: 2200, y: 1300, w: 600, h: 500 }, SCREEN);
  assert.deepEqual(over, { x: 2200 - CROP_PAD, y: 1300 - CROP_PAD, w: 360 + CROP_PAD, h: 300 + CROP_PAD });
  // 露在屏幕外的部分太多（夹完只剩一小条）→ 不可信
  assert.equal(normalizeRect({ x: 2500, y: 1500, w: 400, h: 400 }, SCREEN), null);
});

test('裁剪矩形：太小、非法、几乎占满全屏都不信', () => {
  assert.equal(normalizeRect({ x: 10, y: 10, w: CROP_MIN_SIDE - 20, h: 400 }, SCREEN), null);
  assert.equal(normalizeRect({ x: 10, y: 10, w: 0, h: 400 }, SCREEN), null);
  assert.equal(normalizeRect({ x: 10, y: 10, w: -100, h: 400 }, SCREEN), null);
  assert.equal(normalizeRect({ x: Number.NaN, y: 10, w: 800, h: 600 }, SCREEN), null);
  // 屏幕尺寸拿不到
  assert.equal(normalizeRect({ x: 10, y: 10, w: 800, h: 600 }, { x: 0, y: 0, w: 0, h: 0 }), null);
});

test('裁剪帧：按缩放比换算，像素内容对得上', () => {
  const frameW = 1280;
  const frameH = 800;
  // 造一帧：每 8 像素一条竖纹，方便核对裁剪位置
  const frame = Buffer.alloc(frameW * frameH * 3);
  for (let y = 0; y < frameH; y += 1) {
    for (let x = 0; x < frameW; x += 1) {
      const v = x % 256;
      const at = (y * frameW + x) * 3;
      frame[at] = v;
      frame[at + 1] = y % 256;
      frame[at + 2] = 0;
    }
  }
  // 屏幕 2560×1600 → 帧 1280×800，正好一半
  const out = cropFrame(frame, frameW, frameH, SCREEN, { x: 640, y: 400, w: 640, h: 400 });
  assert.notEqual(out, null);
  const got = out!.data;
  assert.equal(out!.w, 328);
  assert.equal(out!.h, 208);
  // 640-8 = 632 → 帧坐标 316；640+640+8=1288 → 644
  assert.equal(got.length, (644 - 316) * (404 - 196) * 3);
  assert.equal(got[0], 316 % 256);
  assert.equal(got[1], 196);
});

test('裁剪帧：矩形不可信时回 null（调用方退回整屏）', () => {
  const frame = Buffer.alloc(1280 * 800 * 3);
  assert.equal(cropFrame(frame, 1280, 800, SCREEN, { x: 0, y: 0, w: 10, h: 10 }), null);
  assert.equal(cropFrame(frame, 0, 0, SCREEN, { x: 100, y: 100, w: 800, h: 600 }), null);
});
