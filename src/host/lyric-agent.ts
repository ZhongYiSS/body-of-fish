/**
 * 歌词气泡的宿主半侧：取播放位置 → 取歌词 → 切片 → 写叶子。
 *
 * 移植自 dsh-pet-extras 的 `dsh-pet-lyric` v0.2（lib/modules/lyric.js），那版的头注释把设计
 * 理由写得很清楚，这里原样保留，别丢：
 *
 *   ① 缓存定期清理 —— 每 12 小时扫一遍，删掉 7 天没听过的歌；坏数据自动剔除
 *   ② 独立气泡 —— 写 `pets.<id>.lyric` 叶子，跟头顶那个 say 气泡完全隔离：
 *      吐槽/对话/余额照常显示，互不打架
 *   ③ 事件驱动 —— 不再定时 PowerShell 轮询：
 *        · 播放中：本地用「上次拿到的位置 + 流逝时间」推算，只在追不上时校准一次
 *        · 暂停/切歌：靠下一次校准发现（校准间隔按状态自适应）
 *        · 一句到底要换行了，才写一次叶子（零冗余）
 *      平均每首歌只起 1~2 次 PowerShell，而不是每 2 秒一次。
 *
 * 成本：纯本地规则 + 网易云公开接口（搜歌词一次），全程不调模型 = 零 token。
 *
 * 这一版（搬进新身体）只改**接法**，不改行为：
 *   - 旧版把歌词 POST 回 `http://127.0.0.1:<port>/dsh-pet-7340/lyric`（HTTP 回环）。新身体里
 *     宿主与壳在同一个进程边界内，回环是白绕一圈：还要挑端口、等响应、失败还要重试。
 *     现在只剩一个注入回调 `setLyric(text, instrumental)`——**唯一出口**，空串 = 隐藏；
 *   - 缓存不再是一个 `cache.json` 大文件，而是 `cacheDir/<歌曲 id>.json` 一歌一文件
 *     （见下方「缓存布局」）；
 *   - 定时器改成 setTimeout 自调度（模块顶层不起 timer），stop() 之后不再有任何异步回调写叶子。
 *
 * 依赖铁律：DSH 单文件加载会把 chunk 拆开，所以**只 import node 内置**，不碰 src/shared。
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** tick 周期（ms）：只做本地推算与换句判断，**不碰 PowerShell** */
const TICK_MS = 500;

/** 快播完的判定窗口（ms）与提前校准间隔（ms）——留给「切下一首」的发现时间 */
const NEAR_END_MS = 4_000;
const NEAR_END_CALIB_MS = 1_500;

/** 没到第一句时显示的占位符（与旧版一致：`♪` 配 instrumental 样式） */
const PRELUDE_TEXT = '♪';

/** 网易云接口的请求头：不带 UA/Referer 会被回 403 或空结果 */
const NETEASE_HEADERS: Record<string, string> = {
  'user-agent': 'Mozilla/5.0',
  referer: 'https://music.163.com/',
};

export interface LyricAgentConfig {
  enabled?: boolean;
  cacheTtlDays?: number;
  cacheSweepHours?: number;
  maxDriftMs?: number;
  playingCalibMs?: number;
  idleCalibMs?: number;
}

export interface LyricAgentDeps {
  /** 唯一出口：把当前该显示的一行写进 lyric 叶子（空串 = 隐藏） */
  setLyric(text: string, instrumental: boolean): void;
  cacheDir: string;
  config?: LyricAgentConfig;
  now?(): number;
  /** 可注入，测试用：跑一次「读播放器状态」的命令，返回 stdout */
  readPlayer?(): Promise<string>;
  /** 可注入，测试用 */
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

/** 一行歌词：`ms` 是这句该出现的时间，`trans` 是（可选的）中文翻译 */
interface LyricLine {
  ms: number;
  text: string;
  trans?: string;
}

/** 播放器快照（从 readPlayer 的 stdout 解析而来） */
interface PlayerSnapshot {
  title: string;
  artist: string;
  playing: boolean;
  positionMs: number;
  endMs: number;
}

/** 一盘歌词的磁盘形状（`cacheDir/<id>.json`） */
interface CacheEntry {
  id: string;
  title: string;
  artist: string;
  /** 最后一次听到它的时间（TTL 清理用；命中时刷新） */
  at: number;
  matched?: string;
  lines: LyricLine[];
}

// ── 纯函数：LRC 解析 / 切片 ─────────────────────────────────────────────

/**
 * 解析 LRC → [{ ms, text }]，支持一行多时间标签（`[00:10.00][01:20.00]副歌`）。
 * 没有时间标签或没有文本的行直接丢：制作人名单之前就是这么被滤掉的。
 */
function parseLrc(lrc: unknown): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of String(lrc ?? '').split('\n')) {
    const timeRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    const times: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = timeRe.exec(raw)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
      times.push((min * 60 + sec) * 1000 + frac);
    }
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!text || times.length === 0) continue;
    for (const t of times) out.push({ ms: t, text });
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

/**
 * 判断一段歌词是不是「脏」的（PowerShell 乱码时代的产物）。
 * 旧版本地化过：早期版本把 PowerShell 的 cp936 输出当 UTF-8 读，于是整盘歌词变成
 * 「锟斤拷/鈥/浣」这类东西，还写进了缓存。坏缓存必须当没有，否则一辈子都在显示乱码。
 */
function looksGarbled(lines: readonly { text?: string }[]): boolean {
  if (lines.length === 0) return true;
  let bad = 0;
  let total = 0;
  for (const line of lines) {
    const text = String(line?.text ?? '');
    if (!text) continue;
    total++;
    // 典型乱码特征：大量替换字符 / 问号方块 / 异常的孤立高位字符
    if (/[\uFFFD\uFFFE\uFFFF]/.test(text) || /锟斤拷|锘|鈥|锛|鍙|浣|璇|鏇/.test(text)) bad++;
  }
  return total > 0 && bad / total > 0.3;
}

/** 这一行是元信息（词/曲/编曲/制作…）还是正文？元信息不该配翻译 */
function isMetaLine(text: string, title: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return true;
  // 「词：xxx」「编曲：xxx」这类标签行。这里限定明确的角色词，而不是「任意短前缀 + 冒号」——
  // 歌词里本来就有「他说：别走」这种句子，按短前缀判会把正文误伤成元信息（翻译就丢了）。
  if (/^(作词|作曲|编曲|制作人?|监制|混音|母带|录音|吉他|贝斯|鼓|键盘|弦乐|和声|演唱|出品|发行|词|曲)[：:]/.test(t)) {
    return true;
  }
  // 标题行（「歌名 - 歌手」或含歌名且很短）
  if (title && t.includes(title) && t.length <= 40) return true;
  return false;
}

/**
 * 双语：把翻译按时间轴贴到原文上。
 *
 * 为什么是「贴」而不是两套时间轴：网易云一次调用同时给 `lrc` 和 `tlyric`（翻译），两边
 * 是同一版录音的时间轴，基本对齐。这里给每句原文找**最近的一句翻译（≤2 秒）**，
 * 找不到就不贴——宁可只显示原文，也不要错位贴到别的句子上。
 * 标题/制作人名单不配翻译（否则会出现「Lemon - 米津玄師」配「如果这一切都是梦境」的错位）。
 */
function attachTranslations(lines: LyricLine[], transLines: LyricLine[], title: string): LyricLine[] {
  if (lines.length === 0 || transLines.length === 0) return lines;
  const sorted = transLines.slice().sort((a, b) => a.ms - b.ms);
  for (const line of lines) {
    if (isMetaLine(line.text, title)) continue;
    // 手写二分找最近的一句：歌词上千行，逐行线性找最近是 O(n²)
    let lo = 0;
    let hi = sorted.length - 1;
    let best: LyricLine | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const diff = Math.abs(sorted[mid].ms - line.ms);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = sorted[mid];
      }
      if (sorted[mid].ms < line.ms) lo = mid + 1;
      else hi = mid - 1;
    }
    if (best && bestDiff <= 2_000 && best.text && best.text !== line.text) {
      line.trans = best.text;
    }
  }
  return lines;
}

/** 一行歌词的显示文本：有翻译就两行（原文 + 翻译），没有就原文 */
function lineText(line: LyricLine | null): string {
  if (!line) return '';
  const orig = String(line.text ?? '').trim();
  const trans = String(line.trans ?? '').trim();
  if (!trans || trans === orig) return orig;
  return orig + '\n' + trans;
}

/** 某一时刻该显示哪一句：取「最后一个 ms <= 位置」的行；还没到第一句 → null */
function lineAt(lines: readonly LyricLine[], ms: number): LyricLine | null {
  let found: LyricLine | null = null;
  for (const line of lines) {
    if (line.ms <= ms) found = line;
    else break;
  }
  return found;
}

/** 歌曲键：歌名 + 艺人。用它去索引里找缓存；两边都拿播放器给的原始值，不做归一化 */
function songKey(title: string, artist: string): string {
  return title + '|' + artist;
}

// ── 播放器状态：默认实现（Windows 系统媒体会话）────────────────────────
//
// 沿用旧实现的思路：Windows 走 PowerShell 查全局媒体会话（QQ音乐 / 网易云 / Spotify），
// 由系统告诉我们歌名、艺人、播放状态和位置。三条注意：
//   1. 命令内联在本文件里（旧版外挂 media_query.ps1 是为了让哥哥能自己改；新身体里
//      读播放器是宿主进程的事，内联少一个「文件找不到」的失败路径。要改就改这个常量）；
//   2. 用 `-EncodedCommand`（UTF-16LE base64）而不是 `-Command`：脚本里有引号、换行、
//      `|` 和 `$`，走命令行会被 PowerShell 自己的参数解析咬碎；
//   3. **结果也用 base64 吐出来**：Windows PowerShell 5.1 的控制台默认 cp936，直接
//      Write-Output 中文歌名会在管道里变成乱码（旧版就是为此写临时 JSON 文件的）。
//      base64 全是 ASCII，不经过控制台编码，读出来再按 UTF-8 解码就是原文。
const MEDIA_QUERY_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue

function Await($task, $resultType) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  })[0]
  $generic = $asTask.MakeGenericMethod($resultType)
  $netTask = $generic.Invoke($null, @($task))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$result = '{"ok":false,"reason":"unknown"}'
try {
  $mt = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $mgr = Await ($mt::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

  $session = $null
  foreach ($x in $mgr.GetSessions()) {
    if ($x.SourceAppUserModelId -match 'QQMusic|CloudMusic|Spotify|Music') { $session = $x; break }
  }

  if (-not $session) {
    $result = '{"ok":false,"reason":"no-session"}'
  } else {
    $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $tl = $session.GetTimelineProperties()
    $info = $session.GetPlaybackInfo()

    $obj = [ordered]@{
      ok         = $true
      title      = [string]$props.Title
      artist     = [string]$props.Artist
      album      = [string]$props.AlbumTitle
      status     = [string]$info.PlaybackStatus
      positionMs = [int]$tl.Position.TotalMilliseconds
      endMs      = [int]$tl.EndTime.TotalMilliseconds
      app        = [string]$session.SourceAppUserModelId
    }
    $result = $obj | ConvertTo-Json -Compress
  }
} catch {
  $result = '{"ok":false,"reason":"' + ($_.Exception.Message -replace '"', '') + '"}'
}

[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($result)))
`;

/** 把 PowerShell 吐出来的 base64 还原成 JSON 文本；解不开就给一个「读失败」的 JSON */
function decodeQueryOutput(stdout: string): string {
  // PowerShell 偶尔会往 stdout 里混进警告文本（Add-Type 之类），所以取**最长的 base64 形状
  // 那段**再解码，而不是把整段 stdout 当 base64——混一个换行就全废了。
  const tokens = String(stdout ?? '').match(/[A-Za-z0-9+/=]{8,}/g);
  const b64 = tokens && tokens.length > 0 ? tokens.reduce((a, b) => (b.length > a.length ? b : a)) : '';
  if (!b64) return '{"ok":false,"reason":"empty"}';
  try {
    const json = Buffer.from(b64, 'base64').toString('utf8').trim();
    return json || '{"ok":false,"reason":"empty"}';
  } catch {
    return '{"ok":false,"reason":"bad-output"}';
  }
}

/**
 * 默认的「读播放器」实现：起一次 PowerShell，返回 JSON 文本。
 * 任何失败都折叠成 `{"ok":false,...}`——调用方只关心「有没有在听、听什么」，
 * 不该因为读不到就把整个歌词代理弄崩。非 Windows 直接返回失败，不 spawn。
 */
function defaultReadPlayer(): Promise<string> {
  if (process.platform !== 'win32') {
    return Promise.resolve('{"ok":false,"reason":"not-windows"}');
  }
  const encoded = Buffer.from(MEDIA_QUERY_SCRIPT, 'utf16le').toString('base64');
  return execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    // 12s 与旧版一致：机器忙时 WMI/媒体会话首次调用可能要几秒
    { timeout: 12_000, windowsHide: true, maxBuffer: 64 * 1024 },
  ).then(
    ({ stdout }) => decodeQueryOutput(String(stdout ?? '')),
    () => '{"ok":false,"reason":"powershell-failed"}',
  );
}

/** 解析播放器快照；形状不对 / 没歌名 / 解析失败一律返回 null（当没在听） */
function parsePlayer(raw: string): PlayerSnapshot | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  if (obj.ok !== true || !title) return null;
  const status = typeof obj.status === 'string' ? obj.status : '';
  const toMs = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  return {
    title,
    artist: typeof obj.artist === 'string' ? obj.artist.trim() : '',
    // 'Changing' 是 Windows 在切歌/缓冲时的过渡态，也算在播
    playing: status === 'Playing' || status === 'Changing',
    positionMs: toMs(obj.positionMs),
    endMs: toMs(obj.endMs),
  };
}

// ── 主工厂 ──────────────────────────────────────────────────────────────

export function createLyricAgent(deps: LyricAgentDeps): {
  start(): void;
  stop(): void;
  /** 跑一次校准+推送（测试与手动排查用）；返回这一轮是否有变化 */
  tickOnce(): Promise<boolean>;
} {
  const config = deps.config ?? {};
  // 用 typeof 判而不是 `??`：0 是合法取值（比如 maxDriftMs=0 表示每次采样都硬校准）
  const enabled = config.enabled !== false;
  const cacheTtlDays = typeof config.cacheTtlDays === 'number' ? config.cacheTtlDays : 7;
  const cacheSweepHours = typeof config.cacheSweepHours === 'number' ? config.cacheSweepHours : 12;
  const maxDriftMs = typeof config.maxDriftMs === 'number' ? config.maxDriftMs : 1_200;
  const playingCalibMs = typeof config.playingCalibMs === 'number' ? config.playingCalibMs : 20_000;
  const idleCalibMs = typeof config.idleCalibMs === 'number' ? config.idleCalibMs : 8_000;

  const clock = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const readPlayer = deps.readPlayer ?? defaultReadPlayer;
  const fetchImpl: typeof fetch = deps.fetchImpl ?? fetch;
  const cacheDir = deps.cacheDir;
  const indexPath = join(cacheDir, 'index.json');

  // ── 运行状态 ──────────────────────────────────────────────────────────
  let disposed = false; // stop() 之后为 true：任何异步回调都要先看它，绝不再写叶子
  let started = false; // start() 幂等
  let busy = false; // 一轮 tick 没跑完时不再开第二轮（旧版 calibrating 的推广）
  let tickTimer: ReturnType<typeof setTimeout> | undefined;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;

  const state = {
    key: '', // "歌名|艺人"，空 = 没在听
    title: '',
    artist: '',
    playing: false,
    baseMs: 0, // 上次校准时的播放位置
    baseAt: 0, // 上次校准的本地时间
    endMs: 0, // 歌曲总长（0 = 未知）
    lastCalib: null as number | null, // 上次校准的本地时间；null = 还没校准过
    lines: null as LyricLine[] | null, // 当前歌的歌词；null/[] = 没词（纯器乐）
    shown: false, // 是否已经写过叶子（用来区分「还没写过」与「写过空串」）
    shownText: '',
    shownInstrumental: false,
  };

  // ── 缓存布局 ──────────────────────────────────────────────────────────
  //
  // 为什么是「索引 + 一歌一文件」而不是旧版的一个 cache.json：
  //   - 数据文件按**歌曲 id** 命名（`<neteaseId>.json`），删歌、查歌都是单文件操作；
  //   - index.json 只存 `歌曲键 → { id, at }`，作用是**命中时不用再联网搜一遍**——
  //     没有它，光凭歌名是找不到 id 的，缓存等于白存；
  //   - index.json 里读到的 id 要过一遍白名单校验：它是磁盘上的文件，手改过也不许
  //     拼出 `../` 之类的路径。
  const index = new Map<string, { id: string; at: number }>();
  let indexLoaded = false;
  // 所有落盘操作串成一条链：tick 与后台清理可能同时写，两个 writeFile 撞在一起会写出半截 JSON
  let writeChain: Promise<void> = Promise.resolve();

  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = writeChain.then(task).catch((error: unknown) => {
      log('缓存写入失败：' + messageOf(error));
    });
    writeChain = run;
    return run;
  }

  function isValidId(id: string): boolean {
    return /^[A-Za-z0-9_-]+$/.test(id);
  }

  async function ensureDir(): Promise<void> {
    try {
      await mkdir(cacheDir, { recursive: true });
    } catch {
      /* 建不出来就让后面的写失败并被 log 掉，别在这里炸整轮 tick */
    }
  }

  async function ensureIndex(): Promise<void> {
    if (indexLoaded) return;
    indexLoaded = true;
    await ensureDir();
    try {
      const raw = await readFile(indexPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const obj = value as Record<string, unknown>;
        const id = typeof obj.id === 'string' ? obj.id : '';
        const at = Number(obj.at);
        if (!id || !isValidId(id) || !Number.isFinite(at)) continue;
        index.set(key, { id, at });
      }
    } catch {
      // 没有索引 / 索引坏了 = 空缓存；下一次联网会把它重建出来
    }
  }

  function saveIndex(): Promise<void> {
    const data: Record<string, { id: string; at: number }> = {};
    for (const [key, value] of index) data[key] = { id: value.id, at: value.at };
    const payload = JSON.stringify(data);
    return enqueue(() => writeFile(indexPath, payload, 'utf8'));
  }

  /** 读一盘缓存；结构不对 / 乱码 / 读不出来 → null（调用方当成没有，重新联网） */
  async function readEntry(id: string): Promise<CacheEntry | null> {
    if (!isValidId(id)) return null;
    try {
      const raw = await readFile(join(cacheDir, id + '.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const obj = parsed as Record<string, unknown>;
      const lines = normalizeLines(obj.lines);
      if (!lines) return null;
      const at = Number(obj.at);
      return {
        id,
        title: typeof obj.title === 'string' ? obj.title : '',
        artist: typeof obj.artist === 'string' ? obj.artist : '',
        at: Number.isFinite(at) ? at : 0,
        ...(typeof obj.matched === 'string' ? { matched: obj.matched } : {}),
        lines,
      };
    } catch {
      return null;
    }
  }

  /** 磁盘上的歌词行做形状校验 + 乱码剔除 + 按时间排序 */
  function normalizeLines(value: unknown): LyricLine[] | null {
    if (!Array.isArray(value) || value.length === 0) return null;
    const out: LyricLine[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') return null;
      const obj = item as Record<string, unknown>;
      const ms = Number(obj.ms);
      const text = typeof obj.text === 'string' ? obj.text : '';
      if (!Number.isFinite(ms) || ms < 0 || !text.trim()) return null;
      const trans = typeof obj.trans === 'string' && obj.trans.trim() ? obj.trans : undefined;
      out.push(trans ? { ms, text, trans } : { ms, text });
    }
    if (looksGarbled(out)) return null;
    return out.sort((a, b) => a.ms - b.ms);
  }

  /** 缓存命中：刷新「最后听过」的时间（否则天天听的歌也会被 TTL 清掉） */
  async function readCachedLyrics(key: string): Promise<LyricLine[] | null> {
    await ensureIndex();
    const hit = index.get(key);
    if (!hit) return null;
    const entry = await readEntry(hit.id);
    if (!entry) {
      // 有索引没有数据（手删了文件 / 坏文件）：当没有，顺手把索引也清掉
      index.delete(key);
      await saveIndex();
      return null;
    }
    hit.at = clock();
    await saveIndex();
    return entry.lines;
  }

  // ── 网易云 ────────────────────────────────────────────────────────────
  //
  // 旧版是「QQ 音乐优先、网易云兜底」，因为哥哥的播放器是 QQ 音乐。搬进新身体时按需求
  // 只保留网易云公开接口（一次调用同时给原文 + 翻译），URL 与解析沿用旧实现：
  //   搜索：/api/search/get/web?s=<歌名 艺人>&type=1&limit=5
  //   歌词：/api/song/lyric?id=<id>&lv=1&kv=1&tv=-1

  interface FoundSong {
    id: string;
    name: string;
    artists: string;
  }

  async function searchNetease(title: string, artist: string): Promise<FoundSong[]> {
    const query = encodeURIComponent((title + ' ' + artist).trim());
    const url =
      'https://music.163.com/api/search/get/web?csrf_token=&s=' +
      query +
      '&type=1&offset=0&limit=5';
    const res = await fetchImpl(url, {
      headers: NETEASE_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`搜索回了 HTTP ${res.status}`);
    const json = (await res.json()) as { result?: { songs?: unknown } };
    const songs = json?.result?.songs;
    if (!Array.isArray(songs)) return [];
    const out: FoundSong[] = [];
    for (const song of songs) {
      if (!song || typeof song !== 'object') continue;
      const obj = song as Record<string, unknown>;
      const id = String(obj.id ?? '');
      if (!id || !isValidId(id)) continue;
      // artists 可能是 [{name}] 也可能是字符串，两种都认
      const rawArtists = obj.artists;
      const artists = Array.isArray(rawArtists)
        ? rawArtists
            .map((a) => (a && typeof a === 'object' ? String((a as Record<string, unknown>).name ?? '') : ''))
            .filter(Boolean)
            .join('/')
        : typeof rawArtists === 'string'
          ? rawArtists
          : '';
      out.push({ id, name: typeof obj.name === 'string' ? obj.name : '', artists });
    }
    return out;
  }

  /**
   * 找「最对的那一版」并取词。
   * 单搜歌名容易撞到翻唱/remix，所以：标题完全一致的排最前，其余按接口顺序，
   * 最多试 3 首——接口偶尔会给同名的现场版，第一首没词就换下一首。
   * 少于 3 行当作没词（一句「纯音乐，请欣赏」不算歌词）。
   */
  async function fetchFromNetease(
    title: string,
    artist: string,
  ): Promise<{ id: string; lines: LyricLine[]; matched: string } | null> {
    const songs = await searchNetease(title, artist);
    if (songs.length === 0) return null;
    const norm = (value: string): string => value.trim().toLowerCase();
    const exact = songs.find((song) => norm(song.name) === norm(title));
    const ordered = exact ? [exact, ...songs.filter((song) => song !== exact)] : songs;
    for (const song of ordered.slice(0, 3)) {
      try {
        const url =
          'https://music.163.com/api/song/lyric?id=' +
          encodeURIComponent(song.id) +
          '&lv=1&kv=1&tv=-1';
        const res = await fetchImpl(url, {
          headers: NETEASE_HEADERS,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) continue;
        const json = (await res.json()) as { lrc?: { lyric?: string }; tlyric?: { lyric?: string } };
        const lines = parseLrc(json?.lrc?.lyric);
        if (lines.length < 3 || looksGarbled(lines)) continue;
        const trans = parseLrc(json?.tlyric?.lyric);
        if (trans.length > 0) attachTranslations(lines, trans, title);
        return { id: song.id, lines, matched: `${song.name} - ${song.artists}` };
      } catch {
        // 这一首查不到就试下一首；全失败由调用方当「没词」
        continue;
      }
    }
    return null;
  }

  async function storeLyrics(key: string, title: string, artist: string, found: {
    id: string;
    lines: LyricLine[];
    matched: string;
  }): Promise<void> {
    index.set(key, { id: found.id, at: clock() });
    const entry: CacheEntry = {
      id: found.id,
      title,
      artist,
      at: clock(),
      matched: found.matched,
      lines: found.lines,
    };
    const payload = JSON.stringify(entry);
    const file = join(cacheDir, found.id + '.json');
    await enqueue(() => writeFile(file, payload, 'utf8'));
    await saveIndex();
  }

  /**
   * 取歌词：先缓存，后联网。
   * 联网失败（断网、接口改版）**不抛**：这一轮就当没词，下一首歌再试——
   * 歌词气泡坏了不该让桌宠表现出「出事了」。
   */
  async function fetchLyrics(title: string, artist: string): Promise<LyricLine[] | null> {
    const key = songKey(title, artist);
    const cached = await readCachedLyrics(key);
    if (cached) {
      log(`歌词缓存命中：${title}`);
      return cached;
    }
    try {
      const found = await fetchFromNetease(title, artist);
      if (!found) {
        log(`没找到可用歌词：${title} - ${artist}`);
        return null;
      }
      await storeLyrics(key, title, artist, found);
      log(`拿到歌词：${title} → ${found.matched}（${found.lines.length} 行）`);
      return found.lines;
    } catch (error) {
      log('歌词查询失败：' + messageOf(error));
      return null;
    }
  }

  // ── 缓存清理（旧版第 ① 项升级）────────────────────────────────────────

  /**
   * 清两类东西：
   *   1. 过期：`cacheTtlDays` 天没再听过的歌（`at` 在命中时刷新，所以「常听」不会过期）；
   *   2. 孤儿：索引里没有、mtime 又超过 TTL 的 `<id>.json`（索引被删/坏掉留下的残骸，
   *      不清的话缓存目录会一直长）。
   * 坏数据不在这里逐个读文件排除——读取时（readEntry/normalizeLines）已经把它当没有了，
   * 坏条目下一次读到就会被删掉索引，没必要每次清理都全盘读一遍。
   */
  async function sweepCache(reason: string): Promise<void> {
    await ensureIndex();
    const now = clock();
    const ttlMs = cacheTtlDays * 24 * 3600 * 1000;
    let expired = 0;
    for (const [key, hit] of [...index]) {
      if (!(hit.at > 0) || now - hit.at > ttlMs) {
        index.delete(key);
        expired++;
        await unlink(join(cacheDir, hit.id + '.json')).catch(() => {});
      }
    }
    // 孤儿文件：只认「<id>.json」这个形状；index.json 是索引本身，绝不能当孤儿删掉
    // （删了索引，所有数据文件就都成了孤儿——等于白清一次缓存）
    const keep = new Set<string>(['index.json']);
    for (const hit of index.values()) keep.add(hit.id + '.json');
    try {
      for (const name of await readdir(cacheDir)) {
        if (!/^[A-Za-z0-9_-]+\.json$/.test(name) || keep.has(name)) continue;
        const info = await stat(join(cacheDir, name)).catch(() => null);
        if (info && now - info.mtimeMs > ttlMs) await unlink(join(cacheDir, name)).catch(() => {});
      }
    } catch {
      // 目录还不存在（第一次启动）：没什么可清的
    }
    if (expired > 0) await saveIndex();
    log(`缓存清理（${reason}）：过期 ${expired} 首，剩 ${index.size} 首`);
  }

  // ── 推算与切片 ────────────────────────────────────────────────────────

  /** 本地推算当前位置：上次校准的位置 + 流逝时间；暂停时就是上次的位置 */
  function predict(now: number): number {
    if (!state.playing) return state.baseMs;
    const p = state.baseMs + Math.max(0, now - state.baseAt);
    return state.endMs > 0 && p > state.endMs ? state.endMs : p;
  }

  /**
   * 这一轮要不要去问播放器？
   *
   * 为什么不是「每次 tick 都问」：一次 PowerShell 要几百毫秒到几秒，500ms 一次会把
   * 机器和进程都拖住（旧版正是因此改成推算）。所以频率按状态自适应：
   *   - 从没校准过 → 立刻问；
   *   - 暂停 / 没词 → 低频探（idleCalibMs），只为发现「恢复播放」「切歌」；
   *   - 播放中 → playingCalibMs 一次；快播完（<4s）提前到 1.5s，好接上下一首。
   */
  function calibrationDue(now: number): boolean {
    if (state.lastCalib === null) return true;
    const since = now - state.lastCalib;
    const idle = !state.playing || !state.lines || state.lines.length === 0;
    if (idle) return since >= idleCalibMs;
    const nearEnd = state.endMs > 0 && state.endMs - predict(now) < NEAR_END_MS;
    return since >= (nearEnd ? NEAR_END_CALIB_MS : playingCalibMs);
  }

  /**
   * 采一次播放器。**只有「校准」这一步会碰 PowerShell / 联网**，tick 本身纯本地。
   *
   * 关于 maxDriftMs（旧版声明了但没真正用上，这里补全语义）：
   * 每次采样都拿「推算值」和「播放器真值」比一次，偏差 > maxDriftMs 才把基准
   * 重设到真值（拖进度条 / 暂停后重播 / 时钟漂移过大），否则**保留本地推算**。
   * 为什么不无脑对齐：每 20 秒硬把基准拽回真值，气泡的行会在两行之间小跳一下；
   * 偏差在 1.2 秒内根本看不出来（一句歌词最短也有 2~3 秒），留着更平滑。
   * 切歌 / 播放状态变化不受这个阈值约束——那两种必须立刻重设。
   */
  async function calibrate(now: number): Promise<void> {
    // 先记时间：读失败时也要退避，否则没播放器就会每 500ms 起一次 PowerShell
    state.lastCalib = now;
    let raw: string;
    try {
      raw = await readPlayer();
    } catch (error) {
      log('读播放器失败：' + messageOf(error));
      return;
    }
    if (disposed) return;

    const media = parsePlayer(raw);
    if (!media) {
      // 没播放器 / 没会话 / 读失败：一律当「没在听」，把气泡收起来
      state.key = '';
      state.title = '';
      state.artist = '';
      state.playing = false;
      state.endMs = 0;
      state.lines = null;
      return;
    }

    const key = songKey(media.title, media.artist);
    const songChanged = key !== state.key;
    const statusChanged = media.playing !== state.playing;
    const drift = Math.abs(media.positionMs - predict(now));
    const resync = songChanged || statusChanged || !media.playing || drift > maxDriftMs;

    state.endMs = media.endMs;
    if (resync) {
      state.baseMs = media.positionMs;
      state.baseAt = now;
    }
    state.playing = media.playing;

    if (!songChanged) return;
    state.key = key;
    state.title = media.title;
    state.artist = media.artist;
    state.lines = await fetchLyrics(media.title, media.artist);
    if (disposed) return;
    log('切歌：' + state.title + ' - ' + state.artist + (state.lines ? `（${state.lines.length} 行）` : '（无词）'));
  }

  /**
   * 唯一出口：把「这一轮该显示什么」写进叶子。
   * 去重口径是**文本 + 器乐标志**：一模一样就一个字都不写（旧版靠 `state.shownLine`，
   * 这里多带了 instrumental，因为纯器乐是「空文本 + instrumental=true」，
   * 与「暂停时隐藏」的空文本语义不同）。
   */
  function emit(text: string, instrumental: boolean): boolean {
    if (disposed) return false;
    if (state.shown && text === state.shownText && instrumental === state.shownInstrumental) return false;
    try {
      deps.setLyric(text, instrumental);
    } catch (error) {
      log('写歌词叶子失败：' + messageOf(error));
      return false;
    }
    state.shown = true;
    state.shownText = text;
    state.shownInstrumental = instrumental;
    return true;
  }

  /** 按推算位置决定显示什么：没歌/暂停 → 隐藏；没词 → 空文本+器乐；前奏 → ♪；否则当前行 */
  function deliver(now: number): boolean {
    if (!state.key || !state.playing) return emit('', false);
    const lines = state.lines;
    if (!lines || lines.length === 0) return emit('', true);
    const current = lineAt(lines, predict(now));
    if (!current) return emit(PRELUDE_TEXT, true);
    return emit(lineText(current), false);
  }

  // ── 主循环 ────────────────────────────────────────────────────────────

  async function runTick(): Promise<boolean> {
    if (disposed || !enabled || busy) return false;
    busy = true;
    try {
      await ensureIndex();
      if (disposed) return false;
      const now = clock();
      if (calibrationDue(now)) {
        await calibrate(now);
        if (disposed) return false;
      }
      return deliver(clock());
    } finally {
      busy = false;
    }
  }

  /**
   * 自调度：这一轮跑完再排下一轮，而不是 setInterval。
   * 好处是读播放器（可能要几秒）不会和下一拍叠在一起——叠了就是并发起两个 PowerShell。
   */
  async function tickLoop(): Promise<void> {
    tickTimer = undefined;
    if (disposed) return;
    try {
      await runTick();
    } catch (error) {
      // 单轮异常绝不能断掉循环，否则歌词就永远停在那句了
      log('tick 异常：' + messageOf(error));
    }
    scheduleTick();
  }

  function scheduleTick(): void {
    if (disposed) return;
    tickTimer = setTimeout(() => {
      void tickLoop();
    }, TICK_MS);
    // 不因一个后台 tick 拖住进程退出（Electron 壳退出时尤其明显）
    tickTimer.unref?.();
  }

  function scheduleSweep(): void {
    const sweepMs = cacheSweepHours * 3600 * 1000;
    // 配 0 或负数 = 不清理：否则会变成 0ms 的热循环
    if (disposed || !(sweepMs > 0)) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = undefined;
      // catch 放在 finally 前面：万一清理抛了，兜住它，别变成 unhandledRejection，
      // 但下一轮清理还是要排（否则一次失败就再也不扫了）
      void sweepCache('定时')
        .catch((error: unknown) => log('定时清理失败：' + messageOf(error)))
        .finally(() => {
          scheduleSweep();
        });
    }, sweepMs);
    sweepTimer.unref?.();
  }

  // ── 对外接口 ──────────────────────────────────────────────────────────

  function start(): void {
    if (started || disposed || !enabled) return;
    started = true;
    void (async () => {
      // 启动就扫一次：把旧时代留下的脏缓存、以及太久没听的歌清掉
      await sweepCache('启动').catch((error: unknown) => {
        log('启动清理失败：' + messageOf(error));
      });
      if (disposed) return;
      scheduleSweep();
      void tickLoop(); // 立刻校准一次，别等第一个 500ms
      log(
        '歌词代理已就位 | 事件驱动（tick ' +
          TICK_MS +
          'ms 纯本地）| 播放中校准 ' +
          playingCalibMs / 1000 +
          's、空闲 ' +
          idleCalibMs / 1000 +
          's | 缓存 ' +
          cacheTtlDays +
          ' 天，每 ' +
          cacheSweepHours +
          ' 小时清理',
      );
    })();
  }

  /**
   * 停：清定时器、置 disposed。
   * 之后**任何**在途的异步回调（读播放器、取歌词、清理）都会在看到 disposed 时直接放弃，
   * 不会再写叶子——所以这里不需要 await，也不需要「等它写完」。
   * stop 是终态：想重启请新建一个 agent（旧实例的叶子显示保持原样，不主动隐藏——
   * 宿主进程要退出时没必要再动一下状态）。
   */
  function stop(): void {
    disposed = true;
    if (tickTimer !== undefined) {
      clearTimeout(tickTimer);
      tickTimer = undefined;
    }
    if (sweepTimer !== undefined) {
      clearTimeout(sweepTimer);
      sweepTimer = undefined;
    }
  }

  async function tickOnce(): Promise<boolean> {
    return runTick();
  }

  return { start, stop, tickOnce };
}

/** 把 unknown 错误折叠成一句能看的话（日志用，不往外抛） */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
