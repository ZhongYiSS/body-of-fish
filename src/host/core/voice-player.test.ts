/**
 * 常驻嗓子的结构测试（11-18 m27977）。
 *
 * 只钉「协议对得上」——daemon 脚本里的关键字、命令格式、音量夹取。
 * **不真起 PowerShell**：`createVoicePlayer()` 在 warm/play 之前不 spawn，所以构造是安全的。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createVoicePlayer, daemonScript, playCommand } from './voice-player.ts';

test('daemon 脚本：起播/播完/失败/淡出都要回报', () => {
  const script = daemonScript('C:/tmp/x');
  for (const word of ["'PLAYING|'", "'DONE|'", "'FAILED|'", 'STOP', 'QUIT', '$mp.Volume', 'Add-Type -AssemblyName PresentationCore']) {
    assert.ok(script.includes(word), `脚本里该有 ${word}`);
  }
  // 淡出必须是分步降音量，不是直接 Stop
  assert.match(script, /\$k = 10; \$k -ge 0; \$k--/u);
  // 轮询间隔 30ms：再短白烧 CPU，再长旗标反应慢
  assert.ok(script.includes('Start-Sleep -Milliseconds 30'));
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
