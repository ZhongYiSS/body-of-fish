/**
 * 常驻嗓子的结构测试（11-18 m27977）。
 *
 * 只钉「协议对得上」——daemon 脚本里的关键字、命令格式、音量夹取。
 * **不真起 PowerShell**：`createVoicePlayer()` 在 warm/play 之前不 spawn，所以构造是安全的。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createVoicePlayer, daemonScript, playCommand, silentWav } from './voice-player.ts';

test('daemon 脚本：起播/播完/失败/淡出都要回报', () => {
  const script = daemonScript('C:/tmp/x');
  for (const word of ["'PLAYING|'", "'DONE|'", "'FAILED|'", 'STOP', 'QUIT', '$mp.Volume', 'Add-Type -AssemblyName PresentationCore']) {
    assert.ok(script.includes(word), `脚本里该有 ${word}`);
  }
  // 淡出必须是分步降音量，不是直接 Stop
  assert.match(script, /\$k = 10; \$k -ge 0; \$k--/u);
  // 【11-20 m34789】握手：起来先写 READY，宿主靠它判「真就绪」（原来靠「400ms 后还活着」，假就绪）
  assert.ok(script.includes("'READY'"), '要有 READY 握手');
  // 消息泵：只 Start-Sleep 时 WPF MediaPlayer 实测「静着不响」
  assert.ok(script.includes('System.Windows.Forms.Application]::DoEvents()'), '要有消息泵');
  assert.ok(script.includes('& $pump'), '主循环每轮都要泵一次');
  // 空闲久了先放 150ms 静音把音频端点叫醒（「只有别的软件出声时才发音」的修法）
  assert.ok(script.includes('silent.wav'), '要引用静音预热文件');
  assert.ok(script.includes('$warmGapMs = 30000'), '空闲超过 30 秒才预热');
  // 轮询间隔 20ms：再短白烧 CPU，再长旗标反应慢
  assert.ok(script.includes('Start-Sleep -Milliseconds 20'));
});

test('命令格式：PLAY|路径|音量|token', () => {
  assert.equal(playCommand('C:/a/b.wav', 90, 'tok-1'), 'PLAY|C:/a/b.wav|0.90|tok-1');
  // 音量夹在 0~100，坏值按 100
  assert.equal(playCommand('C:/a/b.wav', 250, 't'), 'PLAY|C:/a/b.wav|1.00|t');
  assert.equal(playCommand('C:/a/b.wav', -5, 't'), 'PLAY|C:/a/b.wav|0.00|t');
  assert.equal(playCommand('C:/a/b.wav', Number.NaN, 't'), 'PLAY|C:/a/b.wav|1.00|t');
});

test('没预热就没就绪；dispose 幂等', () => {
  const player = createVoicePlayer({ dir: 'D:/AI/存档/临时/probe/voice-test' });
  assert.equal(player.ready, false, '没 warm 之前不许说就绪');
  player.dispose();
  player.dispose();
  assert.equal(player.ready, false);
});


test('静音预热用的 wav 是合法头（16kHz 单声道 16bit）', () => {
  const buf = silentWav(100);
  assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(buf.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(buf.readUInt16LE(22), 1, '单声道');
  assert.equal(buf.readUInt32LE(24), 16_000, '16kHz');
  assert.equal(buf.readUInt16LE(34), 16, '16bit');
  // 100ms × 16000 = 1600 采样 × 2 字节
  assert.equal(buf.readUInt32LE(40), 3200);
  assert.equal(buf.length, 44 + 3200);
});

test('起 daemon 前必须清空命令文件（残留的 QUIT 会让它一进循环就自杀）', () => {
  const src = readFileSync(join(import.meta.dirname, 'voice-player.ts'), 'utf8');
  const startAt = src.indexOf('const start = (): void => {');
  assert.ok(startAt > 0, '该有 start()');
  const head = src.slice(startAt, startAt + 1200);
  assert.ok(head.includes("writeCmd('')"), 'start() 里要把命令文件清空');
  // dispose 收摊后不许把 QUIT 留在盘上
  assert.ok(!src.includes("writeFileSync(cmdFile, 'QUIT|x|0')"), 'dispose 不许把 QUIT 写死留在文件里');
});
