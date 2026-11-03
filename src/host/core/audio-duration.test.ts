/**
 * 音频时长解析的钉子：气泡时长全靠它，算错了就「话没念完泡先没」。
 * 三条都要钉住：wav 真算、mp3 真算（CBR 逐帧 / Xing 帧数）、认不出才兜底 4 秒。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { audioDurationMs, AUDIO_DURATION_FALLBACK_MS } from './audio-duration.ts';

/** 拼一段最小可解析的 wav：1 秒、16kHz 16bit 单声道。 */
function wav1s(): Uint8Array {
  const byteRate = 16000 * 2 * 1;
  const dataSize = byteRate; // 恰好 1 秒
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return new Uint8Array(buf);
}

/** MPEG1 Layer3、128kbps、44.1kHz 的一帧填充（不含真实音频数据，只要帧头自洽）。 */
function mp3Frame(padding = 0): Buffer {
  const frameLength = Math.floor((1152 / 8) * ((128 * 1000) / 44100)) + padding; // 417 / 418
  const buf = Buffer.alloc(frameLength);
  buf[0] = 0xff;
  buf[1] = 0xfb; // MPEG1 / Layer3 / 无 CRC
  buf[2] = 0x90 | (padding << 1); // bitrate index 9 = 128kbps, samplerate index 0 = 44100
  buf[3] = 0xc0; // 单声道（channel mode = 11）
  return buf;
}

/** 10 帧 CBR（无 Xing）。 */
function mp3Cbr(frames: number): Uint8Array {
  const parts: Buffer[] = [];
  for (let i = 0; i < frames; i += 1) parts.push(mp3Frame(i % 2));
  return new Uint8Array(Buffer.concat(parts));
}

/** 带 Xing 头、只写总帧数的最短 mp3。 */
function mp3WithXing(frames: number): Uint8Array {
  const buf = mp3Frame(0);
  const sideInfo = 17; // MPEG1 单声道
  const at = 4 + sideInfo;
  buf.write('Xing', at, 'ascii');
  buf.writeUInt32BE(0x0001, at + 4); // 只带 frames 字段
  buf.writeUInt32BE(frames, at + 8);
  return new Uint8Array(buf);
}

describe('audioDurationMs', () => {
  test('wav 按 byteRate 真算', () => {
    assert.equal(audioDurationMs(wav1s()), 1000);
  });

  test('mp3 CBR 逐帧数（10 帧 1152 采样 @44.1k ≈ 261ms）', () => {
    const ms = audioDurationMs(mp3Cbr(10));
    assert.equal(ms, Math.round((10 * 1152 * 1000) / 44100));
    assert.ok(ms > 260 && ms < 262);
  });

  test('mp3 优先信 Xing 的总帧数', () => {
    const ms = audioDurationMs(mp3WithXing(100));
    assert.equal(ms, Math.round((100 * 1152 * 1000) / 44100));
  });

  test('认不出来的字节流兜底 4 秒，不抛异常', () => {
    assert.equal(audioDurationMs(new Uint8Array(0)), AUDIO_DURATION_FALLBACK_MS);
    assert.equal(audioDurationMs(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), AUDIO_DURATION_FALLBACK_MS);
  });
});
