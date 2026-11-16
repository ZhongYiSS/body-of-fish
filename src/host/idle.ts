/**
 * idle.ts —— 问他「多久没动键鼠了」，顺带读一眼前台窗口、浏览器网址和窗口矩形（本鱼 · 11-10 / 11-11 / 11-16）
 *
 * 四段来历：
 *   ① m17986：开口前要判断他在不在操作 —— 用 `GetLastInputInfo`，只回一个毫秒数；
 *   ② m18596：哥哥要「读窗口名 = 知道是什么游戏，然后去查资料」；
 *   ③ m19041：三模式时代要分清网页和视频，于是读了**地址栏里的网址**。11-11 实测：
 *      UI Automation 摸 Edge 的地址栏（`OmniboxViewViews`）能拿到完整 URL，**6~93ms**，
 *      窗口最小化也读得到；前台不是浏览器时干净地读不到，那就当「没有网址」。
 *   ④ m21257 / m21310：哥哥改成「全屏 / 自动 / 窗口」三档取景 —— 要**窗口矩形**才能只截它。
 *      这次**先把进程设成 PER_MONITOR_AWARE_V2** 再 `GetWindowRect`，拿到的就是物理像素，
 *      和 gdigrab 一个口径（11-09 那次没设，逻辑像素差 1.5 倍，只截到左上角）。
 *
 * 开销：一个 PowerShell（`Add-Type` 编译 C# + 可能加载 UIAutomation）约 250~700 ms 一次。
 * 所以：出图时读一次（窗口、网址、矩形一次拿全），读不到就回空串，绝不卡住这一轮说话。
 */
import { execFile } from 'node:child_process';

const NATIVE = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FgProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")]
  public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  public static void Aware() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch {} }
  }
  public static long IdleMs() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref info)) return -1;
    return (long)(uint)Environment.TickCount - (long)info.dwTime;
  }
  public static IntPtr Hwnd() { return GetForegroundWindow(); }
  public static string Title(IntPtr h) {
    StringBuilder sb = new StringBuilder(512);
    if (h != IntPtr.Zero) { GetWindowText(h, sb, 512); }
    return sb.ToString();
  }
  public static string ExeOf(IntPtr h) {
    uint pid = 0;
    if (h != IntPtr.Zero) { GetWindowThreadProcessId(h, out pid); }
    string exe = "";
    try { if (pid != 0) { exe = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } } catch {}
    return exe;
  }
  public static string RectOf(IntPtr h) {
    RECT r;
    if (h == IntPtr.Zero || !GetWindowRect(h, out r)) return "";
    return r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top);
  }
  public static string ScreenSize() {
    RECT r;
    if (!GetWindowRect(GetDesktopWindow(), out r)) return "";
    return (r.Right - r.Left) + "," + (r.Bottom - r.Top);
  }
}
`;

const SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
${NATIVE}
"@
[FgProbe]::Aware()
$h = [FgProbe]::Hwnd()
$title = ([FgProbe]::Title($h) -replace '[<>]', ' ')
$exe = ([FgProbe]::ExeOf($h)).ToLower()
$rect = [FgProbe]::RectOf($h)
$screen = [FgProbe]::ScreenSize()
$url = ''
$browsers = @('msedge','chrome','chromium','brave','opera','vivaldi','iexplore','360se','360chrome','qqbrowser','sogouexplorer','2345explorer','maxthon')
if ($browsers -contains $exe) {
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    if ($root -ne $null) {
      $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'OmniboxViewViews')
      $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
      if ($el -ne $null) {
        $pat = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $url = [string]$pat.Current.Value
      }
    }
  } catch { $url = '' }
  if ($url -eq '' -and $root -ne $null) {
    try {
      $editCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
      $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
      foreach ($item in $edits) {
        try {
          $pat2 = $item.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
          $value = [string]$pat2.Current.Value
          if ($value -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $url = $value; break }
        } catch { }
      }
    } catch { }
  }
}
$url = ($url -replace '', '').Trim()
[Console]::Out.Write(([FgProbe]::IdleMs().ToString()) + '<|>' + $h.ToString() + '<|>' + $title + '<|>' + $exe + '<|>' + $url + '<|>' + $rect + '<|>' + $screen)
`;

/** 枚举可见窗口（给「手动选窗口」用）：每行 `hwnd<|>标题<|>进程<|>x,y,w,h` */
const LIST_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
${NATIVE}
public static class WinList {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public static System.Collections.Generic.List<IntPtr> All() {
    System.Collections.Generic.List<IntPtr> list = new System.Collections.Generic.List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr p) { if (IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
}
"@
[FgProbe]::Aware()
$lines = New-Object System.Collections.Generic.List[string]
foreach ($h in [WinList]::All()) {
  $t = ([FgProbe]::Title($h) -replace '[<>|]', ' ').Trim()
  if ($t -eq '') { continue }
  $exe = ([FgProbe]::ExeOf($h)).ToLower()
  $r = [FgProbe]::RectOf($h)
  $lines.Add($h.ToString() + '<|>' + $t + '<|>' + $exe + '<|>' + $r)
}
[Console]::Out.Write(($lines -join "\`n"))
`;

const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
const listEncoded = Buffer.from(LIST_SCRIPT, 'utf16le').toString('base64');

export interface ForegroundInfo {
  /** 距上次键鼠输入多少毫秒；-1 = 不知道 */
  readonly idleMs: number;
  /** 前台窗口句柄（0 = 没读到）；读地址栏要用它 */
  readonly hwnd: number;
  /** 前台窗口标题（空 = 没读到） */
  readonly title: string;
  /** 前台进程名（不带 .exe，小写，空 = 没读到） */
  readonly exe: string;
  /** 浏览器地址栏里的网址（空 = 不是浏览器 / 读不到） */
  readonly url: string;
  /** 前台窗口矩形（屏幕物理像素）；拿不到就 w/h = 0 */
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** 屏幕尺寸（物理像素）；拿不到就 0 */
  readonly screen: { readonly w: number; readonly h: number };
}

export const UNKNOWN_FOREGROUND: ForegroundInfo = {
  idleMs: -1,
  hwnd: 0,
  title: '',
  exe: '',
  url: '',
  rect: { x: 0, y: 0, w: 0, h: 0 },
  screen: { w: 0, h: 0 },
};

/** 字段分隔符：标题里几乎不可能出现 `<|>`，比竖线安全（Edge 标题里真的有 ` | `） */
const SEP = '<|>';

function toIdle(raw: string): number {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 && n < 4294967294 ? n : -1;
}

function nums(raw: string, count: number): number[] | null {
  const parts = String(raw ?? '').split(',');
  if (parts.length !== count) return null;
  const out = parts.map((p) => Number(p.trim()));
  if (out.some((n) => !Number.isFinite(n))) return null;
  return out;
}

function parseRect(raw: string): ForegroundInfo['rect'] {
  const got = nums(raw, 4);
  if (got === null) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: got[0]!, y: got[1]!, w: Math.max(0, got[2]!), h: Math.max(0, got[3]!) };
}

function parseScreen(raw: string): ForegroundInfo['screen'] {
  const got = nums(raw, 2);
  if (got === null) return { w: 0, h: 0 };
  return { w: Math.max(0, got[0]!), h: Math.max(0, got[1]!) };
}

/**
 * 解析 `idleMs<|>hwnd<|>标题<|>进程名<|>网址<|>x,y,w,h<|>屏w,屏h`。
 * 老格式（11-10 的 `idleMs|标题|进程名`、11-11 的五段）也认，缺的字段给空值。
 */
export function parseForegroundLine(line: string): ForegroundInfo {
  const text = String(line ?? '').trim();
  if (text === '') return UNKNOWN_FOREGROUND;
  if (text.includes(SEP)) {
    const parts = text.split(SEP);
    const idleMs = toIdle(parts[0] ?? '');
    const hwndRaw = Number((parts[1] ?? '').trim());
    const hwnd = Number.isFinite(hwndRaw) && hwndRaw > 0 ? hwndRaw : 0;
    const title = cleanTitle(parts[2] ?? '');
    const exe = (parts[3] ?? '').trim().replace(/\.exe$/iu, '').toLowerCase();
    // 网址里不会出现 `<|>`，所以第 5 段就是网址；第 6、7 段是矩形和屏幕
    const url = (parts[4] ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').trim();
    const rect = parts.length > 5 ? parseRect(parts[5] ?? '') : { x: 0, y: 0, w: 0, h: 0 };
    const screen = parts.length > 6 ? parseScreen(parts[6] ?? '') : { w: 0, h: 0 };
    return { idleMs, hwnd, title, exe, url, rect, screen };
  }
  const first = text.indexOf('|');
  if (first < 0) return { ...UNKNOWN_FOREGROUND, idleMs: toIdle(text) };
  const last = text.lastIndexOf('|');
  return {
    ...UNKNOWN_FOREGROUND,
    idleMs: toIdle(text.slice(0, first)),
    title: text.slice(first + 1, last).trim(),
    exe: text.slice(last + 1).trim().replace(/\.exe$/iu, '').toLowerCase(),
  };
}

function run(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', script],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve('');
            return;
          }
          resolve(String(stdout));
        },
      );
    } catch {
      resolve('');
    }
  });
}

/**
 * 读一次前台窗口 + 空闲时长（浏览器顺带读地址栏，另带窗口矩形与屏幕尺寸）。
 * 任何失败都回 `UNKNOWN_FOREGROUND`，不抛。
 */
export async function readForeground(timeoutMs = 2500): Promise<ForegroundInfo> {
  const stdout = await run(encoded, timeoutMs);
  if (stdout.trim() === '') return UNKNOWN_FOREGROUND;
  return parseForegroundLine(stdout);
}

/** 只要空闲时长那条老接口（保留，别处还在用） */
export async function readIdleMs(timeoutMs = 2500): Promise<number> {
  const info = await readForeground(timeoutMs);
  return info.idleMs;
}

export interface WindowEntry {
  readonly hwnd: number;
  readonly title: string;
  readonly exe: string;
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/** 枚举可见窗口（「手动选窗口」用）；读不到回空数组，不抛 */
/** 标题洗干净：控制字符 / 零宽字符换空格，连续空白压成一个。 */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/[\u200b-\u200f\u2060\ufeff]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export async function listWindows(timeoutMs = 4000): Promise<WindowEntry[]> {
  const stdout = await run(listEncoded, timeoutMs);
  const out: WindowEntry[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const parts = line.trim().split(SEP);
    if (parts.length < 4) continue;
    const hwnd = Number((parts[0] ?? '').trim());
    if (!Number.isFinite(hwnd) || hwnd <= 0) continue;
    out.push({
      hwnd,
      title: cleanTitle(parts[1] ?? ''),
      exe: (parts[2] ?? '').trim().replace(/\.exe$/iu, '').toLowerCase(),
      rect: parseRect(parts[3] ?? ''),
    });
  }
  return out;
}
