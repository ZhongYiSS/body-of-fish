/**
 * 「他这会儿」那几行（哥哥 11-19 m30766/m30770 批准的 ①②③）：
 *   ① 窗口切换时间线：14:02 写文档 → 14:05 看视频
 *   ② 离开多久：键盘刚动过 / 3 分钟没动
 *   ③ 窗口形状 + 屏幕尺寸：铺满整屏 / 窗口 1941×1243
 *
 * 干什么：把「光是画面看不出来、但她该知道」的上下文压成一两行塞进陪伴提示词。
 * 什么时候用：陪伴每次出图（watchSheet）前拼一次；纯函数，不读盘、不起进程。
 * 什么时候别用：手动「看一眼」不用——那边只看当前这一屏，不需要时间线。
 * 常见坑：
 *   1. 时间线要按「标签变了才记」，同一窗口反复刷新不能刷出一堆同名的；
 *   2. 只留最近 30 分钟、最多 4 段（再长就是废话，还烧 token）；
 *   3. `idleMs < 0` 表示没读到（PowerShell 失败），这时什么都别写，别瞎猜「他离开了」。
 */

export interface TimelineEntry {
  /** 毫秒时间戳 */
  at: number;
  /** 简短的名字（窗口/页面名，不带浏览器尾巴） */
  label: string;
}

export const TIMELINE_MAX = 8;
export const TIMELINE_WINDOW_MS = 30 * 60_000;
export const TIMELINE_SHOW = 4;

/** `HH:MM`（本地时区）。 */
export function clock(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 记一段：和上一段同名就不记；只留最近 max 段。 */
export function pushTimeline(
  list: readonly TimelineEntry[],
  entry: TimelineEntry,
  max = TIMELINE_MAX,
): TimelineEntry[] {
  const label = entry.label.trim();
  if (label === '') return list.slice();
  const last = list[list.length - 1];
  if (last !== undefined && last.label === label) return list.slice();
  const next = [...list, { at: entry.at, label }];
  return next.slice(Math.max(0, next.length - max));
}

/** 「14:02 写文档 → 14:05 看视频」；没有或全过期就空串。 */
export function timelineLine(
  list: readonly TimelineEntry[],
  now: number,
  windowMs = TIMELINE_WINDOW_MS,
): string {
  const fresh = list.filter((item) => now - item.at <= windowMs && now - item.at >= 0);
  if (fresh.length === 0) return '';
  const shown = fresh.slice(-TIMELINE_SHOW);
  return shown.map((item) => `${clock(item.at)} ${item.label}`).join(' → ');
}

/** 「1 分钟没动键盘」/「刚碰过键盘」/ 空串（没读到就不写）。 */
export function idleLine(idleMs: number): string {
  if (!Number.isFinite(idleMs) || idleMs < 0) return '';
  const min = Math.floor(idleMs / 60_000);
  if (min >= 10) return `${min} 分钟没动键盘`;
  if (min >= 1) return `${min} 分钟没动键盘`;
  return '刚碰过键盘';
}

/** 「铺满整屏」/「窗口 1941×1243」/ 空串。 */
export function shapeLine(
  rect: { w: number; h: number } | null,
  screen: { w: number; h: number } | null,
): string {
  if (rect === null || rect.w <= 0 || rect.h <= 0) return '';
  const size = `${Math.round(rect.w)}×${Math.round(rect.h)}`;
  if (screen !== null && screen.w > 0 && screen.h > 0) {
    const cover = (rect.w * rect.h) / (screen.w * screen.h);
    if (cover >= 0.92) return `铺满整屏（屏幕 ${Math.round(screen.w)}×${Math.round(screen.h)}）`;
    return `窗口 ${size}，屏幕 ${Math.round(screen.w)}×${Math.round(screen.h)}`;
  }
  return `窗口 ${size}`;
}

export interface ContextInput {
  timeline: readonly TimelineEntry[];
  idleMs: number;
  rect: { w: number; h: number } | null;
  screen: { w: number; h: number } | null;
  now: number;
}

/** 拼成一行；都没有就空串（空串时调用方别往提示词里塞空行）。 */
export function contextLine(input: ContextInput): string {
  const parts = [
    timelineLine(input.timeline, input.now),
    idleLine(input.idleMs),
    shapeLine(input.rect, input.screen),
  ].filter((item) => item !== '');
  return parts.join('｜');
}

/**
 * 现读一次前台，拼成「14:02 写文档 → 刚碰过键盘｜窗口 1941×1243」。
 *
 * 干什么：给「他这会儿」做一份**所有调用方共用**的入口（哥哥 m31134：不只陪伴要）。
 * 什么时候用：聊天 / 一眼看 / 回看 / 说一句 各自调模型之前调一次。
 * 什么时候别用：陪伴（watchSheet）已有自己的时间线与裁剪，别重复读。
 * 常见坑：
 *   1. 不缓存——前台读一次几十毫秒，缓存反而会把时间线串乱；
 *   2. 读不到就回空串，调用方别往提示词里塞空行；
 *   3. `title` 要洗（用 pageName），否则浏览器尾巴会进模型。
 */
export interface LiveForegroundLike {
  title: string;
  idleMs: number;
  rect: { w: number; h: number } | null;
  screen: { w: number; h: number } | null;
  /** 进程名（explorer、msedge…）：没有窗口标题时用它兜一个名字（11-22 m35769） */
  exe?: string;
}

export interface LiveContextDeps {
  readForeground: (timeoutMs?: number) => Promise<LiveForegroundLike>;
  /** 把这次的窗口名记进调用方那份时间线 */
  remember: (label: string, at: number) => void;
  /** 取调用方那份时间线 */
  timeline: () => readonly TimelineEntry[];
  /** 洗标题（一般是 pageName）；不给就 trim */
  tidy?: (title: string) => string;
  now?: number;
}

export interface LiveContextResult {
  /** 拼好的一行；读不到就是空串 */
  line: string;
  /** 量到的键鼠空闲毫秒；-1 = 没读到 */
  idleMs: number;
  /** 洗完的窗口名；空串 = 没读到 */
  title: string;
}

/**
 * 进程名 → 人话（【汐儿 · 11-22 m35769】哥哥问「读窗口名生效了吗」）。
 * 前台没标题时（任务栏 / 桌面 / 刚切过去），只剩形状没有名字，她只能说「不知道」——
 * 用进程名兜一句「资源管理器」比空着强。
 */
const EXE_LABELS: Record<string, string> = {
  explorer: '资源管理器',
  msedge: 'Edge',
  chrome: 'Chrome',
  firefox: 'Firefox',
  code: 'VS Code',
  windowsterminal: '终端',
  cmd: '命令提示符',
  powershell: 'PowerShell',
  notepad: '记事本',
  'battle.net': '战网',
  steam: 'Steam',
  potplayermini64: 'PotPlayer',
  vlc: 'VLC',
  'deepseek harness': 'DSH',
  bodyoffish: '本鱼陪伴',
  applicationframehost: '系统设置',
  systemsettings: '设置',
};

/** 拿不到窗口标题时用什么顶上（进程名认识就给中文，不认识就给 exe 原名；都没有就空串） */
export function exeLabel(exe: string): string {
  const key = String(exe ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/u, '');
  if (key === '') return '';
  return EXE_LABELS[key] ?? key;
}

export async function readLiveContext(deps: LiveContextDeps): Promise<LiveContextResult> {
  const at = deps.now ?? Date.now();
  let fg: LiveForegroundLike;
  try {
    fg = await deps.readForeground(1_200);
  } catch {
    return { line: '', idleMs: -1, title: '' };
  }
  const tidy = deps.tidy ?? ((title: string): string => String(title ?? '').trim());
  const raw = tidy(fg.title ?? '');
  // 标题为空时退到进程名（任务栏、桌面这些本来就没有标题）
  const title = raw !== '' ? raw : exeLabel(fg.exe ?? '');
  if (title !== '') deps.remember(title, at);
  const line = contextLine({
    timeline: deps.timeline(),
    idleMs: fg.idleMs,
    rect: fg.rect ?? null,
    screen: fg.screen ?? null,
    now: at,
  });
  return { line, idleMs: fg.idleMs, title };
}
