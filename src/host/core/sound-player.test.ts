/**
 * Windows 自带播放器兜底的单测（本鱼 · 11-15，外部用户 bug：机器上没 ffplay 就没声音）
 *
 * 钉死的语义：
 *   ① wav 走 `System.Media.SoundPlayer`（同步播完），不要去装 WPF；
 *   ② 其他格式（Edge / 兼容接口回的 mp3）走 WPF `MediaPlayer`，等自然时长、按它播完；
 *   ③ 路径里有单引号要转义成两个单引号，不许把脚本拼坏；
 *   ④ 脚本走 `-EncodedCommand`（UTF-16LE base64）+ `-STA`，中文路径不会乱码。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { playbackWatchdogMs, psQuote, stopFlagOf, systemPlayerCommand, systemPlayerScript } from './sound-player.ts';

describe('playbackWatchdogMs', () => {
  test('按 1.4 倍时长 + 6 秒，最低 12 秒、最高 5 分钟', () => {
    // 11-18 m27977：旧口径「时长 + 3 秒、最低 6 秒」把长句误杀了；23:40 又按哥哥「别太长」收到 12 秒底
    assert.equal(playbackWatchdogMs(1000), 12000);
    assert.equal(playbackWatchdogMs(12000), 22800);
    assert.equal(playbackWatchdogMs(600000), 300000);
  });

  test('时长拿不到（0 / NaN / 负数）给 40 秒兜底，绝不无限等', () => {
    assert.equal(playbackWatchdogMs(0), 12000);
    assert.equal(playbackWatchdogMs(Number.NaN), 12000);
    assert.equal(playbackWatchdogMs(-5), 12000);
  });
});

describe('systemPlayerScript', () => {
  test('wav 用 SoundPlayer', () => {
    const script = systemPlayerScript('C:\\tmp\\a.wav', 'audio/wav');
    assert.match(script, /System\.Media\.SoundPlayer 'C:\\tmp\\a\.wav'/u);
    assert.match(script, /PlaySync\(\)/u);
    assert.doesNotMatch(script, /PresentationCore/u);
  });

  test('扩展名兜底：mime 认不出来但文件是 .wav 也走 SoundPlayer', () => {
    const script = systemPlayerScript('C:/tmp/b.WAV', 'application/octet-stream');
    assert.match(script, /SoundPlayer/u);
  });

  test('mp3 用 WPF MediaPlayer，按自然时长播完', () => {
    const script = systemPlayerScript('C:\\tmp\\c.mp3', 'audio/mpeg');
    assert.match(script, /Add-Type -AssemblyName PresentationCore/u);
    assert.match(script, /System\.Windows\.Media\.MediaPlayer/u);
    assert.match(script, /NaturalDuration\.HasTimeSpan/u);
    assert.match(script, /\$mp\.Play\(\)/u);
    assert.match(script, /\$mp\.Stop\(\)/u);
    assert.doesNotMatch(script, /SoundPlayer/u);
  });

  test('拿不到时长时按 4 秒兜底', () => {
    assert.match(systemPlayerScript('C:\\tmp\\d.mp3', 'audio/mpeg'), /else \{ 4000 \}/u);
  });
});

describe('psQuote', () => {
  test('普通路径包一层单引号', () => {
    assert.equal(psQuote('C:\\a\\b.wav'), "'C:\\a\\b.wav'");
  });

  test('路径里的单引号写成两个', () => {
    assert.equal(psQuote("C:\\it's\\b.wav"), "'C:\\it''s\\b.wav'");
  });
});

describe('systemPlayerCommand', () => {
  test('powershell + STA + EncodedCommand(UTF-16LE)', () => {
    const command = systemPlayerCommand('C:\\中文 目录\\a.wav', 'audio/wav');
    assert.equal(command.command, 'powershell.exe');
    assert.deepEqual(command.args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']);
    const encoded = command.args[4] ?? '';
    assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), systemPlayerScript('C:\\中文 目录\\a.wav', 'audio/wav'));
    assert.match(command.args.slice(0, 4).join(' '), /-STA/u);
  });
});

describe('淡出：停旗标 + MediaPlayer', () => {
  test('停旗标就是「音频路径 + .stop」', () => {
    assert.equal(stopFlagOf('D:/x/say-1.wav'), 'D:/x/say-1.wav.stop');
  });

  test('给了停旗标就一定是 MediaPlayer（SoundPlayer 没法改音量）', () => {
    const script = systemPlayerScript('D:/x/say-1.wav', 'audio/wav', 100, 'D:/x/say-1.wav.stop');
    assert.ok(script.includes('System.Windows.Media.MediaPlayer'));
    assert.ok(!script.includes('System.Media.SoundPlayer'));
    // 一边播一边看旗标，看到就把音量分 10 步降到 0
    assert.ok(script.includes('Test-Path -LiteralPath'));
    assert.ok(script.includes('$fade = $true'));
    assert.ok(script.includes('for ($k = 10; $k -ge 0; $k--)'));
  });

  test('没有停旗标时，音量 100 的 wav 还走 SoundPlayer（那条最稳）', () => {
    const script = systemPlayerScript('D:/x/say-1.wav', 'audio/wav', 100);
    assert.ok(script.includes('System.Media.SoundPlayer'));
  });
});
