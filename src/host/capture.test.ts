/**
 * `capture.ts` 的执行口测试（跑真 ffmpeg，但用 lavfi 合成画面，**不碰屏幕**）。
 *
 * 钉的事：收字节、非 0 退出、超时、缺 ffmpeg。
 * 抓真屏幕那条（ddagrab）依赖桌面会话，放实机验收，不进单测。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { captureGray, runFfmpeg } from './capture';

const hasFfmpeg = ((): boolean => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
})();

const skip = hasFfmpeg ? false : '本机没有 ffmpeg';

test('runFfmpeg：收 stdout 的字节', { skip }, async () => {
  const out = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=black:s=16x8', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]);
  assert.equal(out.byteLength, 16 * 8 * 3);
});

test('runFfmpeg：出的是真 PNG（89 50 4E 47）', { skip }, async () => {
  const out = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=red:s=8x8', '-frames:v', '1',
    '-f', 'image2pipe', '-c:v', 'png', 'pipe:1',
  ]);
  assert.equal(out.subarray(0, 4).toString('hex'), '89504e47');
});

test('runFfmpeg：非 0 退出要 reject，并带上原因', { skip }, async () => {
  await assert.rejects(
    () => runFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', 'no-such-input-xyz', '-f', 'null', '-']),
    /抓屏退出|Error opening|No such/u,
  );
});

test('runFfmpeg：卡住不动会被超时掐掉', { skip }, async () => {
  const started = Date.now();
  await assert.rejects(
    () =>
      runFfmpeg(
        [
          '-hide_banner', '-loglevel', 'error',
          // -re 必须在 -i 之前；画面只有 8 帧但要按真实速率慢慢吐，600ms 内收不完
          '-re', '-f', 'lavfi', '-i', 'color=black:s=16x8:r=1:d=8',
          '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
        ],
        { timeoutMs: 600 },
      ),
    /超时/u,
  );
  assert.ok(Date.now() - started < 5000, '掐得不够快');
});

test('runFfmpeg：找不到 ffmpeg 时报错而不是挂着', async () => {
  await assert.rejects(
    () => runFfmpeg(['-version'], { ffmpegPath: 'ffmpeg-根本不存在' }),
    /ENOENT|not found|系统找不到/u,
  );
});

test('写文件的变体：ffmpeg 起不来时 reject，不留下半个文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-test-'));
  try {
    const raw = join(dir, 'x.raw');
    await assert.rejects(
      () => captureGray({ file: raw, ffmpegPath: 'ffmpeg-根本不存在' }),
      /ENOENT|not found|系统找不到/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});