/**
 * 「本鱼陪伴」右键菜单：标签生成 + 点击解析（纯函数，零 IO）。
 *
 * 为什么要这个模块：陪伴/歌词这两层菜单原来是**附属插件**（dsh-pet-extras）注册的，
 * 独立版不加载任何 Cordis 插件 → 菜单层连同「陪伴」整层一起消失。现在由宿主自己注册，
 * 一份代码在 DSH 内与独立模式都生效。
 *
 * 菜单树是**壳按 `：` 拼出来的**（`runtime/electron-helper/shared-core.js` 的
 * `buildPetMenuTree`）：owner 必须是 `本鱼陪伴`；标签按全角 `：` 切段，第一段是分组名、
 * 后面拼成子项（`状态：嗓子 · 本地` → 「状态 ▸ 嗓子 · 本地」）。所以标签格式不是随便写的：
 * **一个标签里只能有一个分组冒号**，多一个就会多套一层菜单。
 *
 * 哥哥 10-31 定的层级（壳侧按这里的前缀顺序摆位置）：
 *   一级：状态* / 看一眼 / 陪伴* / 对话 / 碎碎念* / 重载配置 / 点击穿透 / 动作 / 更多*
 *   状态二级：嗓子（本地→云→关 循环） / 眼睛（同上） / 歌词（开关） / 接入
 *   看一眼二级：开关 + 现在看一眼 + 自定义时间…
 *   陪伴二级：开关 + 三档节奏 + 出声
 *   碎碎念二级：自动开/关 + 四档时间 + 打开池子 + 自定义间隔…
 *
 * 约束（`src/host/menu.ts`）：label ≤ 32 字符、同 owner ≤ 20 项、同 owner 内不可重复。
 * 当前最多 12 项、最长 14 字，都留有余量。
 */

import { watchPaceCost, type WatchPace } from './watch-mode';
import { WATCH_MODES, watchModeWord, type WatchMode } from './screen-target';

/** 壳侧认的 owner（`shared-core.js` 的 `COMPANION_OWNER = "本鱼陪伴"`），不可改 */
export const PET_MENU_OWNER = '本鱼陪伴';

/** 分组前缀：状态那一层 */
export const STATE_PREFIX = '状态：';
/** 分组前缀：看一眼档位那一层（11-09 哥哥改名：原来的「陪伴」= 定时截一张，改名「看一眼」） */
export const COMPANION_PREFIX = '看一眼：';
/** 分组前缀：碎碎念那一层 */
export const WHISPER_PREFIX = '碎碎念：';

/** 分组前缀：陪伴（看护）那一层（本鱼 · 11-09：常驻看屏幕、只在真的变了时出图）。
 *  11-09 哥哥改名：这一层挪上来叫「陪伴」，原来那个定时截一张的改叫「看一眼」。 */
export const WATCH_PREFIX = '陪伴：';
/** 旧前缀：改名后的兼容解析（菜单整体覆盖，旧标签最多存活一拍，认一下不花什么） */
const LEGACY_WATCH_PREFIX = '看护：';

/** 陪伴档位：菜单里给的四个间隔（原插件 MENU_SPEC 同款，去掉「关」——关是状态里那项） */
export const COMPANION_INTERVALS: ReadonlyArray<{ readonly label: string; readonly ms: number }> = [
  // 【本鱼 · 11-02 哥哥改】原来四档是 45 秒/1/2/3 分钟，哥哥说「陪伴改成 1、2、3、5 分钟」，
  // 45 秒那档去掉（太碎，识图都来不及）；另加一个「自定义…」自己填分钟数。
  { label: '1 分钟', ms: 60_000 },
  { label: '2 分钟', ms: 120_000 },
  { label: '3 分钟', ms: 180_000 },
  { label: '5 分钟', ms: 300_000 },
];

/**
 * 碎碎念的档位（哥哥 11-01：右键里要能直接调间隔，别再逼人翻设置页）。
 *
 * 为什么是这几个：1 分钟接陪伴的节奏（也是默认），5 分钟算"话多"，1 小时最懒，15/30 日常取中。
 * 值写的是**秒**（配置里 `eventsRefreshSec.whisper` 的单位），标签写成人话。
 */
export const WHISPER_INTERVALS: ReadonlyArray<{ readonly label: string; readonly seconds: number }> = [
  // 【11-01 哥哥第 2 条】默认间隔要和陪伴的节奏接壤 → 补一个 1 分钟档做默认，
  // 这样 60 秒既是"默认值"也是菜单里能直接点到的档位（否则它会一直算"自定义"）。
  { label: '1 分钟', seconds: 60 },
  { label: '5 分钟', seconds: 300 },
  { label: '15 分钟', seconds: 900 },
  { label: '30 分钟', seconds: 1800 },
  { label: '1 小时', seconds: 3600 },
];

/** 识图/声音的后端三态（`off` 是功能关着，不是"没配好"） */
export type BackendWord = 'off' | 'local' | 'remote';

/** 拼菜单标签时需要的运行态（只用来打 ✓ 与显示当前档位，不影响可点性） */
export interface PetMenuState {
  /** 陪伴是否在跑 */
  companionRunning: boolean;
  /** 陪伴当前间隔（毫秒）；跑着时用来显示「开 2 分钟」 */
  companionIntervalMs: number;
  /** 联网查资料的总开关（默认开） */
  lyricRunning: boolean;
  /** 联网查资料的总开关（默认开；只有显式关才是 false） */
  searchEnabled?: boolean;
  /** 看图当前后端（眼睛那一项要显示 关/本地/云） */
  vision?: BackendWord;
  /** 声音当前后端（嗓子那一项要显示 关/本地/云） */
  voice?: BackendWord;
  /** 陪伴已经看过几眼（本次开启以来累计） */
  companionTicks?: number;
  /** 「看一眼」手动点过几次（进程内累计） */
  lookCount?: number;
  /** 自动碎碎念开着没（= 配置里这只宠物的 whisperEnabled） */
  whisperEnabled?: boolean;
  /** 自动碎碎念的间隔秒数（= 配置 eventsRefreshSec.whisper） */
  whisperIntervalSec?: number;
  /** 接入 DSH 的桥（undefined = 桥插件没起/没写发现文件；enabled = 桌宠的回复交给 DSH 本鱼） */
  dshBridge?: {
    /** 桥此刻连不连得上（false = DSH 没开 / 插件没起；菜单标「没连上」） */
    available?: boolean;
    enabled: boolean;
    title: string;
    /** 当前对准的会话名（只用来显示；选会话走网页，不塞进菜单了） */
    selectedTitle?: string;
  };
  /** 看护模式（本鱼 · 11-09）：常驻看屏幕，只在画面真变了时拼 4 帧出一句 */
  watch?: {
    running: boolean;
    pace: WatchPace;
    /** 陪伴要不要出声（哥哥 11-09 晚：单独一个开关，默认关） */
    speak?: boolean;
    /** 三个模式：自动检测 / 游戏 / 视频（哥哥 11-11 m19041） */
    mode?: WatchMode;
  };
}

/** 档位的中文短名（<1 分钟按秒说，整分钟按分钟说） */
function shortTier(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '没开';
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  const min = ms / 60_000;
  return Number.isInteger(min) ? `${min} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

/** 后端三态的中文短名（关 / 本地 / 云） */
export function modeWord(word: BackendWord | undefined): string {
  if (word === 'local') return '本地';
  if (word === 'remote') return '云';
  return '关';
}

/** 后端三态的循环顺序：关 → 本地 → 云 → 关（哥哥 10-31：点一下循环） */
export function nextBackendWord(word: BackendWord): BackendWord {
  if (word === 'off') return 'local';
  if (word === 'local') return 'remote';
  return 'off';
}

/**
 * 一级那条状态（点开是四项）。它只是**分支标题**，壳会把它变成「状态 ▸」，
 * 所以这里给的是标题文本，不需要带当前值——当前值都在子项里。
 */
export const STATE_BRANCH_LABEL = `${STATE_PREFIX}状态`;

/**
 * 点状态分支标题时冒的那句话：四项一起报，一行读完不换行。
 * 分隔符用「｜」：菜单 label 上限 32 字符塞不下，气泡能说整句。
 */
export function petStatusText(facts: {
  companionRunning: boolean;
  companionIntervalMs: number;
  lyricRunning: boolean;
  vision: BackendWord;
  voice: BackendWord;
  /** 看护模式（11-09 起）：没传就当没这功能，旧调用方不用改 */
  watchRunning?: boolean;
  watchPace?: WatchPace;
  /** 陪伴出不出声（11-09 晚加） */
  watchSpeak?: boolean;
  /** 三个模式；auto 不写进状态行（省字数） */
  watchMode?: WatchMode;
}): string {
  const companion = facts.companionRunning ? `开 ${shortTier(facts.companionIntervalMs)}` : '关';
  const modeTail = facts.watchMode !== undefined && facts.watchMode !== 'auto' ? `·${watchModeWord(facts.watchMode)}` : '';
  const watch = facts.watchRunning
    ? `开 ${watchPaceWord(facts.watchPace)}${facts.watchSpeak === true ? '·出声' : ''}${modeTail}`
    : '关';
  return [
    `陪伴：${watch}`,
    `看一眼：${companion}`,
    `歌词：${facts.lyricRunning ? '开' : '关'}`,
    `看图：${modeWord(facts.vision)}`,
    `声音：${modeWord(facts.voice)}`,
  ].join('｜');
}

/** 看护节奏的中文短名（轻 / 正常 / 密） */
export function watchPaceWord(pace: WatchPace | undefined): string {
  if (pace === 'calm') return '轻';
  if (pace === 'dense') return '密';
  return '正常';
}

/**
 * 生成这一拍该注册的**完整**标签列表。
 *
 * 注册语义是「整体覆盖」，所以每次都要给全量：菜单项 = 当下的真实能力清单，
 * 不留下已经停掉却还挂着的僵尸项。
 *
 * 「看一眼：现在看一眼」必须注册：桌面壳的右键根菜单由 `sprite.js` 自己拼一条
 * （11-09 晚起发的是 `看一眼：现在看一眼`；更早是 `陪伴：看一眼`），宿主没注册这一项的话
 * 点了就是 delivered:false —— 点了没反应。
 */
export function petMenuLabels(state: PetMenuState): string[] {
  const companion = state.companionRunning ? `开 ${shortTier(state.companionIntervalMs)}` : '关';
  const labels: string[] = [
    // 状态那一层（壳按 `状态：` 套成一级分支）
    // 【11-09 晚 哥哥 m16044】「陪伴 / 看一眼」的开关挪进各自的一级分支，
    //   一级分支标题直接写状态（壳按第一个全角冒号切，冒号前那段就是一级文字），
    //   这样不开状态层就能看见开没开、点一下就能开关。
    `${STATE_PREFIX}嗓子 · ${modeWord(state.voice)}`,
    `${STATE_PREFIX}眼睛 · ${modeWord(state.vision)}`,
    `${STATE_PREFIX}歌词 · ${state.lyricRunning ? '开' : '关'}`,
    // 【汐儿 · 11-11 m20199】联网查资料：哥哥说放状态子菜单里、默认开
    `${STATE_PREFIX}联网查 · ${state.searchEnabled === false ? '关' : '开'}`,
    // 接入 DSH（哥哥 11-01：状态层里要有一个「把桌宠接到 DSH」的开关）；
    // 11-01 晚改：会话一多，菜单里一条一个就翻不动了 → 只留「选会话…」（开网页选），
    // 开关标签里带上当前接的那个会话短名，一眼能看出接的是谁。
    // 装插件这一项不依赖桥是否已连上：新用户第一次用就是靠它把插件装进 DSH。
    `${STATE_PREFIX}接入 · 装插件到 DSH…`,
    ...(state.dshBridge
      ? [
          // 11-03：available=false 时不再用「开/关」的确定语气 —— DSH 没开是「没连上」，
          // 不是用户把它关了；点开关会提示「先把 DSH 打开」。
          `${STATE_PREFIX}接入 · ${
            state.dshBridge.available === false
              ? '⚠ 没连上 DSH'
              : state.dshBridge.enabled
                ? `✓ 开（${state.dshBridge.selectedTitle || state.dshBridge.title || '未知'}）`
                : '关'
          }`,
          `${STATE_PREFIX}接入 · 选会话…`,
        ]
      : []),
  ];
  // 一眼那一层（哥哥 11-09 晚：时长只要「自定义时间」，不再列 1/2/3/5 分钟）
  // 11-09 晚 m16044：分支标题带状态，开关就在分支里（第一项），不用再进状态层。
  // 11-09 晚 m16273：关着的时候一级也要能看见「配的多久看一次」，
  //   不然一级只写「关」，得进去才知道自己设的是 2 分钟还是 30 秒。
  const lookTier = shortTier(state.companionIntervalMs);
  const lookHead = state.companionRunning
    ? `看一眼 · 开 ${lookTier}`
    : state.companionIntervalMs > 0
      ? `看一眼 · 关（${lookTier}）`
      : '看一眼 · 关';
  labels.push(`${lookHead}：${state.companionRunning ? '✓ 开着（点一下关）' : '开（点一下开）'}`);
  labels.push(`${lookHead}：现在看一眼`);
  labels.push(`${lookHead}：自定义时间…`);
  // 陪伴那一层（11-09）：三档节奏 + 出声 + 开关（标题带状态，开关在分支第一项）。
  // 同上：关着也要看见当前档位（哥哥 11-09 晚 m16273）
  // 【汐儿 · 11-11 m19216】哥哥要的头是「陪伴 · 游戏/视频 · 开/关（正常/密）」——
  //   模式和档位都摆到一级，一眼就知道她在按哪套规则盯、现在开没开。
  const watchModeNow: WatchMode = state.watch?.mode ?? 'auto';
  // 【汐儿 · 11-17 m25895 A 方案】取景三档提到一级：一眼看与陪伴都受它控制。
  //   陪伴标题因此不再重复模式词（原来「陪伴 · 自动 · 开（正常）」，现在「陪伴 · 开（正常）」）。
  for (const mode of WATCH_MODES) {
    const mark = watchModeNow === mode ? '✓ ' : '';
    labels.push(`取景：${mark}${watchModeWord(mode)}`);
  }
  // 「看他看到的（记录目录）…」也归到取景这一层：它记录的就是按这套取景看到的东西
  labels.push('取景：看他看到的（记录目录）…');
  const watchHead = state.watch
    ? `陪伴 · ${state.watch.running ? '开' : '关'}（${watchPaceWord(state.watch.pace)}）`
    : '陪伴 · 关';
  labels.push(`${watchHead}：${state.watch?.running ? '✓ 开着（点一下关）' : '开（点一下开）'}`);
  for (const pace of ['calm', 'normal', 'dense'] as const) {
    const active = state.watch?.running === true && state.watch.pace === pace;
    // 11-09 晚：哥哥说「轻/正常/密」看不出账单，标签里带上每分钟最多几张
    labels.push(`${watchHead}：${active ? '✓ ' : ''}${watchPaceWord(pace)}（${watchPaceCost(pace)}）`);
  }
  const watchSpeak = state.watch?.speak === true;
  // 11-09 晚 m16399：哥哥点了「出声（点一下开）」反而关掉声音——旧文案像「点一下打开」，
  //   实际是开关。改成把当前状态和点下去的结果都写清楚。
  labels.push(`${watchHead}：${watchSpeak ? '✓ 会出声（点一下静音）' : '不出声（点一下开）'}`);

  // 碎碎念那一层：开关只有一项，带 ✓ 的那项就是"关掉它"——菜单里不许有点不动的东西
  // 【11-03 哥哥「30 秒碎碎念疑似没生效」】旧文案「✓ 自动关」读起来像"自动关着"，
  //   明明开着却让人以为没生效。改成「✓ 自动开（点一下关）」——状态和动作都写清楚。
  labels.push(state.whisperEnabled === true ? '碎碎念：✓ 自动开（点一下关）' : '碎碎念：自动关（点一下开）');
  // 哥哥 11-09 晚：五档全收进小窗，菜单只留一行「间隔（现在多少秒）…」
  // 池子那一项的说明放在池子文件里（见 openWhisperPool 写示例时的注释）；
  // 菜单只有 32 字，写不下路径，所以这里只留"打开池子"。
  labels.push('碎碎念：打开池子');
  // 【10-30 哥哥第 1 条】菜单里要能**手填秒数**：右键菜单只能点 label，所以这一项打开一个
  // 只有「一个输入框 + 保存」的小窗（宿主用浏览器打开），和上面四档写的是同一个字段。
  // 【11-01 哥哥第 2 条】这一项后面要跟上「现在是多少秒」，且当前不是四档之一时打 ✓
  //   —— 否则自定义过的间隔在菜单里看起来像"没设置"。
  const customSec = Number.isFinite(state.whisperIntervalSec) ? Math.round(Number(state.whisperIntervalSec)) : 0;
  labels.push(`碎碎念：间隔（${customSec} 秒）…`);
  return labels;
}

/** 一次菜单点击要做的动作（解析结果，交给宿主执行） */
export type PetMenuAction =
  | { readonly kind: 'look' }
  | { readonly kind: 'status'; readonly text: string }
  | { readonly kind: 'companion-start'; readonly intervalMs: number }
  | { readonly kind: 'companion-custom' }
  | { readonly kind: 'companion-stop' }
  | { readonly kind: 'companion-toggle' }
  | { readonly kind: 'lyric-start' }
  | { readonly kind: 'lyric-stop' }
  | { readonly kind: 'lyric-toggle' }
  /** 状态层第四项：联网查资料（默认开，哥哥 11-11 m20199 放状态子菜单） */
  | { readonly kind: 'search-toggle' }
  | { readonly kind: 'cycle-vision' }
  | { readonly kind: 'cycle-voice' }
  | { readonly kind: 'whisper-enable' }
  | { readonly kind: 'whisper-disable' }
  | { readonly kind: 'whisper-interval'; readonly seconds: number }
  | { readonly kind: 'whisper-pool' }
  | { readonly kind: 'whisper-custom' }
  | { readonly kind: 'speak' }
  | { readonly kind: 'dsh-toggle' }
  | { readonly kind: 'dsh-picker' }
  | { readonly kind: 'dsh-install' }
  | { readonly kind: 'watch-start'; readonly pace: WatchPace }
  | { readonly kind: 'watch-stop' }
  | { readonly kind: 'watch-toggle' }
  | { readonly kind: 'watch-voice-toggle' }
  /** 三个模式：自动检测 / 游戏 / 视频（哥哥 11-11 m19041） */
  | { readonly kind: 'watch-mode'; readonly mode: WatchMode }
  /** 打开陪伴现场记录（jsonl + 拼图），哥哥 11-09 晚要看「她到底看了什么」 */
  | { readonly kind: 'watch-open-log' };

/** `看一眼：✓ 开 1 分钟` / `看一眼：开 1 分钟`（旧的 `陪伴：开 …` 也认） → 档位毫秒数 */
const COMPANION_START = /^(?:看一眼|陪伴)：(?:✓\s*)?开\s*(.+)$/;
/** `状态：看一眼 · 开 2 分钟` / `状态：看一眼 · 关` */
const STATE_COMPANION = /^状态：看一眼\s*·/;
/** `状态：嗓子 · …` / `状态：眼睛 · …` / `状态：歌词 · …` */
const STATE_VOICE = /^状态：嗓子\s*·/;
const STATE_VISION = /^状态：眼睛\s*·/;
const STATE_LYRIC = /^状态：歌词\s*·/;
const STATE_SEARCH = /^状态：联网查\s*·/;
/** `状态：接入 · …`（两个空格容忍） */
const STATE_DSH = /^状态：接入\s*·/;
/** `状态：陪伴 · 开 正常` / `状态：陪伴 · 关`（11-09 改名：原「看护」） */
const STATE_WATCH = /^状态：(?:游戏)?陪伴\s*·/;

/**
 * 标签 → 动作。认不出的（第三方/旧版本残留）返回 null，调用方静默忽略。
 *
 * 前缀上的 ✓ 要一起容忍：那只是当前档位的视觉标记，点它等于重新选这一档（幂等）。
 * 状态里那三项**不看写的是"开"还是"关"**：点一下就是切到下一个状态，
 * 当前值只用来显示——这样不怕壳把旧标签回传回来。
 */
export function parsePetMenuLabel(label: string): PetMenuAction | null {
  const raw = typeof label === 'string' ? label.trim() : '';
  if (raw === '') return null;
  // 【11-09 晚 m16044】一级分支标题带状态（`看一眼 · 开 2 分钟：现在看一眼`），
  // 解析前先把冒号前那段里的「 · 状态」剥掉，后面的规则全部照旧认。
  // 【汐儿 · 11-10 m17982】这一层改名「游戏陪伴」，解析时统一切回「陪伴」，老标签继续认
  const text = raw
    .replace(/^游戏陪伴\s*·[^：]*：/u, '陪伴：')
    .replace(/^(看一眼|陪伴)\s*·[^：]*：/u, '$1：');
  if (STATE_COMPANION.test(text)) return { kind: 'companion-toggle' };
  if (STATE_VOICE.test(text)) return { kind: 'cycle-voice' };
  if (STATE_VISION.test(text)) return { kind: 'cycle-vision' };
  if (STATE_LYRIC.test(text)) return { kind: 'lyric-toggle' };
  if (STATE_SEARCH.test(text)) return { kind: 'search-toggle' };
  if (STATE_WATCH.test(text)) return { kind: 'watch-toggle' };
  if (STATE_DSH.test(text)) {
    // 一条开关（`… · 关` / `… · ✓ 开（会话名）`），一条「选会话…」（开网页挑）
    const rest = text.replace(/^状态：接入\s*·\s*/u, '').replace(/^✓\s*/u, '').trim();
    if (rest === '关' || rest === '开' || rest.startsWith('开（')) return { kind: 'dsh-toggle' };
    // 「装插件到 DSH…」：把安装包里带的桥插件拷进 ~/.dsh/plugins 并写进 profile（哥哥 11-02 方案 A）
    if (rest.startsWith('装插件')) return { kind: 'dsh-install' };
    return { kind: 'dsh-picker' };
  }
  if (text.startsWith(STATE_PREFIX)) return { kind: 'status', text: text.slice(STATE_PREFIX.length) };
  if (text === '看一眼：现在看一眼' || text === '陪伴：看一眼') return { kind: 'look' };
  // 11-09 晚 m16044：一级分支里的开关（标题带状态，剥完就是这两条）
  if (text === '看一眼：✓ 开着（点一下关）' || text === '看一眼：关掉') return { kind: 'companion-stop' };
  if (text === '看一眼：开（点一下开）') return { kind: 'companion-toggle' };
  if (text === '陪伴：✓ 开着（点一下关）' || text === '陪伴：关掉' || text === '看护：关看护') {
    return { kind: 'watch-stop' };
  }
  if (text === '陪伴：开（点一下开）') return { kind: 'watch-toggle' };
  if (text === '陪伴：关陪伴') return { kind: 'companion-stop' };
  if (text === '歌词：开歌词') return { kind: 'lyric-start' };
  if (text === '歌词：关歌词' || text === '歌词：✓ 关歌词') return { kind: 'lyric-stop' };
  if (text === '声音：说一句') return { kind: 'speak' };
  if (text === '碎碎念：自动开' || text === '碎碎念：自动关（点一下开）') return { kind: 'whisper-enable' };
  if (text === '碎碎念：✓ 自动关' || text === '碎碎念：✓ 自动开（点一下关）') return { kind: 'whisper-disable' };
  if (text === '碎碎念：打开池子' || text === '碎碎念：✓ 打开池子') return { kind: 'whisper-pool' };
  if (
    text === '陪伴：✓ 会出声（点一下静音）' ||
    text === '陪伴：不出声（点一下开）' ||
    text === '陪伴：✓ 出声（点一下关）' ||
    text === '陪伴：出声（点一下开）'
  ) {
    return { kind: 'watch-voice-toggle' };
  }
  if (text === '陪伴：看他看到的（记录目录）…') return { kind: 'watch-open-log' };
  // 【汐儿 · 11-17 m25895 A 方案】一级「取景」层（全屏 / 自动 / 窗口 / 记录目录）
  if (text.startsWith('取景：')) {
    const rest = text.slice('取景：'.length).replace(/^✓\s*/u, '').trim();
    if (rest === '全屏') return { kind: 'watch-mode', mode: 'full' };
    if (rest === '自动') return { kind: 'watch-mode', mode: 'auto' };
    if (rest === '窗口') return { kind: 'watch-mode', mode: 'window' };
    if (rest.startsWith('看他看到的')) return { kind: 'watch-open-log' };
    return null;
  }
  const watchPrefix = text.startsWith(WATCH_PREFIX)
    ? WATCH_PREFIX
    : text.startsWith(LEGACY_WATCH_PREFIX)
      ? LEGACY_WATCH_PREFIX
      : '';
  if (watchPrefix !== '') {
    // 标签尾巴可能带「（最多 4 张/分）」，解析前先摘掉（哥哥 11-09 要的账单）
    const rest = text
      .slice(watchPrefix.length)
      .replace(/^✓\s*/, '')
      .replace(/[（(].*$/, '')
      .trim();
    if (rest === '轻') return { kind: 'watch-start', pace: 'calm' };
    if (rest === '正常') return { kind: 'watch-start', pace: 'normal' };
    if (rest === '密') return { kind: 'watch-start', pace: 'dense' };
    const modeHit = /^模式\s*(?:✓\s*)?(全屏|自动|窗口)$/u.exec(rest);
    if (modeHit) {
      const word = modeHit[1];
      return { kind: 'watch-mode', mode: word === '全屏' ? 'full' : word === '窗口' ? 'window' : 'auto' };
    }
    return null;
  }
  if (text.startsWith(WHISPER_PREFIX)) {
    const rest = text.slice(WHISPER_PREFIX.length).replace(/^✓\s*/, '').trim();
    // 「间隔（420 秒）…」/「自定义（420 秒）」/ 老文案「自定义间隔…」都算打开小窗
    if (rest.startsWith('间隔') || rest.startsWith('自定义')) return { kind: 'whisper-custom' };
    const hit = WHISPER_INTERVALS.find((item) => item.label === rest);
    return hit ? { kind: 'whisper-interval', seconds: hit.seconds } : null;
  }
  const start = COMPANION_START.exec(text);
  // 「陪伴：自定义…」不带「开」，要在正则之前单独认（哥哥 11-02 报：点了没窗口）
  if (/^(?:看一眼|陪伴)：(?:✓\s*)?自定义/.test(text)) return { kind: 'companion-custom' };
  if (start) {
    const tier = start[1].trim();
    if (tier.startsWith('自定义')) return { kind: 'companion-custom' };
    const hit = COMPANION_INTERVALS.find((item) => item.label === tier);
    return hit ? { kind: 'companion-start', intervalMs: hit.ms } : null;
  }
  return null;
}

/** 点完之后冒给用户的一句话（菜单只点一下，没有第二个界面能说明结果） */
export function petMenuFeedback(
  action: PetMenuAction,
  result: { ok: boolean; message?: string },
): string {
  if (!result.ok) return result.message ?? '没成功（原因不明）';
  switch (action.kind) {
    case 'look':
      return '看了一眼'; // 实际文案由识图结果覆盖，这里只是兜底
    case 'status':
      // 状态文案由宿主按**当下真实状态**拼好放进 message（陪伴/歌词/看图/声音四项）
      return result.message ?? action.text;
    case 'companion-start':
      return `看一眼开了：每 ${Math.round(action.intervalMs / 1000)} 秒看一次`;
    case 'companion-custom':
      return '自定义窗口打开了：填分钟数点保存';
    case 'companion-stop':
      return '看一眼停了';
    // 开关类：宿主会把「切换成了什么」放进 message（例：嗓子切换为本地）
    case 'companion-toggle':
    case 'lyric-toggle':
    case 'search-toggle':
    case 'cycle-vision':
    case 'cycle-voice':
      return result.message ?? '切换好了';
    case 'lyric-start':
      return '歌词气泡开了';
    case 'lyric-stop':
      return '歌词气泡关了';
    case 'whisper-enable':
      return '碎碎念开了';
    case 'whisper-disable':
      return '碎碎念关了';
    case 'whisper-interval':
      return result.message ?? `碎碎念改成每 ${WHISPER_INTERVALS.find((item) => item.seconds === action.seconds)?.label ?? `${action.seconds} 秒`}一次`;
    case 'whisper-pool':
      return result.message ?? '池子打开了';
    case 'whisper-custom':
      return result.message ?? '小窗打开了：填秒数点保存';
    case 'speak':
      return result.message ?? '说完了';
    case 'dsh-toggle':
      return result.message ?? '接入切换好了';
    case 'dsh-picker':
      return result.message ?? '选会话的页面打开了';
    case 'dsh-install':
      return result.message ?? '插件装好了，重启 DSH 生效';
    case 'watch-start':
      return result.message ?? `陪伴开了（${watchPaceWord(action.pace)}）：屏幕真有变化才说`;
    case 'watch-stop':
      return '陪伴停了';
    case 'watch-toggle':
      return result.message ?? '陪伴切换好了';
    case 'watch-voice-toggle':
      return result.message ?? '陪伴的声音切换好了';
    case 'watch-mode':
      return result.message ?? `陪伴换成「${watchModeWord(action.mode)}」模式了`;
    case 'watch-open-log':
      return result.message ?? '记录目录打开了';
  }
}
