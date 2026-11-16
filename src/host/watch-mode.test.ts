/**
 * 看护模式（watch-mode）纯函数的单测：**不截屏、不起 ffmpeg、不联网**。
 *
 * 要钉死的语义（本鱼 · 11-09 晚按哥哥的拍板加的）：
 *   ① 识图回的一行笔记必须解析出「重要性 + 笔记」，格式歪了也不能崩；
 *   ② 重要性只认 1/2/3，认不出来按 1（= 不值得在 10 秒~3 分钟之间开口）；
 *   ③ 四帧拼图的尺寸必须是 798×462（42 的倍数，别让 token 白花）；
 *   ④ 变化分对「一样的帧」必须是 0，对「全黑 → 全白」必须明显大于切点线 12。
 */
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { boxDownsample,
  CAPTURE_H,
  CAPTURE_W,
  gridRgb,
  parseWatchNote,
  rgbToHsv,
  scorePair,
  scorePairMoving,
  stillStopDecision,
  watchShouldAsk,
  WATCH_FALLBACK_MS,
  WATCH_MIN_GAP_MS,
 } from './watch-mode';

const SCAN_W = 64;
const SCAN_H = 36;

function hsvOf(rgb: number[]): Float32Array {
  const bytes = new Uint8Array(rgb);
  const grid = gridRgb(bytes, 2, 2, new Float32Array(SCAN_W * SCAN_H * 3));
  return rgbToHsv(grid, new Float32Array(SCAN_W * SCAN_H * 3));
}

describe('parseWatchNote：笔记解析', () => {
  test('标准格式：重要性|笔记', () => {
    assert.deepEqual(parseWatchNote('2|窗口切到了剪辑软件'), { imp: 2, note: '窗口切到了剪辑软件' });
  });

  test('全角竖线和冒号都认', () => {
    assert.deepEqual(parseWatchNote('3｜在渲染，进度条在动'), { imp: 3, note: '在渲染，进度条在动' });
    assert.deepEqual(parseWatchNote('1：光标动了一下'), { imp: 1, note: '光标动了一下' });
  });

  test('多行：只看第一行有内容的那行', () => {
    assert.deepEqual(parseWatchNote('\n\n2|打开了浏览器\n后面这行不算'), { imp: 2, note: '打开了浏览器' });
  });

  test('格式歪了：整行当笔记，重要性按 1', () => {
    const got = parseWatchNote('好像换了窗口');
    assert.equal(got.imp, 1);
    assert.equal(got.note, '好像换了窗口');
  });

  test('重要性写了 4 也不认（只准 1/2/3），但前面的数字要剥掉', () => {
    const got = parseWatchNote('4|不该出现的重要度');
    assert.equal(got.imp, 1);
    assert.equal(got.note, '不该出现的重要度');
  });

  test('空输入：空笔记、重要性 1', () => {
    assert.deepEqual(parseWatchNote(''), { imp: 1, note: '' });
    assert.deepEqual(parseWatchNote('   \n  '), { imp: 1, note: '' });
  });

  test('太长就截到 40 字', () => {
    const got = parseWatchNote(`2|${'字'.repeat(80)}`);
    assert.equal(got.note.length, 40);
  });

  test('带「笔记：」前缀也剥掉', () => {
    assert.equal(parseWatchNote('笔记：他在写代码').note, '他在写代码');
  });
});

describe('watchShouldAsk：什么时候开口', () => {
  test('不到 10 秒一律闭嘴（哪怕笔记很重要）', () => {
    assert.equal(watchShouldAsk(0, true), 'skip');
    assert.equal(watchShouldAsk(WATCH_MIN_GAP_MS - 1, true), 'skip');
  });

  test('10 秒~3 分钟：只有重要性 ≥2 的笔记才开口', () => {
    assert.equal(watchShouldAsk(WATCH_MIN_GAP_MS, true), 'ask');
    assert.equal(watchShouldAsk(60_000, false), 'skip');
  });

  test('超过 3 分钟：必说（兜底）', () => {
    assert.equal(watchShouldAsk(WATCH_FALLBACK_MS, false), 'force');
    assert.equal(watchShouldAsk(10 * 60_000, false), 'force');
  });

  test('同样的画面变化分是 0', () => {
    const a = hsvOf([10, 20, 30, 10, 20, 30, 10, 20, 30, 10, 20, 30]);
    assert.equal(scorePair(a, a), 0);
  });

  test('全黑 → 全白 远大于切点线 12', () => {
    const black = hsvOf([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const white = hsvOf([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    assert.ok(scorePair(black, white) > 12, `实际 ${scorePair(black, white)}`);
  });
});

/** 造一张 64×36 的 HSV 网格：色相随 x 线性走，饱和/亮度恒定；dx 用来整体平移 */
function patternGrid(dx = 0): Float32Array {
  const out = new Float32Array(SCAN_W * SCAN_H * 3);
  for (let gy = 0; gy < SCAN_H; gy += 1) {
    for (let gx = 0; gx < SCAN_W; gx += 1) {
      const i = (gy * SCAN_W + gx) * 3;
      out[i] = ((gx + dx) % 8) * 30;
      out[i + 1] = 200;
      out[i + 2] = 150;
    }
  }
  return out;
}

describe('运动补偿：整屏平移不算「画面换了」', () => {
  test('同样的画面：0', () => {
    const a = patternGrid(0);
    assert.equal(scorePairMoving(a, a), 0);
  });

  test('整屏平移 2 格：只有右边缘两列没处对，面积分远低于切点线', () => {
    const a = patternGrid(0);
    const b = patternGrid(2);
    const raw = scorePair(a, b);
    const mc = scorePairMoving(a, b);
    assert.ok(raw > 12, `逐格差 ${raw}`);
    // 2 列 × 36 行 = 72/2304 → 约 8 分；切点线是 30，所以不算「换了」
    assert.ok(mc <= 12, `运动补偿后 ${mc}`);
    assert.ok(mc < 30, `补偿后 ${mc} 必须低于切点线`);
  });

  test('整块换色：补偿不掉（该认的切点还要认）', () => {
    const a = new Float32Array(SCAN_W * SCAN_H * 3);
    for (let i = 0; i < a.length; i += 3) { a[i] = 10; a[i + 1] = 200; a[i + 2] = 160; }
    const b = new Float32Array(a.length);
    for (let i = 0; i < b.length; i += 3) { b[i] = 200; b[i + 1] = 200; b[i + 2] = 160; }
    const mc = scorePairMoving(a, b);
    assert.equal(mc, 255, `整屏都变了应是满分，实得 ${mc}`);
  });

  /**
   * 已知代价（照 see-now 的 mcStats 同口径，不是 bug）：
   * 一块贴近同色大背景的小改动，会被运动补偿当成「内容平移了」吸收掉 —— 因为它原先的颜色
   * 在旁边还找得到。真实屏幕上弹窗大多压在异色背景上，吸收得没这么彻底；真被吸收掉的那些，
   * 靠积分（acc）和兜底（floorSec）补一张回来。想彻底补齐得再上一套背景模型（see-now 的
   * bgStats），那是另一档复杂度，先不做。
   */
  test('贴在同色背景上的小改动会被吸收（已知代价，靠积分/兜底兜住）', () => {
    const a = new Float32Array(SCAN_W * SCAN_H * 3);
    for (let i = 0; i < a.length; i += 3) { a[i] = 10; a[i + 1] = 200; a[i + 2] = 160; }
    const b = Float32Array.from(a);
    const cells = SCAN_W * SCAN_H;
    for (let c = Math.floor(cells * 0.9); c < cells; c += 1) {
      b[c * 3] = 210; b[c * 3 + 1] = 235; b[c * 3 + 2] = 255;
    }
    const mc = scorePairMoving(a, b);
    assert.ok(mc < 30, `不该被当成切点，实得 ${mc}`);
    assert.ok(mc > 0, `但也不能是 0（确实变了 10%），实得 ${mc}`);
  });

  test('没有可吸收的邻域时（格子花色各不相同），10% 的面积就是 25 分左右', () => {
    const cells = SCAN_W * SCAN_H;
    const a = new Float32Array(cells * 3);
    for (let c = 0; c < cells; c += 1) {
      a[c * 3] = (c % 7) * 30 + 8;
      a[c * 3 + 1] = ((c * 3) % 11) * 20 + 10;
      a[c * 3 + 2] = ((c * 5) % 13) * 15 + 12;
    }
    const b = Float32Array.from(a);
    for (let c = Math.floor(cells * 0.9); c < cells; c += 1) {
      b[c * 3] = 250; b[c * 3 + 1] = 250; b[c * 3 + 2] = 250;
    }
    const mc = scorePairMoving(a, b);
    assert.ok(mc > 18 && mc < 32, `10% 面积 ≈ 25 分，实得 ${mc}`);
  });
});

describe('stillStopDecision：画面不动 ≠ 人走了', () => {
  const T = 1_000_000;

  test('还没开始计时（lastChangeAt=0）：不动', () => {
    assert.equal(stillStopDecision(0, 900, T), 'wait');
  });

  test('没到时间：继续看', () => {
    assert.equal(stillStopDecision(T - 899_000, 900, T), 'wait');
  });

  test('到时间了、没人找过她：收工', () => {
    assert.equal(stillStopDecision(T - 900_000, 900, T), 'stop');
    assert.equal(stillStopDecision(T - 900_000, 900, T, () => true), 'stop');
  });

  test('到时间了、刚有人跟她说过话：延长一轮（不收工）', () => {
    assert.equal(stillStopDecision(T - 900_000, 900, T, () => false), 'extend');
  });
});

describe('永远整屏抓：窗口检测整条删掉（11-10 01:46 m17821）', () => {
  test('源码守卫：不许再出现前台窗口轮询 / 区域裁剪', () => {
    const src = readFileSync(new URL('./watch-mode.ts', import.meta.url), 'utf8');
    assert.ok(!src.includes('FOREGROUND_SCRIPT'), '前台窗口轮询要删干净（DPI 缩放导致只截到窗口左上角）');
    assert.ok(!src.includes('parseForegroundLine'), '窗口矩形解析要删干净');
    assert.ok(!src.includes('-offset_x'), 'gdigrab 不许再按区域裁（物理像素 vs 逻辑坐标对不上）');
    assert.ok(!src.includes('followWindow'), '跟窗口开关一并删掉');
    assert.ok(src.includes('距上次出图='), '每 60 秒要有状态行，饿死时能一眼看出来');
    assert.ok(src.includes('整屏'), '启动日志要写清是整屏');
  });
});

// 【汐儿 · 11-16 m21691】回归：裁剪之后缩图必须按「裁出来的宽高」走。
// 以前 boxDownsample 写死 1536×960 的行宽，裁剪后源是 w×h，于是横条纹 + 下半截全黑——
// 哥哥看到的就是这个「花屏」。这里造一张裁好的 768×960 纯蓝帧，缩到 504×315，蓝必须还是蓝。
test('裁剪之后缩图不能错位（花屏回归）', () => {
  const W = 768;
  const H = 960;
  const cropped = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i += 1) {
    cropped[i * 3] = 0;
    cropped[i * 3 + 1] = 0;
    cropped[i * 3 + 2] = 255;
  }
  const out = boxDownsample(cropped, W, H, 504, 315);
  assert.equal(out.length, 504 * 315 * 3);
  for (const [x, y] of [[0, 0], [100, 50], [251, 157], [503, 314]] as const) {
    const i = (y * 504 + x) * 3;
    assert.deepEqual([out[i], out[i + 1], out[i + 2]], [0, 0, 255], `(${x},${y}) 应该是蓝`);
  }
  // 反面：按老写法（行宽当 1536）算，第一行之后的点就该错——这里只锁住「按传入宽高走」，
  // 所以再验一个非等比的情况：源 700×400 缩到 350×200，四角都必须是蓝。
  const odd = Buffer.alloc(700 * 400 * 3);
  for (let i = 0; i < 700 * 400; i += 1) odd[i * 3 + 2] = 255;
  const out2 = boxDownsample(odd, 700, 400, 350, 200);
  for (const [x, y] of [[0, 0], [349, 0], [0, 199], [349, 199]] as const) {
    const i = (y * 350 + x) * 3;
    assert.deepEqual([out2[i], out2[i + 1], out2[i + 2]], [0, 0, 255], `非等比 (${x},${y}) 应该是蓝`);
  }
});
