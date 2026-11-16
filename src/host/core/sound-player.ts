/**
 * Windows 自带播放器兜底（【本鱼 · 11-15】外部用户报「音频生成了但没播出来」）。
 *
 * 原来只有 ffplay 一条路（环境变量 → 家里 RVC 那套 → PATH）。别人机器上没装 ffmpeg，
 * `spawn('ffplay')` 直接 ENOENT，合成好了也全丢。这里给不装 ffmpeg 的人兜一层系统能力：
 *   - wav（系统语音回的）：`System.Media.SoundPlayer` 同步播完；
 *   - mp3（Edge / 兼容接口回的）：WPF 的 `MediaPlayer`，按自然时长播完再收。
 * 都要 `-STA`（WPF 要单线程单元），脚本走 `-EncodedCommand`（UTF-16LE base64）避开中文与引号。
 */

export interface PlayerCommand {
  readonly command: string;
  readonly args: string[];
}

/** 一条路径怎么塞进 PowerShell 单引号字符串：单引号要写两遍。 */
export function psQuote(text: string): string {
  return "'" + text.replace(/'/g, "''") + "'";
}

/** 把 0~100 的音量折成 MediaPlayer 要的 0~1 */
export function playerVolume(volume: number): string {
  const safe = Number.isFinite(volume) ? volume : 100;
  return (Math.min(100, Math.max(0, safe)) / 100).toFixed(2);
}

/**
 * 播放这段文件要跑的 Powershell 脚本（导出来是为了能测）。
 *
 * 【汐儿 · 11-15】加了音量：`SoundPlayer` 没有音量参数，所以**音量不是 100 时 wav 也走 MediaPlayer**；
 * 100 时保持原来的 `SoundPlayer`（那条路最稳，别为了统一把好的换掉）。
 */
export function systemPlayerScript(file: string, mime: string, volume = 100): string {
  const quoted = psQuote(file);
  const loud = playerVolume(volume) === '1.00';
  if (loud && (mime === 'audio/wav' || /\.wav$/i.test(file))) {
    return [
      '$ErrorActionPreference = "Stop"',
      // 别把「准备模块」的进度条当 CLIXML 往 stderr 灌（会白占 voice-play.log）
      '$ProgressPreference = "SilentlyContinue"',
      `$p = New-Object System.Media.SoundPlayer ${quoted}`,
      '$p.PlaySync()',
    ].join('\n');
  }
  return [
    '$ErrorActionPreference = "Stop"',
    '$ProgressPreference = "SilentlyContinue"',
    'Add-Type -AssemblyName PresentationCore',
    '$mp = New-Object System.Windows.Media.MediaPlayer',
    `$mp.Open([uri]${quoted})`,
    `$mp.Volume = ${playerVolume(volume)}`,
    // Open 是异步的：等 NaturalDuration 有值（最多 6 秒），没等到就按 4 秒兜底
    'for ($i = 0; $i -lt 120 -and -not $mp.NaturalDuration.HasTimeSpan; $i++) { Start-Sleep -Milliseconds 50 }',
    '$mp.Play()',
    '$ms = if ($mp.NaturalDuration.HasTimeSpan) { [int]$mp.NaturalDuration.TimeSpan.TotalMilliseconds } else { 4000 }',
    'Start-Sleep -Milliseconds $ms',
    '$mp.Stop()',
    '$mp.Close()',
  ].join('\n');
}

/**
 * 播放看门狗（【本鱼 · 11-15】哥哥报「用着用着没声音、陪伴开口也少了」）。
 *
 * 根因：`playAudio` 只等 `close`，播放器（ffplay / powershell）一旦卡住就永远不 resolve，
 * 那把「嗓子」被永久占着：碎碎念被当 busy 丢掉、对话排在后面等不到 —— 表现就是先没声音、再没人说话。
 * 这里按音频时长 + 3 秒余量定一个上限（夹在 6 秒 ~ 5 分钟），超了就当它死了，掐掉换下一个人说。
 */
export function playbackWatchdogMs(expectedMs: number): number {
  const safe = Number.isFinite(expectedMs) && expectedMs > 0 ? expectedMs : 4_000;
  return Math.min(300_000, Math.max(6_000, Math.round(safe) + 3_000));
}

export function systemPlayerCommand(file: string, mime: string, volume = 100): PlayerCommand {
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-EncodedCommand',
      Buffer.from(systemPlayerScript(file, mime, volume), 'utf16le').toString('base64'),
    ],
  };
}
