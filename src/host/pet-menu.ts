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
 *   状态二级：陪伴（开关） / 嗓子（本地→云→关 循环） / 眼睛（同上） / 歌词（开关）
 *   陪伴二级：四档时间 + 关陪伴
 *   碎碎念二级：自动开/关 + 四档时间 + 打开池子 + 自定义间隔…
 *
 * 约束（`src/host/menu.ts`）：label ≤ 32 字符、同 owner ≤ 20 项、同 owner 内不可重复。
 * 当前最多 12 项、最长 14 字，都留有余量。
 */

/** 壳侧认的 owner（`shared-core.js` 的 `COMPANION_OWNER = "本鱼陪伴"`），不可改 */
export const PET_MENU_OWNER = '本鱼陪伴';

/** 分组前缀：状态那一层 */
export const STATE_PREFIX = '状态：';
/** 分组前缀：陪伴档位那一层 */
export const COMPANION_PREFIX = '陪伴：';
/** 分组前缀：碎碎念那一层 */
export const WHISPER_PREFIX = '碎碎念：';

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
  /** 歌词气泡是否在跑 */
  lyricRunning: boolean;
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
    enabled: boolean;
    title: string;
    /** 当前对准的会话名（只用来显示；选会话走网页，不塞进菜单了） */
    selectedTitle?: string;
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
}): string {
  const companion = facts.companionRunning ? `开 ${shortTier(facts.companionIntervalMs)}` : '关';
  return [
    `陪伴：${companion}`,
    `歌词：${facts.lyricRunning ? '开' : '关'}`,
    `看图：${modeWord(facts.vision)}`,
    `声音：${modeWord(facts.voice)}`,
  ].join('｜');
}

/**
 * 生成这一拍该注册的**完整**标签列表。
 *
 * 注册语义是「整体覆盖」，所以每次都要给全量：菜单项 = 当下的真实能力清单，
 * 不留下已经停掉却还挂着的僵尸项。
 *
 * 「看一眼」必须注册：桌面壳的右键根菜单里写死了一条 `{owner:'本鱼陪伴', send:'陪伴：看一眼'}`
 * （`sprite.js`），宿主没注册这一项的话点了就是 delivered:false —— 点了没反应。
 */
export function petMenuLabels(state: PetMenuState): string[] {
  const companion = state.companionRunning ? `开 ${shortTier(state.companionIntervalMs)}` : '关';
  const labels: string[] = [
    // 状态那一层（壳按 `状态：` 套成一级分支）
    `${STATE_PREFIX}陪伴 · ${companion}`,
    `${STATE_PREFIX}嗓子 · ${modeWord(state.voice)}`,
    `${STATE_PREFIX}眼睛 · ${modeWord(state.vision)}`,
    `${STATE_PREFIX}歌词 · ${state.lyricRunning ? '开' : '关'}`,
    // 接入 DSH（哥哥 11-01：状态层里要有一个「把桌宠接到 DSH」的开关）；
    // 11-01 晚改：会话一多，菜单里一条一个就翻不动了 → 只留「选会话…」（开网页选），
    // 开关标签里带上当前接的那个会话短名，一眼能看出接的是谁。
    // 装插件这一项不依赖桥是否已连上：新用户第一次用就是靠它把插件装进 DSH。
    `${STATE_PREFIX}接入 · 装插件到 DSH…`,
    ...(state.dshBridge
      ? [
          `${STATE_PREFIX}接入 · ${state.dshBridge.enabled ? `✓ 开（${state.dshBridge.selectedTitle || state.dshBridge.title || '未知'}）` : '关'}`,
          `${STATE_PREFIX}接入 · 选会话…`,
        ]
      : []),
    // 「看一眼」：桌面壳一级菜单里写死了，这里必须注册，否则点了没反应
    '陪伴：看一眼',
  ];
  // 陪伴档位那一层
  for (const item of COMPANION_INTERVALS) {
    const active = state.companionRunning && state.companionIntervalMs === item.ms;
    labels.push(`${COMPANION_PREFIX}${active ? '✓ ' : ''}开 ${item.label}`);
  }
  labels.push(`${COMPANION_PREFIX}自定义…`);
  if (state.companionRunning) labels.push(`${COMPANION_PREFIX}关陪伴`);
  // 碎碎念那一层：开关只有一项，带 ✓ 的那项就是"关掉它"——菜单里不许有点不动的东西
  labels.push(state.whisperEnabled === true ? '碎碎念：✓ 自动关' : '碎碎念：自动开');
  for (const item of WHISPER_INTERVALS) {
    // ✓ 只挂在**实际生效**的那一档上；没开自动时也照样显示（调完间隔再开也看得懂）
    labels.push(`碎碎念：${state.whisperIntervalSec === item.seconds ? '✓ ' : ''}${item.label}`);
  }
  // 池子那一项的说明放在池子文件里（见 openWhisperPool 写示例时的注释）；
  // 菜单只有 32 字，写不下路径，所以这里只留"打开池子"。
  labels.push('碎碎念：打开池子');
  // 【10-30 哥哥第 1 条】菜单里要能**手填秒数**：右键菜单只能点 label，所以这一项打开一个
  // 只有「一个输入框 + 保存」的小窗（宿主用浏览器打开），和上面四档写的是同一个字段。
  // 【11-01 哥哥第 2 条】这一项后面要跟上「现在是多少秒」，且当前不是四档之一时打 ✓
  //   —— 否则自定义过的间隔在菜单里看起来像"没设置"。
  const customSec = Number.isFinite(state.whisperIntervalSec) ? Math.round(Number(state.whisperIntervalSec)) : 0;
  const isPreset = WHISPER_INTERVALS.some((item) => item.seconds === customSec);
  labels.push(`碎碎念：${isPreset ? '' : '✓ '}自定义（${customSec} 秒）`);
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
  | { readonly kind: 'dsh-install' };

/** `陪伴：✓ 开 1 分钟` / `陪伴：开 1 分钟` → 档位毫秒数 */
const COMPANION_START = /^陪伴：(?:✓\s*)?开\s*(.+)$/;
/** `状态：陪伴 · 开 2 分钟` / `状态：陪伴 · 关` */
const STATE_COMPANION = /^状态：陪伴\s*·/;
/** `状态：嗓子 · …` / `状态：眼睛 · …` / `状态：歌词 · …` */
const STATE_VOICE = /^状态：嗓子\s*·/;
const STATE_VISION = /^状态：眼睛\s*·/;
const STATE_LYRIC = /^状态：歌词\s*·/;
/** `状态：接入 · …`（两个空格容忍） */
const STATE_DSH = /^状态：接入\s*·/;

/**
 * 标签 → 动作。认不出的（第三方/旧版本残留）返回 null，调用方静默忽略。
 *
 * 前缀上的 ✓ 要一起容忍：那只是当前档位的视觉标记，点它等于重新选这一档（幂等）。
 * 状态里那三项**不看写的是"开"还是"关"**：点一下就是切到下一个状态，
 * 当前值只用来显示——这样不怕壳把旧标签回传回来。
 */
export function parsePetMenuLabel(label: string): PetMenuAction | null {
  const text = typeof label === 'string' ? label.trim() : '';
  if (text === '') return null;
  if (STATE_COMPANION.test(text)) return { kind: 'companion-toggle' };
  if (STATE_VOICE.test(text)) return { kind: 'cycle-voice' };
  if (STATE_VISION.test(text)) return { kind: 'cycle-vision' };
  if (STATE_LYRIC.test(text)) return { kind: 'lyric-toggle' };
  if (STATE_DSH.test(text)) {
    // 一条开关（`… · 关` / `… · ✓ 开（会话名）`），一条「选会话…」（开网页挑）
    const rest = text.replace(/^状态：接入\s*·\s*/u, '').replace(/^✓\s*/u, '').trim();
    if (rest === '关' || rest === '开' || rest.startsWith('开（')) return { kind: 'dsh-toggle' };
    // 「装插件到 DSH…」：把安装包里带的桥插件拷进 ~/.dsh/plugins 并写进 profile（哥哥 11-02 方案 A）
    if (rest.startsWith('装插件')) return { kind: 'dsh-install' };
    return { kind: 'dsh-picker' };
  }
  if (text.startsWith(STATE_PREFIX)) return { kind: 'status', text: text.slice(STATE_PREFIX.length) };
  if (text === '陪伴：看一眼') return { kind: 'look' };
  if (text === '陪伴：关陪伴') return { kind: 'companion-stop' };
  if (text === '歌词：开歌词') return { kind: 'lyric-start' };
  if (text === '歌词：关歌词' || text === '歌词：✓ 关歌词') return { kind: 'lyric-stop' };
  if (text === '声音：说一句') return { kind: 'speak' };
  if (text === '碎碎念：自动开') return { kind: 'whisper-enable' };
  if (text === '碎碎念：✓ 自动关') return { kind: 'whisper-disable' };
  if (text === '碎碎念：打开池子' || text === '碎碎念：✓ 打开池子') return { kind: 'whisper-pool' };
  if (text.startsWith(WHISPER_PREFIX)) {
    const rest = text.slice(WHISPER_PREFIX.length).replace(/^✓\s*/, '').trim();
    // 「自定义（420 秒）」/ 老文案「自定义间隔…」都算打开小窗
    if (rest.startsWith('自定义')) return { kind: 'whisper-custom' };
    const hit = WHISPER_INTERVALS.find((item) => item.label === rest);
    return hit ? { kind: 'whisper-interval', seconds: hit.seconds } : null;
  }
  const start = COMPANION_START.exec(text);
  // 「陪伴：自定义…」不带「开」，要在正则之前单独认（哥哥 11-02 报：点了没窗口）
  if (/^陪伴：(?:✓\s*)?自定义/.test(text)) return { kind: 'companion-custom' };
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
      return `陪伴开了：每 ${Math.round(action.intervalMs / 1000)} 秒看一眼`;
    case 'companion-custom':
      return '自定义窗口打开了：填分钟数点保存';
    case 'companion-stop':
      return '陪伴停了';
    // 开关类：宿主会把「切换成了什么」放进 message（例：嗓子切换为本地）
    case 'companion-toggle':
    case 'lyric-toggle':
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
  }
}
