/**
 * Windows 自带语音（SAPI，System.Speech）——**完全离线、不要 key、不联网**。
 *
 * 为什么走 PowerShell 而不是原生模块：家里这台机器上 System.Speech 一定在（Windows 自带），
 * 而装原生 TTS 模块要编译/下载。代价是每次合成起一个 powershell 进程（约 0.5~1.5 秒），
 * 对话/陪伴这种"说一句话"的量完全可以接受。
 *
 * 音频不落盘：PowerShell 把 wav 写进 MemoryStream、转 base64 打到 stdout，这边解码。
 * 好处是失败时不会留一堆半截文件；坏处是 stdout 里只要混进一行别的输出就会解析失败——
 * 所以脚本里除了最后那条 base64 **什么都不输出**。
 */
import { execFile } from 'node:child_process';

export interface SapiOptions {
  /** 音色名（如 "Microsoft Huihui Desktop"）；不填用系统默认 */
  voice?: string;
  /** 语速 -10~10（System.Speech 的 Rate），0 是正常 */
  rate?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** PowerShell 的 `-EncodedCommand` 要 UTF-16LE 的 base64：这样中文、引号、换行都不用转义 */
function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * 合成一段话，返回 wav 字节。失败抛 Error（调用方在网关里统一转成 PetGatewayError 的 code）。
 */
export function sapiSpeak(text: string, options: SapiOptions = {}): Promise<Uint8Array> {
  const payload = Buffer.from(text, 'utf8').toString('base64');
  const voice = typeof options.voice === 'string' ? options.voice.trim() : '';
  const rate = Number.isFinite(options.rate) ? Math.max(-10, Math.min(10, Number(options.rate))) : 0;
  const lines = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Speech',
    `$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.Rate = ${rate}`,
  ];
  if (voice !== '') lines.push(`$s.SelectVoice('${voice.replace(/'/g, "''")}')`);
  lines.push(
    '$ms = New-Object System.IO.MemoryStream',
    '$s.SetOutputToWaveStream($ms)',
    '$s.Speak($text)',
    '$s.Dispose()',
    // 只要这一行：前面任何东西都不能写 stdout，否则 base64 解不出来
    '[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))',
  );
  const script = lines.join('\n');

  return new Promise<Uint8Array>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)],
      { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message || '').trim().slice(0, 300);
          reject(new Error(detail === '' ? 'Windows 语音合成失败（powershell 出错）' : `Windows 语音合成失败：${detail}`));
          return;
        }
        const audio = Buffer.from(String(stdout).trim(), 'base64');
        if (audio.length === 0) {
          reject(new Error('Windows 语音回了空音频（这台机器可能没装中文语音）'));
          return;
        }
        resolve(new Uint8Array(audio));
      },
    );
  });
}
