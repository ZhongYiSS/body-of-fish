/**
 * screen-target.ts —— 「这一屏归谁」：全屏 / 自动跟窗口 / 手动指定窗口（本鱼 · 11-16 m21257）
 *
 * 为什么换掉旧的 screen-mode（自动 / 游戏 / 视频）：
 *   哥哥 m21257：「去掉游戏模式和视频模式的区别，去掉宫格以后其实没有实际区别了，
 *   这个功能改成识别窗口，【全屏】【自动】【手动】选择窗口……选择窗口的目的是限制截图」。
 *   所以这里不再猜「他在玩还是看」，只回答一个问题：**这一张图截谁**。
 *
 * 三条纪律：
 *   1. 纯函数、零 IO —— 窗口从哪来（PowerShell）由 idle.ts 负责，这里只管挑；
 *   2. 挑不到 / 挑到不该截的（自己、桌面、看图窗口、太小的窗口）→ 一律回 `undefined`，
 *      调用方退回全屏，**绝不拿半个窗口去截图**；
 *   3. 老配置里写的 `game` / `video` 一律当 `auto`，不报错、不迁移、不丢设置。
 */

/** 屏幕坐标下的矩形（物理像素，左上原点） */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 陪伴的三种取景方式：全屏 / 自动跟前台窗口 / 手动指定窗口 */
export type WatchMode = 'full' | 'auto' | 'window';

export const WATCH_MODES: readonly WatchMode[] = ['full', 'auto', 'window'];

/** 配置 / 菜单里读进来的值 → 合法模式；老值 game/video 当自动，认不出也回自动 */
export function normalizeWatchMode(value: unknown): WatchMode {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'full' || text === 'window') return text;
  return 'auto';
}

/** 模式的中文短名（菜单、状态行、提示气泡共用） */
export function watchModeWord(mode: WatchMode): string {
  if (mode === 'full') return '全屏';
  if (mode === 'window') return '窗口';
  return '自动';
}

/** 进程名归一：去路径、去 .exe、小写 */
export function baseExe(exe: string): string {
  const text = String(exe ?? '').trim().toLowerCase();
  const tail = text.includes('\\') || text.includes('/') ? text.split(/[\\/]/u).pop() ?? '' : text;
  return tail.replace(/\.exe$/u, '');
}

/**
 * 我们自己的进程名（桌宠本体）。
 * 自己在前台时窗口名是「dsh-pet 桌宠（桌面模式）」，截自己没有意义。
 */
export const SELF_EXES: readonly string[] = ['bodyoffish', 'body-of-fish', 'dsh-pet', 'dshpet', 'electron'];

export function isSelfExe(exe: string): boolean {
  return SELF_EXES.includes(baseExe(exe));
}

/** 桌面 / 任务栏 / 输入法这类「不是内容」的窗口 */
const IGNORED_TITLES: readonly RegExp[] = [
  /^Program Manager$/iu,
  /^Desktop$/iu,
  /^任务栏$/u,
  /^Windows 输入体验$/u,
  /^Microsoft Text Input Application$/iu,
  /^开始$/u,
  /^搜索$/u,
];

/** 看图 / 图片预览窗口：标题就是一串文件名，不算「在看内容」 */
const IMAGE_TITLE = /\.(?:png|jpe?g|webp|bmp|gif|avif|tiff?)$/iu;

export interface WindowInfo {
  readonly hwnd: number;
  readonly title: string;
  readonly exe: string;
  /** 物理像素；拿不到就 w/h = 0 */
  readonly rect: Rect;
}

/** 这个窗口能不能拿来当取景目标 */
export function isPickableWindow(win: WindowInfo): boolean {
  const title = String(win.title ?? '').trim();
  if (title === '') return false;
  if (isSelfExe(win.exe)) return false;
  if (IGNORED_TITLES.some((re) => re.test(title))) return false;
  if (IMAGE_TITLE.test(title)) return false;
  if (win.rect.w < 240 || win.rect.h < 180) return false;
  return true;
}

/**
 * 从窗口列表里挑一个：优先 `preferredHwnd`（手动指定的那个），
 * 其次是列表里第一个可用的（列表按「前台优先」排）。
 */
export function pickWindow(list: readonly WindowInfo[], preferredHwnd?: number): WindowInfo | undefined {
  if (preferredHwnd !== undefined && preferredHwnd > 0) {
    const hit = list.find((win) => win.hwnd === preferredHwnd);
    if (hit !== undefined && isPickableWindow(hit)) return hit;
  }
  return list.find(isPickableWindow);
}

/** 页面标题里的浏览器尾巴（Edge 会带「个人 / 工作」那一段，还夹着零宽空格） */
const BROWSER_TAILS: readonly RegExp[] = [
  /\s+[-–—]\s+(?:个人|工作|Profile\s*\d+)?\s*[-–—]\s*Microsoft\s?Edge\s*$/iu,
  /\s+[-–—]\s+Microsoft\s?Edge\s*$/iu,
  /\s+[-–—]\s+Google\s?Chrome\s*$/iu,
  /\s+[-–—]\s+Mozilla\s?Firefox\s*$/iu,
  /\s+[-–—]\s+Brave\s*$/iu,
  /\s+[-–—]\s+Opera\s*$/iu,
  /\s*(?:和另外|and)\s*\d+\s*(?:个页面|more pages?)\s*$/iu,
];

/** 站点尾巴（B站最常见，标题后面会挂「_哔哩哔哩_bilibili」） */
const SITE_TAILS: readonly RegExp[] = [
  /\s*_\s*哔哩哔哩\s*_\s*bilibili\s*$/iu,
  /\s*[-–—_|｜]\s*哔哩哔哩(?:\s*_\s*bilibili)?\s*$/iu,
  /\s*[-–—_|｜]\s*YouTube\s*$/iu,
  /\s*[-–—_|｜]\s*爱奇艺\s*$/iu,
  /\s*[-–—_|｜]\s*腾讯视频\s*$/iu,
  /\s*[-–—_|｜]\s*优酷\s*$/iu,
];

/**
 * 窗口标题 → 干净的名字（去掉浏览器尾巴、站点尾巴、零宽空格）。
 * 剥不干净就留原样 —— 宁可多几个字，也别把真正的标题削掉。
 */
export function pageName(title: string): string {
  let text = String(title ?? '').replace(/\u200b/gu, '').replace(/\s+/gu, ' ').trim();
  if (text === '') return '';
  for (let round = 0; round < 2; round += 1) {
    let changed = false;
    for (const re of [...BROWSER_TAILS, ...SITE_TAILS]) {
      const next = text.replace(re, '').trim();
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return text.slice(0, 80);
}

/** 一句话说清「这一屏是什么」——给提示词用，不猜是游戏还是视频 */
export function targetLine(win: WindowInfo | undefined, mode: WatchMode, url = ''): string {
  if (win === undefined) return '（整屏）';
  const name = pageName(win.title);
  const label = name === '' ? baseExe(win.exe) || '（窗口）' : name;
  if (mode === 'full') return `整屏，最前面是：${label}`;
  return `只看这个窗口：${label}${url === '' ? '' : `（${url}）`}`;
}
