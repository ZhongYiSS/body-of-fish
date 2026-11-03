/**
 * 语音字节流 → 时长（毫秒）。**气泡时长、朗读节奏都挂在这上面**，算错了气泡就会
 * 在半句话时收起来（见 src/host/index.ts 里 sayWithVoice / /say-loud 的注释）。
 *
 * 支持两种：RIFF/WAV（系统语音 SAPI、GPT-SoVITS）与 MP3（Edge、OpenAI 兼容接口）。
 *
 * 历史：改造前只认 WAV，MP3 一律落到 4000ms 兜底 —— 也就是「Edge 念 16 秒，
 * 气泡 6 秒就消失」。这里按帧头真算：优先读 Xing/Info 里的帧数（VBR 也准），
 * 没有就逐帧数（最多扫 MAX_FRAMES 帧），再不行按 CBR 码率折算。
 */

/** 认不出来时的兜底（与改造前一致，避免调用方再写一遍这个数）。 */
export const AUDIO_DURATION_FALLBACK_MS = 4000;

const MAX_FRAMES = 100_000;

const tag = (a: Uint8Array, o: number): string =>
  String.fromCharCode(a[o] ?? 0, a[o + 1] ?? 0, a[o + 2] ?? 0, a[o + 3] ?? 0);

function wavDurationMs(audio: Uint8Array): number {
  if (audio.byteLength < 44 || tag(audio, 0) !== 'RIFF' || tag(audio, 8) !== 'WAVE') return 0;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  let byteRate = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= audio.byteLength) {
    const id = tag(audio, offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') byteRate = view.getUint32(offset + 16, true);
    if (id === 'data') {
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2); // chunk 按偶数字节对齐
  }
  if (byteRate <= 0 || dataSize <= 0) return 0;
  return Math.round((dataSize / byteRate) * 1000);
}

/** MPEG 版本：1 = MPEG1、2 = MPEG2、25 = MPEG2.5 */
type MpegVersion = 1 | 2 | 25;

/** 码率表（kbps），按 「版本 → 层」 分组，下标 = 帧头 bitrate index。0 与 15 是保留值。 */
const BITRATES: Record<string, number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '25-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '25-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '25-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const SAMPLE_RATES: Record<MpegVersion, number[]> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  25: [11025, 12000, 8000],
};

interface FrameHeader {
  version: MpegVersion;
  layer: 1 | 2 | 3;
  bitrate: number; // kbps
  sampleRate: number;
  padding: number;
  frameLength: number;
  samplesPerFrame: number;
}

function parseFrameHeader(a: Uint8Array, o: number): FrameHeader | null {
  if (o + 4 > a.byteLength) return null;
  if (a[o] !== 0xff || (a[o + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (a[o + 1] >> 3) & 0x03;
  const layerBits = (a[o + 1] >> 1) & 0x03;
  const bitrateIndex = (a[o + 2] >> 4) & 0x0f;
  const sampleRateIndex = (a[o + 2] >> 2) & 0x03;
  const padding = (a[o + 2] >> 1) & 0x01;
  if (versionBits === 1 || layerBits === 0) return null; // 保留值
  if (bitrateIndex === 0 || bitrateIndex === 15) return null;
  if (sampleRateIndex === 3) return null;
  const version: MpegVersion = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const layer: 1 | 2 | 3 = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
  const bitrate = BITRATES[`${version}-${layer}`]?.[bitrateIndex] ?? 0;
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex];
  if (bitrate <= 0 || !sampleRate) return null;
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
  const frameLength =
    layer === 1
      ? Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4
      : Math.floor((samplesPerFrame / 8) * ((bitrate * 1000) / sampleRate)) + padding;
  if (frameLength <= 4) return null;
  return { version, layer, bitrate, sampleRate, padding, frameLength, samplesPerFrame };
}

/** 跳过 ID3v2（含可选 footer）与开头的空字节，返回第一个候选帧的偏移。 */
function firstFrameOffset(a: Uint8Array): number {
  let offset = 0;
  if (a.byteLength > 10 && tag(a, 0) === 'ID3') {
    const size =
      ((a[6] & 0x7f) << 21) | ((a[7] & 0x7f) << 14) | ((a[8] & 0x7f) << 7) | (a[9] & 0x7f);
    const footer = (a[5] & 0x10) !== 0 ? 10 : 0;
    offset = 10 + size + footer;
  }
  for (let i = offset; i + 4 <= a.byteLength; i += 1) {
    if (parseFrameHeader(a, i) !== null) return i;
  }
  return -1;
}

/** Xing/Info 头里的总帧数（存在则返回，否则 0）。 */
function xingFrameCount(a: Uint8Array, frameOffset: number, header: FrameHeader): number {
  // side info 长度：MPEG1 单声道 17 / 双声道 32；MPEG2/2.5 单声道 9 / 双声道 17
  const mono = ((a[frameOffset + 3] ?? 0) >> 6) === 3;
  const sideInfo =
    header.version === 1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const xingAt = frameOffset + 4 + sideInfo;
  if (xingAt + 8 > a.byteLength) return 0;
  const id = tag(a, xingAt);
  if (id !== 'Xing' && id !== 'Info') return 0;
  const flags = new DataView(a.buffer, a.byteOffset + xingAt + 4, 4).getUint32(0, false);
  if ((flags & 0x0001) === 0) return 0;
  return new DataView(a.buffer, a.byteOffset + xingAt + 8, 4).getUint32(0, false);
}

function mp3DurationMs(audio: Uint8Array): number {
  const start = firstFrameOffset(audio);
  if (start < 0) return 0;
  const first = parseFrameHeader(audio, start);
  if (first === null) return 0;
  const frames = xingFrameCount(audio, start, first);
  if (frames > 0) {
    return Math.round((frames * first.samplesPerFrame * 1000) / first.sampleRate);
  }
  // 没有 Xing：逐帧往后数（VBR 也准；同步字断了就停）
  let offset = start;
  let counted = 0;
  while (counted < MAX_FRAMES && offset + 4 <= audio.byteLength) {
    const header = parseFrameHeader(audio, offset);
    if (header === null) break;
    counted += 1;
    offset += header.frameLength;
  }
  if (counted > 0) {
    return Math.round((counted * first.samplesPerFrame * 1000) / first.sampleRate);
  }
  // 最后一招：按第一帧的 CBR 码率折算整段字节数
  const bytes = audio.byteLength - start;
  return Math.round((bytes * 8 * 1000) / (first.bitrate * 1000));
}

/**
 * 音频字节 → 毫秒。WAV / MP3 都真算；两种都认不出来时返回
 * `AUDIO_DURATION_FALLBACK_MS`（调用方不必再兜底，但 `Math.max(3000, ...)` 仍由调用方保留）。
 */
export function audioDurationMs(audio: Uint8Array): number {
  if (audio.byteLength === 0) return AUDIO_DURATION_FALLBACK_MS;
  const wav = wavDurationMs(audio);
  if (wav > 0) return wav;
  const mp3 = mp3DurationMs(audio);
  if (mp3 > 0) return mp3;
  return AUDIO_DURATION_FALLBACK_MS;
}
