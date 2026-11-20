/**
 * voice-player.ts —— 常驻的「嗓子」（本鱼 · 11-18 m27977）。
 *
 * 干什么：
 *   起一个常驻的 PowerShell 进程，里面养着一个 WPF `MediaPlayer`。宿主通过**命令文件**告诉它
 *   「播这个音频 / 停下（淡出）」，它通过**状态文件**回报「开始播了 / 播完了」。
 *
 * 为什么不用现起进程：
 *   `systemPlayerCommand()` 每次都要付 PowerShell 启动 + `Add-Type PresentationCore` 的开销，
 *   实测 1.5 秒左右——每句都等这么久，字和声就彻底不同步了。常驻一份，只有第一次要付这个钱，
 *   之后每句只等 `MediaPlayer.Open`（实测 150~300 毫秒）。
 *
 * 为什么非要 MediaPlayer：
 *   ffplay 不能在播放中改音量，打断只能是「硬切」；哥哥 11-18 要的是「淡出」。
 *   `SoundPlayer` 也改不了音量。只有 `MediaPlayer.Volume` 能一边播一边降。
 *
 * 什么时候别用：
 *   - 测试里一律用假的（`createVoicePlayer({ spawn: fakeSpawn })`），别真起 PowerShell；
 *   - `ready === false`（起不来）时**必须**退回 ffplay，别让声音整个消失。
 *
 * 常见坑：
 *   - PowerShell 里读重定向的 stdin 会阻塞，所以这里走**文件轮询**（30 毫秒一次），不用 stdin。
 *   - 写命令文件必须是「写全新内容」，靠内容变化触发；同一句话播两次也要变（所以命令里带序号）。
 *   - `MediaPlayer.Open` 是异步的，`NaturalDuration` 要等一下才有值；先 `Play()` 再问时长，
 *     但不能早于追问就退出——daemon 主循环一直活着，退出只在 QUIT。
 *   - `$mp` 必须一直活着；`Close()` 之后再 `Open` 同一个实例会抛，所以要重开就新建。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VoicePlayerOptions {
  /** 放命令/状态文件的目录（默认 `%TEMP%/dsh-pet-voice`） */
  readonly dir?: string;
  /** 轮询间隔（毫秒），默认 30 */
  readonly pollMs?: number;
  /** 等「常驻进程进入就绪」的上限，默认 4000 */
  readonly startupTimeoutMs?: number;
  /** 诊断输出（宿主接到 mouth.log 的 [play] 行上，起不来时要看得见原因） */
  readonly log?: (line: string) => void;
}

export interface VoicePlayResult {
  readonly ok: boolean;
  /** 开始播放的时刻（宿主用它决定「气泡什么时候冒」） */
  readonly startedAtMs: number;
  /** 播完的时刻 */
  readonly endedAtMs: number;
  /** 被 STOP 淡出打断 */
  readonly faded: boolean;
}

export interface VoicePlayer {
  /** 常驻进程是否已经就绪（没就绪就去用 ffplay） */
  readonly ready: boolean;
  /** 播一段音频；resolve 时已经播完或被淡出打断 */
  play(file: string, volume: number, onStart?: () => void): Promise<VoicePlayResult>;
  /** 预热：现在就把常驻进程拉起来（开机调一次，第一句就不用等 PowerShell 启动） */
  warm(): void;
  /** 淡出：写 STOP，250 毫秒内收干净（不发 QUIT，进程留着下次用） */
  stop(): void;
  /** 收摊：QUIT 并清掉临时文件 */
  dispose(): void;
}

/** 拼 daemon 的 PowerShell 脚本（导出是为了能测，别在测试里真跑）。 */
export function daemonScript(dir: string): string {
  const q = (text: string): string => "'" + text.replace(/'/g, "''") + "'";
  const cmdFile = q(join(dir, 'cmd.txt'));
  const stateFile = q(join(dir, 'state.txt'));
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$ProgressPreference = "SilentlyContinue"',
    'Add-Type -AssemblyName PresentationCore',
    '$mp = New-Object System.Windows.Media.MediaPlayer',
    `$cmd = ${cmdFile}`,
    `$silent = ${q(join(dir, 'silent.wav'))}`,
    `$state = ${stateFile}`,
    "$last = ''",
    '$playing = $false',
    '$endAt = 0',
    "$current = ''",
    // 【11-20 汐儿】消息泵：WPF MediaPlayer 靠消息队列推进，光 Start-Sleep 会「静着不响」。
    //   DoEvents 走 System.Windows.Forms（.NET Framework 自带），比手搓 DispatcherFrame 稳。
    'Add-Type -AssemblyName System.Windows.Forms',
    '$pump = { [System.Windows.Forms.Application]::DoEvents() }',
    // 先握手：起得来才写 READY；宿主靠它判断「真就绪」，不再靠「400 毫秒后还活着」
    "[IO.File]::WriteAllText($state, 'READY')",
    '$silentOk = Test-Path -LiteralPath $silent',
    '$lastAt = [Environment]::TickCount',
    '$warmGapMs = 30000',
    'while ($true) {',
    "  $text = ''",
    '  if (Test-Path -LiteralPath $cmd) { try { $text = [IO.File]::ReadAllText($cmd) } catch { } }',
    '  if ($text -ne $last) {',
    '    $last = $text',
    "    $parts = $text.Split('|')",
    "    if ($parts[0] -eq 'PLAY') {",
    '      if ($playing) { $mp.Stop() }',
    // 空闲太久先放 150 毫秒静音把音频端点叫醒（哥哥 11-20「只有别的软件出声时才发音」）
    '      if ($silentOk -and ([Environment]::TickCount - $lastAt) -gt $warmGapMs) {',
    '        try { $mp.Open([uri]$silent); $mp.Volume = 0.02; $mp.Play(); & $pump; Start-Sleep -Milliseconds 150 } catch { }',
    '      }',
    '      try {',
    '        $mp.Open([uri]$parts[1])',
    '        $mp.Volume = [double]$parts[2]',
    '        $mp.Play()',
    '        $playing = $true',
    '        $current = $parts[3]',
    '        $ms = 4000',
    '        for ($i = 0; $i -lt 40 -and -not $mp.NaturalDuration.HasTimeSpan; $i++) { Start-Sleep -Milliseconds 25 }',
    '        if ($mp.NaturalDuration.HasTimeSpan) { $ms = [int]$mp.NaturalDuration.TimeSpan.TotalMilliseconds }',
    '        $endAt = [Environment]::TickCount + $ms',
    "        [IO.File]::WriteAllText($state, 'PLAYING|' + $parts[3])",
    '        $lastAt = [Environment]::TickCount + $ms',
    '      } catch {',
    '        $playing = $false',
    "        [IO.File]::WriteAllText($state, 'FAILED|' + $parts[3])",
    '      }',
    "    } elseif ($parts[0] -eq 'STOP') {",
    '      if ($playing) {',
    '        for ($k = 10; $k -ge 0; $k--) { $mp.Volume = [double]$k / 10.0; Start-Sleep -Milliseconds 25 }',
    '        $mp.Stop()',
    '        $playing = $false',
    "        [IO.File]::WriteAllText($state, 'DONE|' + $current)",
    '      }',
    "    } elseif ($parts[0] -eq 'QUIT') {",
    '      $mp.Close()',
    '      exit',
    '    }',
    '  }',
    '  if ($playing -and [Environment]::TickCount -ge $endAt) {',
    '    $mp.Stop()',
    '    $playing = $false',
    "    [IO.File]::WriteAllText($state, 'DONE|' + $current)",
    '  }',
    '  & $pump',
    '  Start-Sleep -Milliseconds 20',
    '}',
  ].join('\n');
}

/**
 * 一段静音的 wav（16kHz 单声道 16bit）。
 *
 * 【11-20 汐儿】干什么：空闲久了音频端点会睡，哥哥报「只有别的软件在出声时才发音」——
 * daemon 在长时间没播之后先放 150 毫秒静音把端点踢醒，再放真声音。
 * 什么时候别用：正常连着说的时候每次都放会白占 150 毫秒，只在「距上次播放超过 30 秒」时放。
 */
export function silentWav(ms = 150): Buffer {
  const samples = Math.max(1, Math.round((16_000 * ms) / 1000));
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(16_000, 24);
  buf.writeUInt32LE(32_000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

/** 把一段音频塞进命令文件：`PLAY|路径|音量|序号`（序号变 = 内容变 = daemon 会重播同一句）。 */
export function playCommand(file: string, volume: number, token: string): string {
  const safe = Math.min(100, Math.max(0, Number.isFinite(volume) ? volume : 100)) / 100;
  return `PLAY|${file}|${safe.toFixed(2)}|${token}`;
}

const DEFAULT_DIR_NAME = 'dsh-pet-voice';

export function createVoicePlayer(options: VoicePlayerOptions = {}): VoicePlayer {
  const dir = options.dir ?? join(process.env.TEMP ?? '.', DEFAULT_DIR_NAME);
  const pollMs = options.pollMs ?? 30;
  const startupTimeoutMs = options.startupTimeoutMs ?? 4_000;
  const cmdFile = join(dir, 'cmd.txt');
  const stateFile = join(dir, 'state.txt');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来就当作不可用 */
  }
  try {
    if (!existsSync(join(dir, 'silent.wav'))) writeFileSync(join(dir, 'silent.wav'), silentWav(150));
  } catch {
    /* 写不出来就只是少了暖机，不影响出声 */
  }
  let child: ChildProcess | null = null;
  let ready = false;
  let starting = false;
  let seq = 0;
  let disposed = false;
  /** 起失败后 30 秒内不再重试，免得每句都白起一个 PowerShell */
  let failedUntil = 0;
  const log = options.log ?? ((): void => {});
  /** 最近一次 STOP 的时刻：用来判断这次结束是不是被淡出打断的（11-18 踩过 faded 恒 false） */
  let stoppedAt = 0;

  const readState = (): string => {
    try {
      return readFileSync(stateFile, 'utf8').trim();
    } catch {
      return '';
    }
  };

  const writeCmd = (text: string): void => {
    try {
      // 注意：内容里不能带换行——daemon 用 `|` 切字段，多一行会把 token 弄脏（11-18 踩过）
      writeFileSync(cmdFile, text);
    } catch {
      /* 写不进去就当这次失败 */
    }
  };

  /** 起常驻进程；ok 之前一直拿 ffplay 顶着 */
  const start = (): void => {
    if (starting || disposed || child !== null) return;
    if (Date.now() < failedUntil) return;
    starting = true;
    try {
      writeFileSync(stateFile, '');
    } catch {
      /* 清不掉也能用 */
    }
    // 【11-20 汐儿】必须把命令文件也清空！上一轮 dispose 写的 `QUIT|x|0` 会留在盘上，
    //   新 daemon 一进主循环就读到它，第一件事就是自杀（实测：就绪 346ms 后 code=0 退出，
    //   于是每一句都退回 1.5 秒的一次性播放器 —— 这正是「via=daemon 一条都没有」的真凶）。
    writeCmd('');
    let stderr = '';
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          // 【11-20 汐儿】改 -EncodedCommand：`-Command` 传多行脚本会被引号吃掉，PowerShell 会
          //   退回「读 stdin」然后就那么挂着——实测「进程活着但一条命令都不理」，就绪判据还当真了。
          '-EncodedCommand',
          Buffer.from(daemonScript(dir), 'utf16le').toString('base64'),
        ],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
      );
    } catch (error) {
      starting = false;
      failedUntil = Date.now() + 30_000;
      log(`daemon 起不来：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-400);
    });
    child.on('close', (code) => {
      const wasReady = ready;
      child = null;
      ready = false;
      starting = false;
      if (wasReady) log(`daemon 退出了 code=${String(code)} ${stderr.trim()}`);
    });
    // 【11-20 汐儿】就绪判据改成「读到 READY」（daemon 起来第一件事就是写它），
    //   超时就把这条进程收掉、30 秒内不再重试，免得每句都白起一个 PowerShell。
    const startedAt = Date.now();
    const tick = (): void => {
      if (disposed || child === null) return;
      if (ready) return;
      if (readState() === 'READY') {
        ready = true;
        starting = false;
        log(`daemon 就绪 ${Date.now() - startedAt}ms`);
        return;
      }
      if (Date.now() - startedAt >= startupTimeoutMs) {
        starting = false;
        failedUntil = Date.now() + 30_000;
        log(`daemon ${String(Math.round(startupTimeoutMs / 1000))} 秒没握手（${stderr.trim() === '' ? '无输出' : stderr.trim()}），这段改用一次性播放器`);
        try {
          child?.kill();
        } catch {
          /* 已经退了 */
        }
        child = null;
        return;
      }
      setTimeout(tick, 50).unref?.();
    };
    tick();
  };

  return {
    get ready() {
      return ready && child !== null;
    },
    play(file: string, volume: number, onStart?: () => void): Promise<VoicePlayResult> {
      if (disposed || file === '') return Promise.resolve({ ok: false, startedAtMs: 0, endedAtMs: 0, faded: false });
      if (!ready) start();
      if (!ready || child === null) {
        return Promise.resolve({ ok: false, startedAtMs: 0, endedAtMs: 0, faded: false });
      }
      seq += 1;
      const token = `${Date.now()}-${seq}`;
      const wantPlay = `PLAYING|${token}`;
      const wantDone = `DONE|${token}`;
      const wantFail = `FAILED|${token}`;
      writeCmd(playCommand(file, volume, token));
      const t0 = Date.now();
      return new Promise<VoicePlayResult>((resolve) => {
        let startedAtMs = 0;
        const poll = (): void => {
          const state = readState();
          if (startedAtMs === 0 && state === wantPlay) {
            startedAtMs = Date.now();
            onStart?.();
          }
          if (state === wantDone || state === wantFail) {
            resolve({
              ok: state === wantDone,
              startedAtMs: startedAtMs === 0 ? t0 : startedAtMs,
              endedAtMs: Date.now(),
              faded: stoppedAt > t0 && Date.now() - stoppedAt < 4_000,
            });
            return;
          }
          if (Date.now() - t0 > 300_000) {
            resolve({ ok: false, startedAtMs, endedAtMs: Date.now(), faded: false });
            return;
          }
          setTimeout(poll, pollMs).unref?.();
        };
        poll();
      });
    },
    warm(): void {
      if (disposed) return;
      start();
    },
    stop(): void {
      if (child === null) return;
      stoppedAt = Date.now();
      seq += 1;
      writeCmd(`STOP|x|${seq}`);
    },
    dispose(): void {
      disposed = true;
      ready = false;
      if (child !== null) {
        seq += 1;
        writeCmd(`QUIT|x|${seq}`);
        const dying = child;
        setTimeout(() => {
          try {
            dying.kill();
          } catch {
            /* 已经退了 */
          }
        }, 600).unref?.();
      }
      child = null;
      // 【11-20 汐儿】收摊后把命令文件抹空，别把 QUIT 留在盘上毒下一轮（start() 还会再清一次）
      try {
        if (existsSync(cmdFile)) writeFileSync(cmdFile, '');
      } catch {
        /* 清不掉就靠 start() 那一次 */
      }
    },
  };
}