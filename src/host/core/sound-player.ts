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

/** 淡出用的「停」旗标：宿主打断时写这个文件，播放器自己把音量降到 0 再收。 */
export function stopFlagOf(file: string): string {
  return `${file}.stop`;
}

/**
 * 播放这段文件要跑的 Powershell 脚本（导出来是为了能测）。
 *
 * 【汐儿 · 11-15】加了音量：`SoundPlayer` 没有音量参数，所以**音量不是 100 时 wav 也走 MediaPlayer**；
 * 100 时保持原来的 `SoundPlayer`（那条路最稳，别为了统一把好的换掉）。
 * 【汐儿 · 11-18 m27977】要「淡出」：`SoundPlayer` 停就是硬停，只有 `MediaPlayer` 能一边降音量一边停。
 * 所以给了 stopFile 的（也就是会被打断的那条）一律走 MediaPlayer，边播边看旗标，
 * 看到就把音量分 10 步降到 0 再收 —— 听感是「渐弱收尾」，不是戛然掐断。
 */
export function systemPlayerScript(file: string, mime: string, volume = 100, stopFile = ''): string {
  const quoted = psQuote(file);
  const loud = playerVolume(volume) === '1.00';
  if (stopFile === '' && loud && (mime === 'audio/wav' || /\.wav$/i.test(file))) {
    return [
      '$ErrorActionPreference = "Stop"',
      // 别把「准备模块」的进度条当 CLIXML 往 stderr 灌（会白占 voice-play.log）
      '$ProgressPreference = "SilentlyContinue"',
      `$p = New-Object System.Media.SoundPlayer ${quoted}`,
      '$p.PlaySync()',
    ].join('\n');
  }
  const lines = [
    '$ErrorActionPreference = "Stop"',
    '$ProgressPreference = "SilentlyContinue"',
    'Add-Type -AssemblyName PresentationCore',
    '$mp = New-Object System.Windows.Media.MediaPlayer',
    `$mp.Open([uri]${quoted})`,
    `$mp.Volume = ${playerVolume(volume)}`,
    // 先开播、再问时长：等 NaturalDuration 有值可能要几百毫秒，不能让她等着它才开始说话
    '$mp.Play()',
    '$t0 = [Environment]::TickCount',
    'for ($i = 0; $i -lt 60 -and -not $mp.NaturalDuration.HasTimeSpan; $i++) { Start-Sleep -Milliseconds 50 }',
    '$ms = if ($mp.NaturalDuration.HasTimeSpan) { [int]$mp.NaturalDuration.TimeSpan.TotalMilliseconds } else { 4000 }',
    // 已经先播掉的那段要扣掉，否则每句都要念长一点
    '$left = [Math]::Max(0, $ms - ([Environment]::TickCount - $t0))',
  ];
  if (stopFile !== '') {
    const stopQuoted = psQuote(stopFile);
    lines.push(
      // 一边播一边看旗标：40ms 一次，看到就转去淡出
      '$fade = $false',
      '$waited = 0',
      `while ($waited -lt $left) { if (Test-Path -LiteralPath ${stopQuoted}) { $fade = $true; break } Start-Sleep -Milliseconds 40; $waited += 40 }`,
      'if ($fade) {',
      '  for ($k = 10; $k -ge 0; $k--) { $mp.Volume = [double]$k / 10.0; Start-Sleep -Milliseconds 25 }',
      '}',
    );
  } else {
    lines.push('Start-Sleep -Milliseconds $left');
  }
  lines.push('$mp.Stop()', '$mp.Close()');
  return lines.join('\n');
}

/**
 * 播放看门狗（【本鱼 · 11-15】哥哥报「用着用着没声音、陪伴开口也少了」）。
 *
 * 根因：`playAudio` 只等 `close`，播放器（ffplay / powershell）一旦卡住就永远不 resolve，
 * 那把「嗓子」被永久占着：碎碎念被当 busy 丢掉、对话排在后面等不到 —— 表现就是先没声音、再没人说话。
 * 这里按音频时长定上限，超了就当它死了，掐掉换下一个人说。
 *
 * 【汐儿 · 11-18 m27977】旧口径是「时长 + 3 秒、最少 6 秒」，结果**估算偏短就误杀**：
 * 11-18 14:40 那条 `speak-stuck key=chat:2 over 6000ms`，正是 6 秒下限顶到真实 8 秒的音频上，
 * 哥哥听到的就是「说到一半自己停了」。现在按 1.5 倍时长 + 8 秒给，最低 20 秒 ——
 * 宁可让卡死的播放器多占 20 秒，也不能把正常的长句掐断。
 */
export function playbackWatchdogMs(expectedMs: number): number {
  const safe = Number.isFinite(expectedMs) && expectedMs > 0 ? expectedMs : 4_000;
  return Math.min(300_000, Math.max(12_000, Math.round(safe * 1.4) + 6_000));
}

export function systemPlayerCommand(file: string, mime: string, volume = 100, stopFile = ''): PlayerCommand {
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-EncodedCommand',
      Buffer.from(systemPlayerScript(file, mime, volume, stopFile), 'utf16le').toString('base64'),
    ],
  };
}
