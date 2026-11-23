/**
 * dsh-pet 宿主半侧（host half）—— 宠物插件的"后端"部分
 *
 * 职责：提供 `/dsh-pet-7340/` 前缀的**业务能力**（handlePetRoute 纯函数，路由与桌面管道共用）。
 * 全部配置（内置默认 + 用户主配置 + 文件宠物）由 ./config 的 readAllConfig 统一读取合并，
 * 本文件只消费它的返回值（绝对正确、零校验），不再接触任何配置文件。
 *
 * 两个入口消费同一份 handlePetRoute：
 *   - HTTP 路由：注册在 DSH WebServer 上（浏览器 overlay / 设置页 / 斜杠命令用）
 *   - 桌面 Helper 管道：helper-process.ts 的 bridgeHandler（DSH_PET_BRIDGE=1 时经
 *     dsh-pet-bridge:// scheme + stdout JSON 行 + 本地回调，**不走 HTTP**——
 *     DSH Desktop 2.0.3+ 的浏览器访问闸门会拦插件子进程的裸 HTTP 请求）
 * 两端行为严格一致（硬契约：浏览器/桌面功能/文案/配置完全对齐）。
 *
 * 路由：
 *   /dsh-pet-7340/config             → 合并后的**成品配置**（{ main:{...}, test1:{...}, ... }，
 *                                每条目字段已填满；浏览器/桌面/设置页的唯一配置入口）
 *                                GET 读取成品；PUT 保存用户层（白名单重建 main-config.jsonc）、
 *                                POST 同步用户层（把内置默认 config.jsonc **原文**整份写入，
 *                                含注释与全部高级字段；合并结果与「没有用户层」等价）——
 *                                两个写接口的**响应体都是保存后的成品聚合**，设置页即时生效
 *                                直接拍平这份响应，客户端不再有第二份"补吹条目级字段"的实现
 *   /dsh-pet-7340/reload              → 桌面端「重载配置」（右键菜单，POST）：重启桌面 Helper，全部桌面
 *                                宠物窗口按最新配置重建（改配置文件后不必回设置页点保存）；与保存走
 *                                **同一条**重启路径（syncDesktop），宠物数量/display/size 变化同样生效
 *   /dsh-pet-7340/config/meta         → 配置文件与素材目录路径 + 全部存储位置清单
 *                                       （设置页「高级配置」「卸载与存储」展示用）
 *   /dsh-pet-7340/models              → 可选「服务商 + 模型」清单（设置页「AI 模型」下拉框数据源；
 *                                       与 DSH 模型选择器同源，取宿主 llm 服务的 listProviders/listModels）
 *   /dsh-pet-7340/thumb/<素材根>/<动画名>.webm|.mov  → 素材按宠物归属（.mov 为 macOS 定制，扩展名取决于
 *       客户端播放常量 ANIMATION_EXT；本路由固定双扩展名兜底）：
 *       文件宠物 = $DSH_HOME/dsh-pet/pet/<素材根>-animation/（只查自己的，绝不回落）；
 *       主宠物   = $DSH_HOME/dsh-pet/main-animation/<webm|mov>（用户目录，优先）→ 包内 assets/<webm|mov>
 *       <素材根> 是**标识符**（pet/ 下文件名前缀），含分隔符/保留字符即 400（见 ID_FORBIDDEN）
 *   /dsh-pet-7340/state               → **轮询统一状态 S**（GET，前端 1s 轮询的唯一数据源）：
 *                                       { sections: { balance, workStatus, notify }, pets: { <id>: { say } } }，
 *                                       每个叶子 = { counter, data }；counter 变了前端才渲染。
 *                                       只读、纯内存、零副作用（绝不在这里触发外部调用/模型生成）。
 *   /dsh-pet-7340/work-status          → 外部写入工作状态（POST = 设置固定外部槽的档位/文案；
 *                                       DELETE = 清空回空闲。不做多写者仲裁/租约/会话管理）
 *   /dsh-pet-7340/balance              → 余额刷新（POST 动作端点，写 S；数据从 /state 读）
 *   /dsh-pet-7340/whisper              → 让某只宠物立即说一句（POST 动作端点，写 S 的 pets.<id>.say；
 *                                       响应带生成的 text，配图时带 image）
 *   /dsh-pet-7340/broadcast            → 第三方投喂：把外部给定的文本写进气泡（POST 动作端点，写 S 的
 *                                       pets.<id>.say；不生成、只搬运，供宿主侧其他插件集成）。
 *                                       配图给 `image`（池内名）或 `url`（第三方自带的完整地址）二选一
 *   /dsh-pet-7340/anim                 → 点播动画：让桌宠播一段动画（POST 动作端点，写 S 的
 *                                       pets.<id>.anim；供其他插件调用）。`name`（池内名，效果与右键
 *                                       「动作」菜单一致）或 `url`（第三方自带的完整地址，不查池、
 *                                       不走菜单语义）二选一。
 *                                       响应带 playbackId，供 /playback 查**真实回执**
 *   /dsh-pet-7340/lock                 → **占用锁**（issue #122 第 4 项，POST 动作端点）：联动演出
 *                                       期间独占这只宠物，除持锁者外全静音。`lockId` 给了 = 续期、
 *                                       没给 = 新建；回 { lockId, expiresAt }。内存态 + TTL。
 *                                       没带 lock 时行为与改造前逐字一致；带了但查不到锁 → lock-lost
 *   /dsh-pet-7340/lock/release         → 释放占用（POST 动作端点）：`lockId` = 持锁者收工 /
 *                                       `force` = **渲染端**报告用户接管（拖拽、点击、隐藏、关闭）。
 *                                       占用期间 5 个动作端点必须带 `?lock=<lockId>`，否则
 *                                       lock-required（没带）/ lock-lost（带了不匹配，附 cause）
 *   `?surface=`（**必填**，issue #122 第 1 条）→ 声明"我要**哪一端**的宠物"：web / desktop /
 *                                       both / any。`pet` 只说明"哪一只"，不说明"哪一端"——一只
 *                                       `display: desktop` 的宠物被当成网页目标时宿主照旧受理，
 *                                       但**没有任何渲染端会消费它**（拿到 ok:true 却什么都不会
 *                                       发生，直到回执超时）。这里把那种"必然不可能"提前变成显式
 *                                       失败：pet-not-displayed + **该宠物实际的 display**。
 *                                       **只开在会产生渲染端可见效果的端点上**：/anim、/broadcast、
 *                                       /bubble/clear、/position、/throw、/lock、/whisper 与
 *                                       /chat 的 POST；/lock/release（释放必须永远能成功）与
 *                                       /chat 的 GET（读记忆与显示在哪一端无关）**不开**。见 ./surface
 *   /dsh-pet-7340/playback/<id>        → **播放回执**（GET）：返回那一次点播的真实状态
 *                                       （accepted/playing/ended/failed/cancelled）。带
 *                                       `?wait=<状态[,状态]>` + `?timeout=<ms>`（**成对必填**）时挂起等待：
 *                                       状态进入 wait 集合立刻返回（matched:true），到点返回当时状态
 *                                       （matched:false）；两者都不传则立刻返回
 *   /dsh-pet-7340/playback/<id>/report → 渲染端上报播放状态（POST，**内部通道**：浏览器/桌面
 *                                       渲染进程 → host）。这是回执的**地基**——没有它，记录永远停在
 *                                       accepted（host 只知道"受理了"，不知道播没播完）。见 ./playback
 *   /dsh-pet-7340/chat                 → 对话与记忆（GET 最近窗口 / POST 对话并写 memory.json；
 *                                       POST 回 {ok,text,image?}，回复同样写 S 的 pets.<id>.say）
 *   /dsh-pet-7340/font|pic             → 字体 / 通知图标素材
 *
 * 系统通知不属于宠物行为、不在这里的旧实现是：浏览器半侧 notify.ts 经 connection 事件流
 * （api.events.mux/host）监听 DSH 事件。但 DSH 0.1.5 已删除该事件流 API——通知改为
 * host 侧监听宿主事件（session/event + agent/error）生成帧写进 S 的 sections.notify，
 * 浏览器统一轮询 /state 后弹 toast（帧契约与 shared/notify.ts 一致；单槽，见下方 pushNotifyFrame）。
 *
 * 桌面模式（Electron 透明窗）没有独立配置文件：宠物显示在哪全部由宠物条目的 display 决定
 * （web=仅浏览器 / desktop=仅桌面 / both=两者 / none=都不显示；缺失时合并器填内置默认值）。
 *
 * 安全性：resolveAsset 做"防穿越"校验，保证路径仍在对应根目录内；
 *         PUT 保存经 saveUserConfig 白名单重建，id 过滤文件名非法字符。
 *
 * TODO(类型)：peer 依赖类型包本地暂不可解析，ctx/req/res 暂用 any；
 *             依赖可解析后替换为 DSH 官方类型。
 */
import {
  appendFileSync,
  cpSync,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, appendFile, readdir, stat, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { dataDirIn } from './data-dir';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { listBalanceProviders, queryBalance, registerBalanceProvider } from './balance/index';
import { automaticWhisperSchedule } from './whisper-policy';
import { generateChat, generateChatViaGateway, type ChatMemoryMessage } from './chat';
import { audioDurationMs } from './core/audio-duration';
import { createModelGateway, type SessionChat } from './core/create-model-gateway';
import { handoffText, imageHandoffText } from './core/bridge-handoff';
import { fillRemoteBackends, parseModelConfig, toConfigSection } from './core/model-config';
import { configuredModel } from './model-selection';
import { applyMemePool, limitPool, pickMeme, readMemePool } from './memes';
import { createWhisperPoolCache, pickFromWhisperPool, readWhisperPool } from './whisper-pool';
import { decideBubbleClear } from './broadcast';
import { decideAnim } from './anim';
import {
  EMPTY_BRIDGE_STATE,
  fetchState as fetchDshBridgeState,
  readDiscovery as readDshBridgeDiscovery,
  say as sayToDsh,
  setConfig as setDshBridgeConfig,
  type DshBridgeState,
} from './dsh-bridge';
import { LockStore } from './lock';
import { MENU_WAIT_MAX_MS, MenuRegistry } from './menu';
import {
  modeWord,
  nextBackendWord,
  parsePetMenuLabel,
  petMenuFeedback,
  petMenuLabels,
  petStatusText,
  type BackendWord,
  PET_MENU_OWNER,
} from './pet-menu';
import { decidePosition, decideThrow, positionLeafData } from './motion-cue';
import { parsePlaybackPath, parseWaitQuery, PlaybackStore } from './playback';
import { PoseStore, normalizePoseInput } from './pose';
import { SURFACE_TEXT, displayCovers, normalizeSurface, type Surface } from './surface';
import {
  invalidateConfigCache,
  findPetInstance,
  flattenPetList,
  ID_FORBIDDEN,
  migrateUserConfig,
  PET_DISPLAY_SET,
  readAllConfig,
  readPetConfigEntry,
  readUserConfig,
  saveUserConfig,
  sliceMemoryRounds,
  syncUserConfigFromDefault,
  userConfigUnparsable,
  type ConfigPaths,
} from './config';
import { createMemoryStore, type MemoryStore } from './core/memory-store';
import {
  GOAL_UPDATE_TOOL,
  HOST_WORK_STATUS_STATES,
  TASK_TEXT_MAX,
  reduceWorkStatus,
  currentTaskFromTodo,
  goalUpdateAction,
  WorkStatusStore,
  type HostWorkStatusState,
  type WorkStatusTurnContext,
} from './work-status';
import {
  agentErrorFrame,
  hasBlockingActivity,
  isCompletionTurnEnd,
  reduceNotifyFrame,
  sessionIdOf,
  shouldNotifySession,
  withSessionId,
  type HostNotifyFrame,
} from './notify-events';
import { createPetCoreRuntime, type SayOutcome } from './core/create-pet-core';
import { createChatter } from './chatter';
import { createCompanion, DEFAULT_INTERVAL_MS, type CompanionHandle } from './companion';
import { createScreenCapture } from './companion-host';
import { resolvedFfmpeg } from './capture';
import {
  createWatchMode,
  normalizeTuning,
  WATCH_FALLBACK_MS as WATCH_FALLBACK_MS_SHARED,
  WATCH_MIN_GAP_MS as WATCH_MIN_GAP_MS_SHARED,
  WATCH_NOTES_MS as WATCH_NOTES_MS_SHARED,
  grabStill,
  type WatchHandle,
  type WatchPace,
  type WatchSheetMeta,
  type WatchTuning,
} from './watch-mode';
import {
  buildDetailPrompt,
  buildWatchPrompt,
  compressScene,
  DEFAULT_DETAIL_PROMPT,
  DEFAULT_WATCH_PROMPT,
  emptyScene,
  idleAllowsSpeak,
  mergeScene,
  mergeTopics,
  parseWatchReply,
  pickTopic,
  type SceneArchive,
  type TalkTopic,
} from './game-talk';
import { listWindows, readForeground, type ForegroundInfo } from './idle';
import { composeGrid, GRID_FRAMES, removeQuietly } from './grid';
import { DETAIL_STOCK, WATCH_STOCK, freshTemplate } from './legacy-prompts';
import { contextLine, pushTimeline, readLiveContext, type TimelineEntry } from './screen-context';
import { normalizeWatchMode, pageName, pickWindow, targetLine, type WatchMode, type WindowInfo } from './screen-target';
import { searchWeb, wikiLine, type SearchProvider } from './web-search';
import { createSubtitleBook } from './bili-subtitle';
import { createStoryCache } from './bili-story';
import { createSearchRunner, failedNote, parseToolCall, SEARCH_TOOL_HINT } from './chat-search';
import { pruneDir } from './retention';
import { dataLayout, migrateLayoutSync } from './layout';
import { readTailLines } from './log-tail';
import { looksLikeEcho } from './memory-echo';
import { createVoicePlayer } from './core/voice-player';
import { playbackWatchdogMs, systemPlayerCommand } from './core/sound-player';
import { createLyricAgent } from './lyric-agent';
import {
  admitSpeak,
  expirePending,
  pickNext,
  playGuardMs,
  SYNTH_GUARD_MS,
  type SpeakJob,
  type SpeakPriority,
} from './core/speak-center';
import { applyVoicePick, nextVoicePick, pickOf, voicePickWord, type VoicePick } from './core/voice-presets';
import { MEMORY_USAGE_RULES, STYLE_RULES } from './pipeline/style';
import { reasonBlock } from './pipeline/reason';
import { MOUTH_QUEUE_MAX, priorityFor } from './pipeline/level';
import { createRegistry } from './pipeline/registry';
import { EAR_SOURCE, earEvent } from './sources/ear';
import { MANUAL_SOURCE, manualEvent } from './sources/manual';
import { VISION_SOURCE, visionEvent } from './sources/vision';
import { CHAT_MIND } from './minds/chat';
import { SCREEN_MIND } from './minds/screen';
import { MOUTH_SINK } from './sinks/mouth';
import { BUBBLE_SINK } from './sinks/bubble';
import { HINT_SINK } from './sinks/hint';
import { ANIM_SINK } from './sinks/anim';
import { HANDOFF_SINK } from './sinks/handoff';
import { createMind } from './pipeline/mind';
import { CARD_INJECT, makeCard, normalizeCardText, parseRemember, pickCards, splitOverflow, touchCards } from './pipeline/cards';
import type { Card } from './pipeline/cards';
import { createSessionStore, ROLL_CHARS, type SessionStore } from './pipeline/session';
import { appendScreen, dayOf, readScreens, screenBlock } from './pipeline/screens';
import { isDuplicateThought, recentThoughts, shouldRecordThought } from './pipeline/thought';
import { pickFallback, sayOncePrompt, tidySayOnce } from './pipeline/say-once';
import { createPetServices, ServiceError } from './core/create-pet-services';
import { PET_CALL_IDENTITY } from './llm-call';
import { parseStandaloneRuntime, probeStandalone } from './core/connection';
import type { BubbleRequest, EyeRequest, PetServices, VoiceRequest } from './core/pet-services';
import { profileNameFrom, storageEntries } from './storage-paths';
import { parseStateWaitQuery, PollStateStore } from './state';
import { composeSystemPrompt, petPersona } from './persona';
import { splitSentences } from './say-split';
import {
  HelperProcess,
  defaultElectronExe,
  electronLandingDir,
  ensureElectronDownload,
  hasGraphicalDisplay,
  resolveElectronPath,
} from './helper-process';

/** 插件行 id（与 cordis.patch.yml 一致） */
export const name = 'pet';
/** 需要注入的服务：webServer（路由）+ agentDefaultModel（当前服务商）+ credentials（凭证）+ llm（对话模型调用）+ commands（/balance 斜杠命令）+ connection（桌面 Helper「打开网站」用的已鉴权站点 URL） */
export const inject = ['webServer', 'agentDefaultModel', 'credentials', 'llm', 'commands', 'connection'];

/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 包内 assets 根 */
const PACKAGE_ROOT_ASSETS = join(PACKAGE_ROOT, 'assets');

/** 包内表情包目录（表情包池的最后一环：assets/memes/<名称>.png） */
const PACKAGE_MEMES_DIR = join(PACKAGE_ROOT_ASSETS, 'memes');

/**
 * 从会话事件里抠出一句文本（旁听吐槽用）。
 *
 * 为什么要单独一个函数：DSH 的消息形状随版本变过（string / `{content}` / content 分段数组 /
 * `{text}`），旧 chatter 里那段 `extractText` 是踩过坑才写成的，这里保留同样的语义，
 * 免得升级宿主后旁听突然不说话了。
 */
function messageTextOf(message: unknown): string {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const obj = message as { content?: unknown; text?: unknown };
  if (typeof obj.content === 'string') return obj.content;
  if (Array.isArray(obj.content)) {
    return obj.content
      .map((part) => {
        if (typeof part === 'string') return part;
        const text = (part as { text?: unknown })?.text;
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (typeof obj.text === 'string') return obj.text;
  return '';
}

/** 路由前缀 */
const ROUTE_PREFIX = '/dsh-pet-7340';

/**
 * ffplay 起进程到真的出声之间的延迟（毫秒）：气泡要等语音**开始**才冒，
 * 所以从这里起算而不是从 spawn 起算。180ms 是这台机器上的实测手感。
 */
const VOICE_START_DELAY_MS = 180;

/** 气泡在语音结束后再挂多久（哥哥 10-31 定：语音结束 + 2 秒才收）。 */
const VOICE_TAIL_MS = 2000;

/** 配了表情包时，图单独展示多久（哥哥 10-31 定：表情包展示 4 秒）。 */
const MEME_SHOW_MS = 4000;

/** 说完到出表情包之间停多久（哥哥 11-02：「念完等一秒出图」）。 */
const MEME_TAIL_DELAY_MS = 1000;

/**
 * 两句之间至少隔多久才开口（哥哥 10-31：「新的一句要延长一秒后再念」）。
 * 紧挨着叠上来会听成抢话：上一句刚开始不到 1 秒就又来一句时，先等够 1 秒。
 */
const SAY_GAP_MS = 500;

/**
 * 陪伴模式「看一眼」之后交给聊天模型的那句话。
 *
 * 为什么不让模型直接看识图结果：鉴图模型给的是**客观描述**（「屏幕上是一个代码编辑器，
 * 左侧有文件树……」），原样念出来就是机械回话。哥哥要的是本鱼的口气，所以这里把描述
 * 当成"你刚才瞟到的东西"，让它按人设说一句自己的话。
 *
 * 三个约束都来自实测：
 * - **别复述画面**：否则又绕回"屏幕上有……"；
 * - **限长**：气泡一行放不下，且这句话还要念出来（合成越短越快）；用「20 字以内」这个
 *   人话口径，而不是硬截断（截断会切在词中间）；
 * - **不要括号舞台提示**：模型爱写「（笑）」这种，念出来会很怪。
 */
function companionLookPrompt(description: string): string {
  return (
    '（你刚瞟了一眼哥哥的屏幕，看到的是：' +
    description +
    '）现在用你自己的语气说一句，就当随口一提。' +
    '要求：别复述画面细节，不要说"屏幕上"；20 字以内，一句话，不要括号里的舞台提示。'
  );
}

/**
 * 模型配置里那一项现在是「关 / 本地 / 云」里的哪一个。
 *
 * 三处要用它：状态气泡、右键菜单的「嗓子 / 眼睛」显示、以及点击后的循环切换。
 * 放成模块级函数是为了**只有一套判定**——之前状态气泡和菜单各写一遍，改一处忘一处。
 */
function backendWordOf(capability: { enabled: boolean; backend: { kind: string } }): BackendWord {
  if (!capability.enabled) return 'off';
  return capability.backend.kind === 'local' ? 'local' : 'remote';
}

/**
 * 排障用：设了 `DSH_PET_DEBUG_LOG` 就把关键路径（尤其"为什么这一拍不说话"）写进那个文件。
 * 不设环境变量时**一个字节都不写**——用户机器上不该凭空多出日志文件。
 * 为什么不用 console：独立版里 CLI 的 stdout 由宿主转发，只写了启动那一段，
 * 之后 console.log 不再进 launcher.log，排障等于瞎着看。
 */
function debugTrace(message: string): void {
  const file = process.env.DSH_PET_DEBUG_LOG;
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    /* 排障日志绝不影响主流程 */
  }
}

/**
 * 宿主是不是 **DSH 桌面应用**（Electron 宿主）。
 *
 * 判据只用 `process.versions.electron`：桌面应用以 `ELECTRON_RUN_AS_NODE=1` 跑宿主（见 dsh.cmd），
 * 该字段照样在；而 `dsh web` / 独立模式都是纯 Node 进程，取不到它。据此把「打开网站」自动分派：
 * 桌面宿主 → 唤起桌面应用窗口（helper 走 `dsh://open`），其余 → 浏览器打开站点。
 */
const isDesktopHost = (): boolean => Boolean(process.versions.electron);

/** 不同扩展名对应的 Content-Type 映射 */
const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。
 * @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined
 */
function resolveAsset(root: string, rel: string): string | undefined {
  if (rel.length === 0) return undefined;
  const candidate = normalize(join(root, rel));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return undefined;
  return candidate;
}

/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
function resolveExisting(root: string, rel: string): string | undefined {
  const candidate = resolveAsset(root, rel);
  return candidate && existsSync(candidate) ? candidate : undefined;
}

/**
 * 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。
 *
 * Content-Length 必须取自**正在读的那个 fd**（open 事件里 fstat），不能先 stat 再另开流：用户往
 * $DSH_HOME/dsh-pet/main-animation/webm/ 复制或同名覆盖素材时，stat 与真正开始读之间文件会被截断/
 * 改写，一旦实际字节数少于声明的长度，这个响应就**永远不结束、也不报错**（浏览器表现为 stalled、
 * 视频 loadeddata 永不触发且无 error）——正是 issue #62 现场"数据断供"的一种成因。同一个 fd 的
 * fstat 拿到的大小与随后读出的字节天然一致。
 */
function sendFile(res: ServerResponse, file: string, contentType: string): void {
  const stream = createReadStream(file);
  stream.once('open', (fd) => {
    if (res.destroyed || res.writableEnded) {
      stream.destroy(); // 客户端在开流前就放弃了
      return;
    }
    try {
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': fstatSync(fd).size,
        'cache-control': 'public, max-age=3600',
      });
    } catch {
      // 极端情况下 fstat 拿不到：不发长度头，交给 Node 用 chunked 收尾（长度天然一致，只是没声明）
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'public, max-age=3600' });
    }
    stream.pipe(res);
  });
  // 读失败（文件被删/权限/被占用）：直接断连，让客户端立刻看到失败，而不是无限等待
  stream.on('error', () => res.destroy());
  // 客户端提前断开（快速切动画时高频发生）→ 停读，别把整个文件读完
  res.on('close', () => stream.destroy());
}

// 配置的读取/校验/合并/保存全部收敛在 ./config（readAllConfig / saveUserConfig，host 自包含实现，
// 不 import src/shared —— DSH 单文件加载约束）。本文件不再保留任何配置逻辑，只消费成品返回值。

/** 该宠物是否参与桌面模式（Electron 透明窗） */
const isDesktopVisible = (display: unknown): boolean => display === 'desktop' || display === 'both';

/** 发送 JSON 响应（headers 可选：如 no-cache 触发计数） */
function sendJson(res: ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** 发送纯文本响应（素材 404/400 等显式错误文案） */
function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/** 单次业务路由的应答（WebServer 注册与桌面 Helper 管道共用的同一契约；消费方各自落盘） */
type RouteResult =
  | { kind: 'json'; status: number; obj: unknown; headers?: Record<string, string> }
  | { kind: 'text'; status: number; body: string }
  | { kind: 'file'; file: string; contentType: string }
  /** 无需应答：调用方在挂起等待期间已断开（见 /playback 的等待分支）——消费方直接收尾，不写 */
  | { kind: 'none' };

/** 收集请求体（文本） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve2, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve2(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 额外宠物（pet pack）说明：校验/扫描已收敛到 ./config（readAllConfig 内部逐字段合并），
// 这里不再有 host 侧拷贝——文件宠物与主宠物一样，统一从 readAllConfig 的成品读取。
// ---------------------------------------------------------------------------

/** 宿主插件主体：注册 `/dsh-pet-7340` 前缀路由 + 斜杠命令（/balance /pet /chat）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（webServer/locale 等 service 无静态类型）
export function apply(ctx: any): void {
  // 用户数据根：配置与用户素材统一收敛于此（扩展包按 <插件id> 各自建目录）
  const dshHome = resolveDshHome();
  const userRoot = dataDirIn(dshHome);
  // 【汐儿 · 11-20 m32061】数据目录换新布局：老结构（companion-shots / logs\陪伴 / 空的 陪伴\）
  // 在启动时搬一次，搬完写 layout.json 做标记。之后所有路径都从 dataLayout() 取。
  const layout = dataLayout(userRoot);
  migrateLayoutSync(userRoot, (line) => console.log(line));
  /**
   * 屏幕流水（`memory/screens/<日期>.jsonl`）：和「说了什么」分家，只做注入、不进对话历史。
   *
   * 为什么声明在这里：下面的 `ctx.effect` 一注册就**当场执行**（清理定时器那一段会 prune 它），
   * 声明要是写在使用点后面，启动就会 `Cannot access 'screensDir' before initialization`
   * ——2026-11-20 实测踩到（独立模式日志「初始化某项失败（已跳过）」），别挪回去。
   */
  const screensDir = join(userRoot, 'memory', 'screens');

  /**
   * 把安装包里带的桥插件装进 DSH（哥哥 11-02 方案 A：包里带插件 + 一键装）。
   *
   * 源目录：打包后 = `<安装目录>/resources/bridge-plugin`（electron-builder 的 extraResources）；
   * 开发态没有安装目录时退回仓库里的 `packaging/bridge-plugin`。
   * 目标：`~/.dsh/plugins/body-of-fish-bridge`，并在 `~/.dsh/profiles/desktop/package.json`
   * 里补 `link:` 依赖 + `dsh.profile.bundles`（DSH 下次启动才加载）。
   *
   * 幂等：目录已存在就覆盖拷（插件很小）；profile 里已有同名项就跳过。
   */
  const installBridgeToDsh = async (): Promise<{ ok: boolean; message: string }> => {
    const resourcesPath = (process as { resourcesPath?: string }).resourcesPath ?? '';
    const candidates = [
      resourcesPath !== '' ? join(resourcesPath, 'bridge-plugin') : '',
      join(process.cwd(), 'packaging', 'bridge-plugin'),
    ].filter((path) => path !== '');
    const source = candidates.find((path) => existsSync(join(path, 'package.json')));
    if (source === undefined) return { ok: false, message: '安装包里没带桥插件（请用 0.4.0 的安装包装）' };
    const target = join(dshHome, 'plugins', 'body-of-fish-bridge');
    const linkDir = join(dshHome, 'profiles', 'desktop', 'node_modules', 'body-of-fish-bridge');
    /**
     * DSH 解析 bundle 走 Node 解析：profile 的 node_modules 里没有同名链接时，包会被静默
     * skipped（插件页显示「未安装」）——0.4.0 就是只写了 link: 依赖没建链接。装完必须补，
     * 且幂等：已存在且指向对就跳过，指向错先删再建，真实目录挡路报冲突不删。
     */
    const ensureBundleLink = (): 'created' | 'kept' | 'fixed' | 'conflict' | 'failed' => {
      let stat;
      try {
        stat = lstatSync(linkDir);
      } catch {
        try {
          mkdirSync(join(dshHome, 'profiles', 'desktop', 'node_modules'), { recursive: true });
          symlinkSync(target, linkDir, 'junction');
          return 'created';
        } catch {
          return 'failed';
        }
      }
      if (!stat.isSymbolicLink()) return 'conflict';
      try {
        if (realpathSync(linkDir).toLowerCase() === realpathSync(target).toLowerCase()) return 'kept';
        unlinkSync(linkDir);
        symlinkSync(target, linkDir, 'junction');
        return 'fixed';
      } catch {
        return 'failed';
      }
    };
    try {
      mkdirSync(target, { recursive: true });
      cpSync(source, target, { recursive: true, force: true });
      const profileFile = join(dshHome, 'profiles', 'desktop', 'package.json');
      if (existsSync(profileFile)) {
        const raw = JSON.parse(readFileSync(profileFile, 'utf8')) as {
          dependencies?: Record<string, string>;
          dsh?: { profile?: { bundles?: string[] } };
        };
        const deps = raw.dependencies ?? {};
        deps['body-of-fish-bridge'] = `link:${target.replace(/\\/g, '/')}`;
        raw.dependencies = deps;
        const profile = raw.dsh?.profile ?? {};
        const bundles = Array.isArray(profile.bundles) ? profile.bundles : [];
        if (!bundles.includes('body-of-fish-bridge')) bundles.push('body-of-fish-bridge');
        profile.bundles = bundles;
        raw.dsh = { ...(raw.dsh ?? {}), profile };
        writeFileSync(profileFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
      }
      const link = ensureBundleLink();
      if (link === 'failed') {
        return { ok: true, message: '桥插件装进 DSH 了，但 node_modules 链接没建成：重启 DSH 后插件页可能仍显示「未安装」，需要手动补链接' };
      }
      if (link === 'conflict') {
        return { ok: true, message: '桥插件装进 DSH 了，但 node_modules 里已有同名真实目录挡着：插件页可能仍显示「未安装」，请先清掉它' };
      }
      return { ok: true, message: '桥插件装进 DSH 了（已建链接）：重启 DSH 后生效' };
    } catch (error) {
      return { ok: false, message: `装插件失败：${error instanceof Error ? error.message : String(error)}` };
    }
  };

  // 用户主配置（可编辑层）与文件宠物目录；配置读取/合并统一走 readAllConfig（./config）。
  // 主配置是 **JSONC**（main-config.jsonc）——与包内默认 config.jsonc 同名同格式：
  // 「同步」写进去的就是带注释的原文，扩展名如实反映内容（旧版 main-config.json 只读回落 + 启动迁移）
  const userConfigPath = join(userRoot, 'main-config.jsonc');
  const legacyUserConfigPath = join(userRoot, 'main-config.json');
  const petConfigDir = join(userRoot, 'pet');
  // ---- 「接入 DSH」跨进程桥：发现文件 + 运行态 ------------------------------
  // 桥插件（dsh-pet-bridge）把地址写进 <userRoot>/dsh-bridge.json，这边读它反连；
  // 独立模式没有 DSH 会话（伪 ctx 不订阅事件），所以只能走文件 + HTTP。
  let dshBridgeUrl = '';
  let dshBridge: DshBridgeState = EMPTY_BRIDGE_STATE;
  /** 最后一次**连得上**时桥上的开关（DSH 关掉后 discovery 还在、状态却读不到——菜单别显示成「关」） */
  let dshBridgeWanted = false;
  /** 重读发现文件并问一次桥：返回最新运行态（桥不在就回落 EMPTY） */
  const refreshDshBridge = async (): Promise<DshBridgeState> => {
    const discovery = await readDshBridgeDiscovery(userRoot);
    if (discovery === null) {
      dshBridgeUrl = '';
      dshBridge = EMPTY_BRIDGE_STATE;
      dshBridgeWanted = false;
      return dshBridge;
    }
    dshBridgeUrl = discovery.url;
    dshBridge = await fetchDshBridgeState(discovery.url);
    if (dshBridge.available) dshBridgeWanted = dshBridge.enabled;
    return dshBridge;
  };
  /**
   * 「接入 DSH」开着时，把看到的东西交给会话，身体自己**不再生成、不再出声**。
   *
   * 哥哥 11-09 选 A：以前接入时身体先说一遍、又把描述投进会话，DSH 再答一遍——
   * 同一件事她说两遍。现在接入时「看一眼/陪伴」只负责看，说什么由会话里那只鱼决定，
   * 回复由桥（agent/turn-stopping）推回来变气泡+朗读。
   *
   * 返回 true = 已经交给会话（调用方到此为止，别自己说）；false = 没接入 / 投递失败，照旧本地处理。
   */
  const bridgeHandoff = async (kind: 'look' | 'watch', detail: string): Promise<boolean> => {
    const text = handoffText(kind, detail);
    if (text === '') return false;
    try {
      const bridge = await refreshDshBridge();
      // 桥读不到时按最后一次的意愿走（DSH 刚关的那一下别把话吞了）
      const wanted = bridge.enabled || (!bridge.available && dshBridgeWanted);
      if (!wanted || dshBridgeUrl === '') return false;
      return await sayToDsh(dshBridgeUrl, text);
    } catch (error) {
      debugTrace('[bridge] 交给会话失败：' + (error instanceof Error ? error.message : String(error)));
      return false;
    }
  };
  /**
   * 会话在右键菜单里的短名：`目录名·id 后 5 位`（例 `AI·8f326d`）。
   *
   * 为什么要带 id 尾巴：哥哥有同名/同目录的会话（群聊那次就点错过），光看标题分不清；
   * 菜单 label 上限 32 字，前缀「状态：接入 · ✓ 」已占 8 字，所以这里压到 ≤16 字。
   */
  const dshSessionLabel = (session: DshBridgeState['sessions'][number]): string => {
    const base = (session.title.trim() !== '' ? session.title : session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? '').trim();
    const head = base === '' ? '会话' : base.length > 10 ? `${base.slice(0, 10)}…` : base;
    return `${head}·${session.id.slice(-5)}`;
  };
  // 配置路径集（readAllConfig 的唯一输入：内置默认 + 用户主配置 + 文件宠物目录）
  const configPaths: ConfigPaths = {
    defaultFile: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
    userFile: userConfigPath,
    legacyUserFile: legacyUserConfigPath,
    petDir: petConfigDir,
  };
  // 老用户一次性迁移：main-config.json → main-config.jsonc（重命名，内容一字不动；
  // 新文件已存在则不动旧文件）。失败不影响运行——读取侧对旧路径有回落。
  migrateUserConfig(configPaths, (msg) => console.log('[dsh-pet] ' + msg));
  // 用户动画目录（thumb 播放时优先于包内素材；webm 放 main-animation/webm/，mov（macOS 定制）放 main-animation/mov/）
  const thumbUserRoot = join(userRoot, 'main-animation');
  // 碎碎念本地池（【本鱼改造】10-28 加）：文件在就从池里取句子、不叫模型。
  // 与主配置同住数据根，所以用户改的永远是同一处（$DSH_HOME/dsh-pet/碎碎念池.json）。
  const whisperPoolFile = join(userRoot, '碎碎念池.json');
  const whisperPoolCache = createWhisperPoolCache();
  /**
   * 【本鱼改造 · 10-31】把包内自带的一份碎碎念池落盘。
   *
   * 为什么要有它：以前只在「打开池子」时才顺手生成 3 条示例，结果是**刚装好一条都没有**，
   * 碎碎念永远安静 —— 用户看到的却是「默认打开了碎碎念却不说话」。
   * 现在安装包自带 `assets/whisper-pool.json`，首次启动抄一份到数据根。
   * 只在文件不存在时写：**绝不覆盖用户改过的池子**。
   */
  const seedWhisperPool = (): void => {
    if (existsSync(whisperPoolFile)) return;
    try {
      mkdirSync(userRoot, { recursive: true });
      const bundled = join(PACKAGE_ROOT_ASSETS, 'whisper-pool.json');
      const content = existsSync(bundled)
        ? readFileSync(bundled, 'utf8')
        : `${JSON.stringify([{ text: '冒尖的白米饭最好吃。' }, { text: '哥哥，记得喝口水。' }], null, 2)}\n`;
      writeFileSync(whisperPoolFile, content, 'utf8');
    } catch {
      // 写不进去就安静着：碎碎念少说话，不影响启动与其它功能
    }
  };
  // 用户表情包目录（碎碎念/对话配图的图片：优先于包内 assets/memes，加图不必改包）
  const memesUserRoot = join(userRoot, 'memes');
  /**
   * 表情包目录链 —— 与动画素材（/thumb）**同一套素材归属语义**：
   *   - `pet/<素材根>-memes/` 存在（种类自带表情包）：**只查它**，池与路由都不回落——
   *     查不到即 404 / 该条目剔除（与 `pet/<素材根>-animation/` 的独占规则逐字一致）；
   *   - 否则：用户目录 `$DSH_HOME/dsh-pet/memes/` 优先，其次包内 `assets/memes/`（逐文件合并，
   *     与「main-animation/<ext> → 包内 assets/<ext>」的主素材链同构）。
   * 池（readMemePool）与路由（/pic/memes）必须走**同一个函数**：池里能选的名字，
   * 路由必须取得到，否则气泡配图会图裂。
   * 素材根一律先过 resolveAsset：它来自 URL 段，Windows 上 %5C 解出的反斜杠不会被
   * rest.split('/') 切开，直接 join 会让 `..\..\x` 逃出用户根读盘（与 /thumb 同一道防线）。
   */
  const memeDirsFor = (assetRoot: string): string[] => {
    const own = resolveAsset(petConfigDir, assetRoot + '-memes');
    if (own !== undefined && existsSync(own)) return [own];
    return [memesUserRoot, PACKAGE_MEMES_DIR];
  };
  /** 某条目**实际可抽**的表情包池 = 库（memes + 目录链）按 `memePool` 收窄。
   *  【本鱼改造 · 表情包池】碎碎念抽卡、对话选图清单、碎碎念池配图都走这一个口径，
   *  免得「设置页里删掉的图还被抽出来」。 */
  const memePoolFor = (entry: string, conf: Record<string, unknown>): ReturnType<typeof readMemePool> =>
    applyMemePool(readMemePool(conf.memes, memeDirsFor(entry)), conf.memePool);
  /**
   * 【本鱼 · 11-01】说完一句后随机抽一张表情包（返回绝对路径）。
   * 哥哥要的：「说完后挑个表情包发出来」——只抽池里真实存在的图，抽不到就安静。
   */
  const pickMemeImage = (petId: string): string | undefined => {
    // 【本鱼 · 11-02】哥哥报「说完没有表情包」：抽不到图时静默，查起来全靠猜，
    // 这里把每一次抽卡结果写进 logs/meme.log（池子大小、抽中谁、目录命不命中）。
    const note = (line: string): void => {
      try {
        const dir = join(userRoot, 'logs');
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'meme.log'), `${new Date().toISOString()} ${line}\n`);
      } catch {
        /* 日志失败不影响抽卡 */
      }
    };
    try {
      const found = findPetInstance(readAllConfig(configPaths), petId);
      if (!found) {
        note(`${petId}: instance not found`);
        return undefined;
      }
      const pool = memePoolFor(found.entry, found.conf);
      const picked = pickMeme(pool);
      if (!picked) {
        note(`${petId}: empty pool dirs=${memeDirsFor(found.entry).join('|')}`);
        return undefined;
      }
      const dir = memeDirsFor(found.entry).find((d) => existsSync(join(d, picked.name + '.png')));
      note(`${petId}: pool=${pool.length} picked=${picked.name} dir=${dir ?? 'MISSING'}`);
      return dir ? join(dir, picked.name + '.png') : undefined;
    } catch (error) {
      note(`${petId}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  /**
   * 【本鱼改造 · 模型网关】条目配置里 chat 后端不是「会话」时，碎碎念与对话改走网关
   * （哥哥要的「自己填 key / 接本地模型」）。session 后端仍走 dsh-llm 那条老路：
   * 不接网关就不改变现有行为，接了也只影响这一个功能。
   */
  const usesOwnModel = (conf: Record<string, unknown>): boolean => {
    const chat = parseModelConfig(conf.model).chat;
    return chat.enabled && chat.backend.kind !== 'session';
  };
  // 【本鱼 · 11-01】看一眼的第二步要调聊天模型：这里也得把云端的 baseUrl/apiKey 从 AI 设置补齐。
  // 少了这一步「看一眼」会在最后一步报「还没填服务地址（baseUrl）」（哥哥实测踩到的就是这个）。
  const gatewayFor = (conf: Record<string, unknown>) =>
    createModelGateway({ readConfig: () => fillCloudBackend(parseModelConfig(conf.model)), session: null , extraHeaders: backendHeaders });
  // 轮询统一状态（S）：前端 1s 轮询的**唯一**数据源（余额 / 工作状态 / 通知 / 宠物说话）。
  // 所有写入走 state.writeSection / writePet（由它统一更新 counter），见 ./state 的说明。
  const state = new PollStateStore();
  // 第三方右键菜单注册表（issue：第三方菜单项）：**进程内存态**，不落盘，重启即空。
  // 与 S 的关系：注册表本身写进 S 的 sections.menu（两端据此拼「更多」）；点击事件**不进 S**——
  // 它是触发不是状态，走 /menu/events 的读取即消费，只给注册它的那个 owner 看。见 ./menu 的说明。
  const menuRegistry = new MenuRegistry();
  // 对外 Cordis 服务（宿主半侧）：与页面侧的 petApi7340 同名，但分属两个容器，互不可见也互不覆盖。
  // 只暴露 register（返回注销函数，配合 ctx.effect 在卸载时自动清理）与 list（排障用）；
  // 不暴露 unregister：注销走返回值，避免任何插件都能注销别人的 provider。
  // 对外服务（气泡/嘴/眼）要等下面的 core 造出来才能提供，所以这里是**懒代理**：
  // 别的插件在加载早期就能 get 到对象，真正调用时 core 早已就绪（同类插件的常规时序）。
  let servicesProvider: ((petId: string) => PetServices) | null = null;
  const servicesOf = (petId: string): PetServices => {
    if (!servicesProvider) throw new Error('桌宠服务还没就绪（进程刚启动？稍后再试）');
    return servicesProvider(petId);
  };
  ctx.provide('petApi7340', {
    balance: {
      register: registerBalanceProvider,
      list: listBalanceProviders,
    },
    /** 【本鱼改造 · 对外服务】DSH 侧让桌宠冒话/念出声/看图；跨进程入口是 /services/*。 */
    services: {
      bubble: {
        say: (request: BubbleRequest) => servicesOf(request.petId).bubble.say(request),
        clear: (petId: string) => servicesOf(petId).bubble.clear(petId),
        current: (petId: string) => servicesOf(petId).bubble.current(petId),
      },
      voice: {
        speak: (request: VoiceRequest) => servicesOf('main').voice.speak(request),
        available: () => servicesOf('main').voice.available(),
      },
      eyes: {
        look: (request: EyeRequest) => servicesOf('main').eyes.look(request),
        available: () => servicesOf('main').eyes.available(),
      },
      snapshot: (petId = 'main') => servicesOf(petId).snapshot(),
    },
  });
  // 播放记录表（issue #122 第 3 项「播放与完成回执」）：**由渲染端上报驱动**的状态机 + 等待者。
  // 与 S 无关：播放记录是 per-caller 资源（只有发起那次点播的调用方关心、有生命周期、数量随
  // 第三方调用方增长），塞进 1s 全局广播会让每个窗口为每个功能付流量。见 ./playback 的说明。
  const playback = new PlaybackStore();
  // 工作状态联动快照（/work-status 端点响应，浏览器 1s 轮询）：state=当前活动状态（null=空闲）、
  // task=当前任务详情、ts=最近变化时间（轮询侧检测变化用）。气泡文案不在此：浏览器读配置
  // events.workStatusTexts（host 不内置文案）。
  // 聚合与展示选择都在 WorkStatusStore（host/work-status.ts，纯逻辑可单测）：**state 与 task 都按
  // 会话存**——task 曾是全局单值，写过一次就跟着此后所有会话活动一直显示（issue #59）。
  // 进程内内存态：重启回空闲；每次会话事件有实际状态变化才更新（签名比对防刷屏）。
  const workStatus = new WorkStatusStore();
  /** 外部写入槽：固定会话 id，最后写入者生效；不做多写者仲裁/租约/会话管理 */
  const EXTERNAL_WORK_SESSION = 'api';
  let externalWorkSeq = 0;
  // 工作状态快照 → 写进 S（前端 1s 轮询 /state 后按 counter 变化渲染）。
  // **只在内容真的变了时才写**：每次写都会推进 counter，前端据此重播档位动画——
  // 会话事件很密（每个 tool/call 都来），无条件写会把动画刷成幻灯片。
  // 判据用**内容**（state + task）而不是 store 的 ts：ts 是 Date.now()（毫秒分辨率），
  // 同一毫秒内连改两次会被误判成"没变化"而漏写（测试里连发事件就会踩到）。
  // data 里不再带 ts：「变了没有」已由叶子 counter 承担，少一个会漂移的第二信号。
  //
  // **忙碌档抖动抑制（滞回）**：工具秒回时 `tool/call` 报 working、`tool/result` 报 result，
  // 一次回复里能来回切十几次；每切一次前端就把 10s 的片段从第 0 帧重播，观感即"一秒一刀"
  // （实测 6 次快工具调用 → 13 次换片，working 每次只活 1~2 秒）。
  // 这里只压 **working ↔ result 这对忙碌档之间的互切**：距上次写入不足 WORK_STATE_GAP_MS
  // 就先不写，**但不丢**——挂一个 trailing 定时器，到点重新取快照补写，所以最终状态一定落地，
  // 只是最多晚 GAP。
  //
  // 刻意**不压**的对象（"写完立刻可见"是既有契约，动它会把一串宿主回归测试打翻）：
  //   - 回空闲 / 终态（success、error）：反馈不能迟到；
  //   - 任何进/出忙碌档以外的变化（thinking、waiting、…）；
  //   - 任务文案变化（todo/write 的 task）：气泡文字优先于动画平滑，而且它可能伴随
  //     "展示会话切到另一只"（同档但 task 不同），那不是抖动。
  // 为什么压在这里而不是两个前端：网页 overlay 与桌面 helper 消费的是同一个叶子，
  // 一处压住两端同时生效，也不必在前端各维护一份状态机。
  const WORK_STATE_GAP_MS = 5000;
  /** 忙碌档：只有这两个档位之间的互切算"抖动"，其余档位变化一律立即写 */
  const isBusyTier = (s: string | null): boolean => s === 'working' || s === 'result';
  let publishedWork = '\u0000';
  let publishedState: string | null = null;
  let publishedTask: string | null = null;
  let publishedWorkAt = 0;
  let workFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const publishWorkStatus = (): void => {
    const snap = workStatus.snapshot();
    const key = String(snap.state) + '\u0000' + String(snap.task);
    if (key === publishedWork) return;
    // 抖动判定：文案没变、且前后都是忙碌档（同档已被上面的 key 短路掉，这里必是互切）
    const churn = snap.task === publishedTask && isBusyTier(publishedState) && isBusyTier(snap.state);
    const wait = WORK_STATE_GAP_MS - (Date.now() - publishedWorkAt);
    if (churn && wait > 0) {
      // 压住这一拍：到点再取**最新**快照补写（不要在这里缓存 snap——期间可能又变了）
      workFlushTimer ??= setTimeout(() => {
        workFlushTimer = null;
        publishWorkStatus();
      }, wait);
      return;
    }
    if (workFlushTimer !== null) {
      clearTimeout(workFlushTimer);
      workFlushTimer = null;
    }
    publishedWork = key;
    publishedState = snap.state;
    publishedTask = snap.task;
    publishedWorkAt = Date.now();
    state.writeSection('workStatus', { state: snap.state, task: snap.task });
  };
  // 占用锁（issue #122 第 4 项「独立动作/气泡占用」）：**内存态**一把锁 + TTL，第三方联动期间
  // 独占这只宠物——除持锁者外谁都动不了它（随机链、碎碎念、余额、工作状态一概让路）。
  //
  // 它自己**不带定时器**：过期是懒判的，叶子里的 `expiresAt` 是唯一真相，渲染端据此**自己**
  // 解除静止；这里只负责把状态变化同步进 S 的 `pets.<id>.lock`。见 ./lock 的四条边界
  // （无锁 = 现状零变化 / 有界 / 续期即心跳 / 无定时器）。
  const lock = new LockStore({
    onChange: (petId, data) => state.writePet(petId, 'lock', data),
  });

  // 实况快照（issue #122 第 1 条）：桌面渲染端变化时上报，第三方用 GET /pose 读。
  // 网页端不走这里——它的位置**天生每个页面一份**，走页面内的 Cordis 服务 `petApi7340`。
  const pose = new PoseStore();

  /**
   * `?surface=` 的**参数级**校验（缺省 / 非法 → `bad-request`）。放在读盘之前：必然失败的请求
   * 不碰磁盘（与 pet 空串同一处境）。通过则给出收窄后的取值。
   */
  const surfaceParam = (params: URLSearchParams): { ok: true; want: Surface } | { ok: false; res: RouteResult } => {
    const want = normalizeSurface(params.get('surface'));
    if (want !== null) return { ok: true, want };
    return {
      ok: false,
      res: { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: SURFACE_TEXT } },
    };
  };

  /**
   * `?surface=` 与该宠物 `display` 的对齐校验（issue #122 第 1 条）：不满足 → `pet-not-displayed`
   * + **实际 display 原样回给调用方**（调用方据此一眼知道该怎么办），放行回 null。
   *
   * 这是**前置校验**，不是按面分发——指令照旧写进同一个叶子、两端内容照旧完全一致
   * （要"网页播 A、桌面播 B"用两只宠物表达，见 ./surface 的第 1 条边界）。
   */
  const surfaceMismatch = (pet: Record<string, unknown>, petId: string, want: Surface): RouteResult | null => {
    const display = String(pet.display ?? '');
    if (displayCovers(want, display)) return null;
    return {
      kind: 'json',
      status: 200,
      obj: {
        ok: false,
        reason: 'pet-not-displayed',
        message: petId + ' 的显示模式是 ' + display + '，不满足 surface=' + want,
        display,
      },
    };
  };

  /**
   * 决策函数**之后**的 surface 校验（`/anim`、`/broadcast`、`/bubble/clear`、`/position`、
   * `/throw` 共用）：这五条的 pet 解析住在各自的决策模块里，所以这里按 `petId` 再查一次实例取
   * `display`（配置已在手，成本可忽略）。放行回 null。
   *
   * 位置与 `lockBlocked` 一致——都在决策函数之后、任何副作用之前，所以校验顺序是
   * 「body → pet → surface → 锁」。
   */
  const surfaceBlocked = (
    cfg: Record<string, Record<string, unknown>>,
    petId: string,
    params: URLSearchParams,
    fallback?: Surface,
  ): RouteResult | null => {
    // 进程内调用（陪伴/右键菜单/碎碎念）没有 ?surface= 这回事：它们是宿主自己的功能，
    // 目标就是「哪端在显示就写哪端」，按调用方给的 fallback（一般为 any）判。
    // HTTP 路由照旧**强制必填**——那是给第三方定的契约，不能放宽。
    const raw = params.get('surface') ?? fallback ?? null;
    const want = normalizeSurface(raw);
    if (want === null) {
      return {
        kind: 'json',
        status: 200,
        obj: { ok: false, reason: 'bad-request', message: SURFACE_TEXT },
      };
    }
    return surfaceMismatch(findPetInstance(cfg, petId)?.pet ?? {}, petId, want);
  };

  /**
   * 路由层的 pet 参数解析（`/lock`、`/lock/release`、`/whisper`、`/chat` 用——这四条没有独立决策层；
   * `/anim`、`/broadcast`、`/bubble/clear`、`/position`、`/throw` 的同一套校验住在各自的决策模块里，
   * 口径与这里逐字一致）：**必填**且必须真实存在。
   *
   * 两种失败分开报（issue #122 第 1 条「绝不默认退到列表第一只」）：
   * 没给 / 空串 → `pet-required`；给了但配置里没有 → `unknown-pet`。
   *
   * 收紧前这四条是 `get('pet') || resolveActivePetId() || 'main'`：缺省会落到"当前桌宠"
   * = **有效宠物列表第一只**（`/whisper`、`/chat` 更彻底——`?? ''` 直接空串：人设按 main 条目取、
   * 生成结果写进没人消费的 `pets[""].say`，还回 ok:true——钱花了、话丢了、调用方以为成功）。
   * 落点随用户 /pet 操作而变、失败也不报，第三方无从预期，故整条缺省链已删除：
   * pet 与 `/pet-display` 的 `id` 一样是必填项。
   *
   * `cfg` 传**惰性读取**：pet 空串时不必碰磁盘（与 /broadcast 的 text/duration 同一处境，
   * routes.test.ts 里"配置不可达"那一组断言正是靠这个顺序钉住的）。
   *
   * `opts.surface` = 是否同时校验 `?surface=`。**只对会产生渲染端可见效果的端点开**：
   * `/lock`、`/whisper`、`/chat` 的 POST。`/lock/release` 与 `/chat` 的 GET 不开——
   * 释放必须永远能成功（否则宠物中途被隐藏就撤不掉锁），读记忆与显示在哪一端无关。
   */
  const requirePet = (
    params: URLSearchParams,
    cfg: () => Record<string, Record<string, unknown>>,
    opts?: { surface?: boolean },
  ):
    | { ok: true; petId: string; entry: string; conf: Record<string, unknown>; pet: Record<string, unknown> }
    | { ok: false; res: RouteResult } => {
    const fail = (reason: 'pet-required' | 'unknown-pet', message: string): { ok: false; res: RouteResult } => ({
      ok: false,
      res: { kind: 'json', status: 200, obj: { ok: false, reason, message } },
    });
    const petId = String(params.get('pet') ?? '').trim();
    if (!petId) return fail('pet-required', 'pet 必填：要指定操作哪只桌宠');
    // surface 分两步：参数级校验在读盘之前（必然失败的请求不碰磁盘），显示模式校验在找到宠物之后。
    let want: Surface | null = null;
    if (opts?.surface === true) {
      const p = surfaceParam(params);
      if (!p.ok) return { ok: false, res: p.res };
      want = p.want;
    }
    // 一次查找同时给出"存在性"与"所属条目"（entry 即素材根，/chat 读记忆分桶要用）+ 条目配置
    // （/chat 取 chatMemoryRounds 要用）——调用方拿到的就是校验时那份快照里的值，不必再查一次。
    const found = findPetInstance(cfg(), petId);
    if (!found) return fail('unknown-pet', '没有这只桌宠：' + petId);
    if (want !== null) {
      const mismatch = surfaceMismatch(found.pet, petId, want);
      if (mismatch) return { ok: false, res: mismatch };
    }
    return { ok: true, petId, entry: found.entry, conf: found.conf, pet: found.pet };
  };

  /**
   * 动作端点的占用门禁（`/anim`、`/broadcast`、`/position`、`/throw`、`/bubble/clear` 共用）：
   * 放行回 null，否则直接给出路由应答。抽成一个函数，是为了让"哪些接口受占用约束"只有一处可查。
   *
   * **无锁时按「有没有带 `lock`」分流**：没带 → 返回 null（既有调用方一个字都不用改）；
   * 带了但查不到锁 → `lock-lost`，旧租约不能继续执行迟到请求。
   * 没带这一支就是「不传 lock = 现状零变化」（issue #122 最重要的边界）的落点。
   *
   * 位置放在决策函数**之后**：`petId` 要先解析出来才知道问哪只宠物的锁，而这时还没有任何副作用
   * （没写叶子、没建播放记录、没调模型）。所以"先判锁再干活"这个意图是满足的，只是与
   * body 校验的先后为「body → pet → 锁」——两者都不合法时报的是 body 的错。
   */
  const lockBlocked = (petId: string, params: URLSearchParams): RouteResult | null => {
    const g = lock.gate(petId, String(params.get('lock') ?? ''));
    if (g.ok) return null;
    return {
      kind: 'json',
      status: 200,
      obj:
        g.reason === 'lock-lost'
          ? { ok: false, reason: g.reason, cause: g.cause, message: g.message }
          : { ok: false, reason: g.reason, message: g.message },
    };
  };
  // 业务核心（P2）：说话/槽位/快照的**唯一实现**。路由、桌面管道、独立模式、partner 直调
  // 全部走这一份，路由里只留「解析请求 + 决定状态码」。
  // 门禁（显示端过滤 / 占用锁）由 host 注入：core 不关心锁怎么实现。
  const toSayOutcome = (r: RouteResult): SayOutcome => {
    const obj = (r as { obj?: Record<string, unknown> }).obj ?? {};
    return { ok: false, reason: String(obj.reason ?? 'failed'), message: String(obj.message ?? '') };
  };
  const core = createPetCoreRuntime({
    state,
    readConfig: () => readAllConfig(configPaths),
    memeDirsFor,
    gate: ({ cfg, petId, surface, params, skipLock }) => {
      // 顺序与改造前一致：显示端对齐 → 占用门禁（都早于任何副作用）
      // surface 来自 core 调用方（进程内服务传 'any'；HTTP 路由自己不传，靠 params）
      const noSurface = surfaceBlocked(cfg, petId, params, surface as Surface | undefined);
      if (noSurface) return toSayOutcome(noSurface);
      // 歌词这类旁挂叶子不受占用锁限制（见 core 里 lyric 的说明）
      if (skipLock) return null;
      const blocked = lockBlocked(petId, params);
      return blocked ? toSayOutcome(blocked) : null;
    },
  });
  // 【本鱼改造 · 会话后端】把 DSH 的「当前对话模型」包成网关的 session 后端。
  //
  // 为什么非有它不可：网关（core/model-gateway）只认 `session | remote | local` 三种后端，
  // 而 session 这一支必须由宿主提供 —— 它要用 ctx.llm + agentDefaultModel，core 里不许碰 DSH。
  // 独立模式（src/standalone）没有 llm 服务，这里自然是 null，设置页会显示「还没接上 DSH 会话」，
  // 而不是假装能用。
  //
  // 消息形状：dsh-llm 要它自己的消息对象，这里把网关的 ChatRequest 拍平成**一段文本**
  // （旁听吐槽/碎碎念都是一问一答，没有多轮结构化需求；真需要多轮时再换成正式的消息构造器）。
  const sessionChat: SessionChat | null = (() => {
    const llm = (ctx as { llm?: { stream?: unknown } }).llm;
    if (!llm || typeof llm.stream !== 'function') return null;
    const stream = (llm as { stream(options: unknown): AsyncIterable<unknown> }).stream.bind(llm);
    return {
      async chat(request) {
        const selection = ctx.agentDefaultModel.currentSelection();
        if (!selection?.provider || !selection?.model) throw new Error('当前对话未配置模型');
        const text = request.messages.map((m) => `${m.role}: ${m.text}`).join('\n');
        const iterable = stream({
          provider: selection.provider,
          model: selection.model,
          sessionId: PET_CALL_IDENTITY,
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
          ...(request.signal ? { signal: request.signal } : {}),
        });
        let out = '';
        for await (const chunk of iterable) {
          const piece = (chunk as { delta?: { text?: string }; text?: string }).delta?.text ??
            (chunk as { text?: string }).text ?? '';
          if (typeof piece === 'string') out += piece;
        }
        const trimmed = out.trim();
        if (!trimmed) throw new Error('模型回了空话');
        return trimmed;
      },
    };
  })();
  /** 某条目配置对应的网关：session 有就接上，这样「走会话」才是真的能走。 */
  const gatewayWithSession = (conf: Record<string, unknown>) => {
    // 【汐儿 · 11-20】留空跟随 AI 设置：这里的 chat 也可能是「空地址 + 空模型名」，
    // 不补的话这条支线会先撞「还没填服务地址」，而主聊天却好好的。
    const modelConfig = fillCloudBackend(parseModelConfig(conf.model));
    return createModelGateway({ readConfig: () => modelConfig, session: sessionChat , extraHeaders: backendHeaders });
  };
  // 【本鱼改造 · 旁听吐槽】哥哥 10-30 定的六个模块里留下的那个（chatter）：
  // 会话一轮结束时插一句，规则档免费、模型档 50%。数据与调度在 ./chatter，这里只做"接线"。
  // 独立模式下没有 agents 服务 → mountChatter 什么都不挂，不影响启动。
  const chatter = createChatter({
    config: () => {
      const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
      const raw = (conf.chatter ?? {}) as Record<string, unknown>;
      return {
        ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
        ...(typeof raw.modelRatio === 'number' ? { modelRatio: raw.modelRatio } : {}),
        ...(typeof raw.cooldownSec === 'number' ? { cooldownSec: raw.cooldownSec } : {}),
        ...(typeof raw.maxChars === 'number' ? { maxChars: raw.maxChars } : {}),
      };
    },
    say: async (text) => {
      // 哥哥 11-09 晚：碎碎念是三条里最低的——有人在说话时它连气泡都不冒
      // （冒了会盖掉正在念的那句），直接丢掉，说完早就过期了。
      if (speakBusy()) {
        debugTrace('[speak] 碎碎念撞上说话，丢掉');
        return;
      }
      const outcome = core.say({ petId: 'main', text, duration: 8000 });
      if (!outcome.ok) throw new Error(outcome.message || outcome.reason);
    },
    generate: async ({ userText, replyText, maxChars }) => {
      const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
      const prompt =
        '你是哥哥桌面上的「蓝色大肥鱼」，正旁听哥哥和本鱼聊天。\n' +
        `哥哥说：${String(userText ?? '').slice(0, 260)}\n` +
        `本鱼答：${String(replyText ?? '').slice(0, 260)}\n\n` +
        `用一句话吐槽或接个话茬，${maxChars}字以内，软萌元气，可带「咕噜」「泡泡」。` +
        '只输出那一句话，不要解释，不要加引号，不要提自己是AI。';
      let out = '';
      for await (const frame of gatewayWithSession(conf).chat({ messages: [{ role: 'user', text: prompt }] })) {
        if (frame.type === 'text' && typeof frame.text === 'string') out += frame.text;
        if (frame.type === 'error') return null;
      }
      return out.trim() || null;
    },
  });
  /** 每个会话挂一次：抓「哥哥说的」→ 一轮结束抓「本鱼答的」→ 交给 chatter 决定说不说。 */
  const mountChatterFor = (agent: unknown): void => {
    const target = agent as {
      id?: string;
      session?: { id?: string; snapshotEvents?(): unknown[] };
      ctx?: { on?(event: string, handler: (payload: unknown) => void): void };
    };
    const sid = String(target?.session?.id ?? target?.id ?? '');
    if (!sid || chatterMounted.has(sid)) return;
    if (!target?.ctx?.on || !target.session) return;
    chatterMounted.add(sid);
    let lastUser = '';
    try {
      target.ctx.on('agent/inbox/inserted', (payload) => {
        const message = (payload as { message?: unknown })?.message ?? payload;
        const text = messageTextOf(message);
        // 跳过系统注入的（以【开头），它们不是哥哥说的话
        if (text.length > 1 && !text.startsWith('【')) lastUser = text;
      });
    } catch {
      // 事件名随 DSH 版本变，挂不上就算了：旁听是锦上添花，不该影响桌宠本体
    }
    try {
      target.ctx.on('agent/turn-stopping', () => {
        let reply = '';
        try {
          const events = target.session?.snapshotEvents?.() ?? [];
          for (let i = events.length - 1; i >= 0; i -= 1) {
            const event = events[i] as { type?: string; data?: { message?: unknown } } | undefined;
            if (event?.type === 'assistant/message') {
              reply = messageTextOf(event.data?.message);
              break;
            }
          }
        } catch {
          reply = '';
        }
        if (lastUser || reply) void chatter.onTurn(lastUser, reply);
        lastUser = '';
      });
    } catch {
      // 同上
    }
  };
  const chatterMounted = new Set<string>();
  const mountChatter = (): void => {
    try {
      const agents = (ctx as { agents?: { list?(): unknown[] } }).agents;
      for (const agent of agents?.list?.() ?? []) mountChatterFor(agent);
      for (const eventName of ['agent/created', 'agent/added', 'session/added']) {
        try {
          ctx.on(eventName, (payload: unknown) => {
            const agent = (payload as { agent?: unknown })?.agent ?? payload;
            mountChatterFor(agent);
          });
        } catch {
          // 同上的容忍
        }
      }
    } catch {
      // 没有 agents 服务（独立模式）→ 旁听不工作，其余照常
    }
  };
  mountChatter();
  // 【本鱼改造 · 对外服务】按宠物 id 现造一份服务：网关绑定该宠物所属条目的 model 段，
  // 与 /services/* 路由是同一条实现线（一份语义、两条入口）。
  // 【本鱼 · 10-30】看图/声音选「云端」时，地址与密钥沿用 AI 设置里那一份。
  //
  // 为什么不在设置页再填一遍：同一个 key 填三处，改一处忘两处是必然的；而两处密钥不一致
  // 排查起来极难受（一个能用一个 401，还看不出谁对）。所以这里做运行期补全，配置里
  // 只留"云端"和"模型名"（识图/TTS 的模型名通常和对话模型不同，必须能单独填）。
  // 只补空位：用户自己在配置文件里显式写了 baseUrl/apiKey 的，以他写的为准。
  /** 独立模式里那套「接口地址 + 自定义头」（插件模式下没有） */
  const standaloneConn = ():
    | { baseUrl: string; model?: string; apiKey: string; extraHeaders?: Record<string, string> }
    | undefined =>
    (
      ctx.standaloneAi as
        | {
            connection?: () => {
              baseUrl: string;
              model?: string;
              apiKey: string;
              extraHeaders?: Record<string, string>;
            };
          }
        | undefined
    )?.connection?.();
  /** 只有 baseUrl 与独立模式配的接口**完全一致**时才带自定义头：
   *  Go 的 x-opencode-session 发给 DeepSeek 就是多余甚至有害的东西。 */
  const backendHeaders = (baseUrl: string): Record<string, string> | undefined => {
    const conn = standaloneConn();
    if (!conn?.baseUrl) return undefined;
    const norm = (value: string): string => value.trim().replace(/\/+$/, '').toLowerCase();
    if (norm(baseUrl) !== norm(conn.baseUrl)) return undefined;
    return conn.extraHeaders;
  };
  // 【汐儿 · 11-20 m34651】补全交给 core 的唯一实现（fillRemoteBackends）：
  // 早先这里只补 vision/tts，chat 原样返回 —— 于是 model.chat 里那份历史快照
  // （DeepSeek 官方地址 + 哥哥自己的 key）永远赢过「AI 设置」，改设置像没生效。
  // 顺带补 model：识图/嗓子留空模型名时也要落到 AI 设置的模型上，否则报「还没填模型名」。
  const fillCloudBackend = (config: ReturnType<typeof parseModelConfig>): ReturnType<typeof parseModelConfig> =>
    fillRemoteBackends(config, standaloneConn());
  servicesProvider = (petId: string): PetServices => {
    const found = findPetInstance(readAllConfig(configPaths), petId);
    const conf = (found?.conf ?? {}) as Record<string, unknown>;
    const modelConfig = fillCloudBackend(parseModelConfig(conf.model));
    return createPetServices({
      core,
      gateway: createModelGateway({ readConfig: () => modelConfig, session: sessionChat , extraHeaders: backendHeaders }),
      ttsKind: () => (modelConfig.tts.backend.kind === 'local' ? 'local' : 'remote'),
    });
  };
  // ===================== 陪伴模式（默认关，从菜单/设置页开） =====================
  // 【本鱼改造 · 10-30】旧版在 extras 里靠 HTTP 回环 + 外部脚本（识图.py / 说话.py）；
  // 新版：截屏 → companion.ts 编排 → 气泡/识图/出声全走 services（一份语义两条入口）。
  // 截两次屏是**故意的**：小图算指纹（2304 字节，快且省内存），整图给识图看（能看清字）。
  const screenCapture = createScreenCapture({
    ffmpegPath: resolvedFfmpeg(),
    dir: layout.lookShots,
  });
  let companion: CompanionHandle | null = null;
  /** 陪伴当前实际用的间隔（菜单要据此打 ✓）；跑着时才有意义 */
  let companionIntervalMs = 0;
  /**
   * 【汐儿 · 11-19 m30590】配置里那只宠物的陪伴间隔（毫秒）。
   *
   * 为什么要有它：`companionIntervalMs` 只在 `startCompanion()` 里赋值、停下就清 0，
   * 于是「没启动过」时菜单标题只写「看一眼 · 关」，看不到它配的是 20 秒还是 5 分钟
   * （11-09 m16273 哥哥要求过「关着也要能看见」）。这里是只读兜底，不参与调度。
   */
  const configuredCompanionMs = (): number => {
    const conf = findPetInstance(readAllConfig(configPaths), 'main')?.conf as Record<string, unknown> | undefined;
    const section = conf?.companion;
    const n = Number((section as Record<string, unknown> | undefined)?.intervalMs);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
  };
  /**
   * 开陪伴。`overrideIntervalMs` 来自右键菜单选的档位——**只对本次生效**，不写配置：
   * 菜单是"临时调一下"的手感，改长期偏好该去设置页；把菜单点击写进配置文件会让
   * 「点一下试 45 秒」永久改掉用户的默认值，那种副作用不该藏在一次右键里。
   */
  /**
   * 聊天模型就绪吗（陪伴/看一眼/对话都靠它把画面和想法说成人话）。
   *
   * 独立版：`llm.stream` 由 `standalone/context.ts` 提供、`currentSelection().model` 是配好的模型名；
   * DSH 版：走宿主注入的 llm。**两者任一缺失就当没接模型**——哥哥 10-30 说得很明确：
   * 没模型就别给开，否则冒出来的只会是无意义的复读。
   */
  /**
   * 「有没有可用的聊天模型」——两种模式问法不同，别只认 DSH 的那一套：
   *   · 独立版：模型配置在 AI 设置里（`standaloneAi.isReady()`），DSH 的 agentDefaultModel 恒为空串；
   *   · 插件版：走 DSH 会话（`llm.stream` + 当前选择的模型）。
   * 之前只看后者，独立版就永远"未接入聊天模型"，陪伴/看一眼根本开不起来（哥哥 10-31 报的没声音=开不了）。
   */
  const chatModelReady = (): boolean => {
    if (ctx.standaloneAi?.isReady?.() === true) return true;
    return (
      typeof (ctx as { llm?: { stream?: unknown } }).llm?.stream === 'function' &&
      Boolean(ctx.agentDefaultModel?.currentSelection?.().model)
    );
  };

  const startCompanion = (overrideIntervalMs?: number): { ok: true } | { ok: false; message: string } => {
    // 【本鱼 · 11-02】哥哥点「陪伴：1 分钟」还是 45 秒、点了不生效：
    // 陪伴的间隔在 createCompanion 时定死，已经开着时点别的档位原来直接 return ok。现在——
    // 1) 真在跑且间隔没变 → 保持原样；2) 换了档位、或自己 idle 停了 → 停掉按新间隔重开。
    if (companion) {
      const running = companion.status().running;
      const wanted =
        typeof overrideIntervalMs === 'number' && Number.isFinite(overrideIntervalMs) && overrideIntervalMs > 0
          ? overrideIntervalMs
          : companionIntervalMs;
      if (running && wanted === companionIntervalMs) return { ok: true };
      stopCompanion();
    }
    try {
      const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
      const raw = (conf.companion ?? {}) as Record<string, unknown>;
      const intervalMs =
        typeof overrideIntervalMs === 'number' && Number.isFinite(overrideIntervalMs) && overrideIntervalMs > 0
          ? overrideIntervalMs
          : typeof raw.intervalMs === 'number'
            ? raw.intervalMs
            : undefined;
      companionIntervalMs = intervalMs ?? DEFAULT_INTERVAL_MS;
      // 菜单选的档位写回配置：下次点「陪伴」按这个来（哥哥 11-02 要「切换时间生效」）
      if (
        typeof overrideIntervalMs === 'number' &&
        Number.isFinite(overrideIntervalMs) &&
        overrideIntervalMs > 0
      ) {
        updateUserConfig((raw) => {
          const section =
            raw.companion !== null && typeof raw.companion === 'object'
              ? (raw.companion as Record<string, unknown>)
              : {};
          raw.companion = { ...section, intervalMs: overrideIntervalMs };
        });
      }
      // 【本鱼改造 · 10-30 哥哥反馈】陪伴要「念人话」而不是复述识图，所以**真的要用聊天模型**。
      // 没有聊天模型时直接明确告诉他，而不是先开起来、之后再吐一串识图报错。
      if (!chatModelReady()) return { ok: false, message: '未接入聊天模型' };
      // 嗓子/识图没接时**静默降级**：不出声、不截图说话，绝不冒一条报错气泡（哥哥 10-30 定）。
      const voiceReady = servicesProvider('main').voice.available().ready;
      // 【汐儿 · 11-16】陪伴到底会不会出声 = 嗓子就绪 + 她自己那个开关没关。
      // 不出声时必须立刻冒气泡（否则会等一个永远不会来的 play，字就没了）。
      const companionSpeaks = voiceReady && raw.voice !== false;
      companion = createCompanion({
        config: {
          ...(intervalMs !== undefined ? { intervalMs } : {}),
          ...(typeof raw.idleStopAfter === 'number' ? { idleStopAfter: raw.idleStopAfter } : {}),
          // 默认出声（哥哥要"每次都出声"）；真没接嗓子时上面已经乘掉了，这里不会空转
          voice: voiceReady && raw.voice !== false,
          ...(typeof raw.prompt === 'string' && raw.prompt.trim() ? { prompt: raw.prompt } : {}),
        },
        capture: () => screenCapture.capture(),
        // 两步走：先识图拿"看到了什么"，再交给**对话模型**说一句人话（而不是把描述原样念出来）。
        // 任何一步没接上/失败都返回空串 —— companion 把空串当"这一拍不说话"，不会报错也不会冒气泡。
        look: async (_thumb, _prompt) => {
          // 【本鱼 · 11-02】陪伴也要有「正在看」的状态：识图慢的时候别让哥哥以为卡死了。
          // 【汐儿 · 11-16 m23786】哥哥报「没开也挂着正在偷看」：原来 180 秒、成功之后也没人清。
          // 现在封顶 30 秒，并在这一拍结束时用 finally 撤掉。
          try {
          const eyes = servicesProvider('main').eyes.available();
          if (!eyes.ready) {
            debugTrace('[look] 识图没就绪：' + String(eyes.reason?.message ?? eyes.reason?.code ?? ''));
            return '';
          }
          const shot = screenCapture.lastShotPath();
          if (!shot) {
            debugTrace('[look] 没有截图路径（capture 没落盘？）');
            return '';
          }
          const live = await liveContext();
          let seen = '';
          try {
            // 【本鱼 · 11-02】陪伴也要「看得细」：注回会话的是这段详细描述，
            // 说出口的那句仍交给 companionLookPrompt 压成 20 字（见下面 generateChat）。
            seen = (await servicesProvider('main').eyes.look({ image: shot, prompt: lookPrompt(live.title) })).text;
          } catch (error) {
            debugTrace('[look] 识图失败：' + (error instanceof Error ? error.message : String(error)));
            return '';
          }
          const description = seen.trim();
          if (!description) {
            debugTrace('[look] 识图回了空描述');
            return '';
          }
          debugTrace('[look] 看到：' + description.slice(0, 120));
          // 接入 DSH 开着：本鱼只看不说，交给会话（哥哥 11-09 选 A）
          if (await bridgeHandoff('look', description)) {
            debugTrace('[look] 已交给 DSH 会话');
            return '';
          }
          const now = findPetInstance(readAllConfig(configPaths), 'main');
          if (!now) {
            debugTrace('[look] 找不到 main 这只会话配置');
            return '';
          }
          // 哥哥 11-09：看一眼也走同一个 30 分钟上下文 +「刚看到」，别和对话隔离开
          // 【汐儿 · 11-18 m27977】屏幕想也要知道自己刚说过什么、哥哥刚说过什么，
          // 否则她会对着屏幕反复说同一句（哥哥报的「重复的话」）。
          const system =
            petSystemPrompt(now) +
            (await memoryBlockFor('陪伴')) +
            (await recentSightBlock()) +
            '\n\n' +
            reasonBlock({ kind: 'watch', idleMs: lastIdleMs }) +
            contextBlock(live.line);
          const history = await recentMessages();
          const pool =
            now.conf.chatImageEnabled === true
              ? limitPool(memePoolFor(now.entry, now.conf), Number(now.conf.chatImageLimit))
              : [];
          const generated = await thinkOnScreen((signal) =>
            usesOwnModel(now.conf)
              ? generateChatViaGateway(
                  gatewayFor(now.conf),
                  system,
                  history,
                  companionLookPrompt(description),
                  pool,
                  undefined,
                  signal,
                )
              : generateChat(
                  ctx,
                  system,
                  history,
                  companionLookPrompt(description),
                  pool,
                  configuredModel(now.conf, 'chatModel'),
                ),
          );
          if (!generated.ok) {
            debugTrace('[look] 说话失败：' + generated.message);
            return '';
          }
          debugTrace('[look] 说：' + generated.text);
          // 说出口的话进对话历史（和对话/陪伴同一个池）
          void memoryStore.remember({ role: 'pet', text: generated.text.trim(), source: 'chat' }).catch(() => {});
          // 【本鱼 · 11-02】陪伴看到的画面也要塞回会话：哥哥说「陪伴好像没有塞入会话」
          void (async () => {
            try {
              const bridge = await refreshDshBridge();
              if (bridge.enabled && dshBridgeUrl !== '') {
                await sayToDsh(dshBridgeUrl, imageHandoffText(description));
              }
            } catch (error) {
              debugTrace('[look] 描述塞回会话失败：' + (error instanceof Error ? error.message : String(error)));
            }
          })();
          return generated.text;
          } finally {
            // 不管看到没看到、说没说出口，这一拍结束就把「正在偷看」撤掉
            dropHint('status');
          }
        },
        bubble: async (text, opts) => {
          // 【汐儿 · 11-17 第 2 批】陪伴是「看到」触发：产一条 seen（2 级），等级自带。
          // 【11-19】改走接线表：`sources/vision` 产事件，`registry.emitSense` 记账。
          registry.emitSense(visionEvent({ text, ...(opts?.image === undefined ? {} : { imageName: opts.image }) }));
          // 【汐儿 · 11-16】不再「先冒泡再说」：记下这句话，等音频真的开始由 runSpeakClip 写，
          // 气泡和声音同一个起点。合成慢就 400 毫秒后先冒一行占位，真出声时被正式气泡盖掉。
          if (!companionSpeaks) {
            await servicesProvider('main').bubble.say({ petId: 'main', text, ...(opts?.image ? { image: opts.image } : {}) });
            return;
          }
          companionPending = opts?.image ? { text, image: opts.image } : { text };
          clearCompanionPlaceholder();
          // 兜底：play 一直没来（被跳过 / 被顶掉 / 生成中途换拍），1.5 秒后把真话写出来
          companionFlush = setTimeout(() => {
            companionFlush = null;
            if (companionPending === null) return;
            const lost = companionPending;
            companionPending = null;
            writeSayBubble(
              'main',
              'companion',
              lost.image === undefined ? { text: lost.text } : { text: lost.text, image: lost.image },
            );
            noteBubble(`flush-no-play pet=main chars=${lost.text.length}`);
          }, 1500);
          companionFlush.unref?.();
        },
        // 只有嗓子真的就绪才注入：没接嗓子 = 完全不出声，而不是每拍都试一次、留一串失败日志。
        // 注入时也不吞错——companion 自己会 catch 并只记日志，不会再冒第二条报错气泡。
        // 【本鱼 10-30】play 必须显式给：companion 的 defaultPlay 依赖 PATH 里的 ffplay，
        // 打包后的进程 PATH 里没有它 → 合成成功却一声不响（哥哥报的「陪伴没声音」就是这个）。
        ...(voiceReady
          ? {
              speak: async (text: string) => {
                try {
                  return (await servicesProvider('main').voice.speak({ text })).audio;
                } catch (error) {
                  // 合成失败 = 只会冒字：把记下的那句话写出来，别因为改时序把字也弄丢
                  if (companionPending !== null) {
                    const lost = companionPending;
                    companionPending = null;
                    clearCompanionPlaceholder();
                    writeSayBubble(
                      'main',
                      'companion',
                      lost.image === undefined ? { text: lost.text } : { text: lost.text, image: lost.image },
                    );
                    noteBubble(`speak-failed pet=main chars=${lost.text.length}`);
                  }
                  throw error;
                }
              },
              play: async (audio: Uint8Array) => {
                // 【汐儿 · 11-15】陪伴的自动出声也走仲裁：跟对话/碎碎念排同一条队，不再自己开播放器。
                // 【汐儿 · 11-16】气泡交给 runSpeakClip 在播放开始时写（这里把刚记下的那句话带过去）。
                const pending = companionPending;
                companionPending = null;
                clearCompanionPlaceholder();
                const flushPending = (): void => {
                  if (pending === null) return;
                  writeSayBubble(
                    'main',
                    'companion',
                    pending.image === undefined ? { text: pending.text } : { text: pending.text, image: pending.image },
                  );
                  noteBubble(`play-failed pet=main chars=${pending.text.length}`);
                };
                await centerPlayClip({
                  audio,
                  mime: 'audio/wav',
                  text: pending === null ? '（陪伴）' : pending.text,
                  priority: 'low',
                  ...(pending === null ? {} : { bubbleText: pending.text }),
                  ...(pending === null || pending.image === undefined ? {} : { bubbleImage: pending.image }),
                }).catch((error: unknown) => {
                  // 播放这条路出错 = 只会冒字，把字补上；错误照旧往外抛（companion 自己会记日志）
                  flushPending();
                  throw error;
                });
                debugTrace('[companion] 出声完成 ' + audio.length + ' 字节');
              },
            }
          : {}),
        pickMeme: () => {
          const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
          return pickMeme(memePoolFor('main', conf))?.name;
        },
        log: (message) => {
          debugTrace('[companion] ' + message);
          console.log(message);
        },
      });
      companion.start();
      return { ok: true };
    } catch (error) {
      companion = null;
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  const stopCompanion = (): void => {
    companion?.stop();
    companion = null;
    companionIntervalMs = 0;
  };
  // ===================== 看护模式（本鱼 · 11-09） =====================
  // 和陪伴的分工：陪伴答「现在是什么」（每 N 分钟一整张图），
  // 看护答「这段时间**从什么变成了什么**」——12fps 常驻看一条流，
  // 只在画面真换了 / 一直在动攒够了 / 太久没看过 时拼 4 帧成一张问一句。
  // 选帧引擎在 ./watch-mode，这里只管「拼图 → 识图 → 冒泡」。
  //
  // **故意不往 DSH 会话里贴图**：一张 798×462 拼图约 173KB base64，
  // 攒到 DSH 的 20MiB 上限就会把历史里的老图永久换成路径占位，
  // 前缀缓存从那一张往后全废（社区实测每省略一张后面十几万 token 重算）。
  // 【汐儿 · 11-19 m30590】以前这里写死 `D:\AI\GPT-SoVITS\ffmpeg.exe`，那份**没有 ddagrab**，
  // 陪伴抓屏连着三次 `No such filter: 'ddagrab'` 后自动停（哥哥：打开陪伴过一会儿它自己关了）。
  // 现在交给 `capture.ts` 的 `resolvedFfmpeg()`：按候选顺序挑第一份真带 ddagrab 的。
  const watchFfmpeg = (): string | undefined => resolvedFfmpeg();
  // —— v2（本鱼 · 11-09 晚）：**出图 ≠ 说话** ——
  // 哥哥的原话：「画面并不是一变化一看完图他就开始发言，而是需要等一个契机」。
  // 所以拆成两步：
  //   ① 每张图只记一行笔记（「变了什么 + 有多重要」），攒够 20 分钟；
  //   ② 够格开口时才把笔记 + 上次说过什么一起给模型，让它自己判断「现在值不值得说一句」，
  //      不值得就回 `-` 闭嘴。代码只管两条硬边界：不到 10 秒不许说、超过 3 分钟必须兜底说一句。
  // 笔记同时写进当天记忆（source='watch'），跨重启还能接上「上午在写代码、下午在剪视频」。
  const WATCH_NOTES_MS = WATCH_NOTES_MS_SHARED;
  const WATCH_MIN_GAP_MS = WATCH_MIN_GAP_MS_SHARED;
  const WATCH_FALLBACK_MS = WATCH_FALLBACK_MS_SHARED;
  interface WatchNote {
    at: number;
    note: string;
    imp: number;
  }
  let watchNotes: WatchNote[] = [];
  let watchLastSpokeAt = 0;
  let watchLastSaid = '';
  /** 上一张还在识图/说话就跳过这一张：图一张接一张地来，别把模型调用堆成山 */
  let watchBusy = false;

  const hhmm = (at: number): string => {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  /** 陪伴要不要出声（哥哥 11-09：陪伴单独一个开关，默认关；菜单里点一下开） */
  const watchSpeakEnabled = (): boolean => {
    const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
    const section = (conf.watch ?? {}) as Record<string, unknown>;
    return section.speak === true;
  };
  /** 陪伴那一整段配置（现读，改完不用重启） */
  const watchSection = (): Record<string, unknown> => {
    const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
    const section = conf.watch;
    return section !== null && typeof section === 'object' && !Array.isArray(section)
      ? (section as Record<string, unknown>)
      : {};
  };
  /** 调参（设置页写 watch.tuning；缺项/非法由 normalizeTuning 夹回默认） */
  const watchTuning = (): WatchTuning => normalizeTuning(watchSection().tuning as Partial<WatchTuning> | null);
  /**
   * 陪伴模式：自动检测 / 游戏 / 视频（哥哥 11-11 m19041「这样不容易错」）。
   * 现读配置 —— 菜单里点一下就换，不用重启。
   */
  const watchMode = (): WatchMode => normalizeWatchMode(watchSection().mode);
  /** 手动模式认死哪个窗口（hwnd，0 = 没选）。 */
  const manualHwnd = (): number => {
    const value = watchSection().windowHwnd;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  };
  /** B站登录信息（看视频抓字幕用）；没填就是空串。 */
  const subtitleSessData = (): string => {
    const section = (readAllConfig(configPaths)[0] as Record<string, unknown> | undefined)?.subtitle;
    if (section === null || typeof section !== 'object') return '';
    const value = (section as Record<string, unknown>).sessData;
    return typeof value === 'string' ? value : '';
  };
  /**
   * 提示词模板：空串 = 用内置默认。
   * 【汐儿 · 11-16 m21304】只剩一套：哥哥说「只需要一套，不用再去切换提示词增加消耗」。
   */
  /**
   * 【11-20 体检】配置里存着的模板，等于出厂默认（含历史版本）的一律当「没设过」。
   * 不然代码改提示词只是自娱自乐：老配置里那份副本会一直盖在上面（实测陪伴到 0.6
   * 还在用 0.5.0 的模板，看不到 {{window}} / {{context}}）。
   */
  const watchTemplates = (): { prompt: string; detail: string } => {
    const section = watchSection();
    return {
      prompt: freshTemplate(section.prompt, WATCH_STOCK),
      detail: freshTemplate(section.detailPrompt, DETAIL_STOCK),
    };
  };
  /** 两次开口至少隔多久（秒 → 毫秒），默认 45 秒 */
  const watchTalkGapMs = (): number => {
    const value = watchSection().talkGapSec;
    const sec = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 45;
    return Math.max(2, sec) * 1000;
  };
  /** 超过这么久没开口就必须说一句（毫秒），默认 3 分钟 */
  const watchFallbackMs = (): number => {
    const value = watchSection().fallbackSec;
    const sec = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 180;
    return Math.max(10, sec) * 1000;
  };
  /** 剥掉旧的日记前缀，只留一句重点 */
  const digestHighlight = (text: string): void => {
    const line = text.replace(/\s+/g, ' ').trim();
    if (line === '') return;
    void memoryStore.digest(line).catch(() => {});
  };
  const pruneWatchNotes = (nowMs: number): void => {
    const kept = watchNotes.filter((n) => nowMs - n.at <= WATCH_NOTES_MS);
    if (kept.length !== watchNotes.length) watchNotes = kept;
  };
  /**
   * 【汐儿 · 11-10 m17986 第一刀】识图和说话合成**一次**模型调用。
   *
   * 旧链路是两次往返：先看图问「他身上发生了什么」，再问一次「现在该说什么」——
   * 实测识图 3.4~4.8 秒、第二次 1~3 秒，从屏幕有事到听见声音要 6~10 秒。
   * 现在一次拿回「关键点 / 重要性 / 要说的话 / 现况」，第二次往返直接没了。
   *
   * 顺手把场景档案（第 5 刀）也接上：一份 ≤200 字的滚动现况，下次识图时带进 prompt，
   * 她才有「接着上一眼往下看」的连续性，而不是每张图都从零认。
   */
  let watchScene: SceneArchive = emptyScene();
  let watchSceneSavedAt = 0;
  /** 上一次量到的键鼠空闲时长（毫秒）；-1 = 还没量过 */
  let lastIdleMs = -1;
  /**
   * 「他这会儿」的公共时间线（哥哥 m31134：窗口名/网址/空闲不只给陪伴）。
   * 聊天、一眼看、回看、说一句都往这一份里记；谁的模型调用前谁拿一次。
   */
  let liveTimeline: TimelineEntry[] = [];
  /**
   * 现读一次前台 → 一行上下文（读不到就空串）。
   * 读一次 PowerShell 要 0.45 秒（冷启 0.8 秒），聊天本来就只等一两秒，不能每次都白等 ——
   * 5 秒内复用同一份（时间线/空闲都是慢变量，5 秒的偏差看不出来）。
   */
  let liveCacheAt = 0;
  let liveCacheLine = '';
  let liveCacheTitle = '';
  const liveContext = async (): Promise<{ line: string; title: string }> => {
    const now = Date.now();
    if (liveCacheAt !== 0 && now - liveCacheAt < 5_000) {
      return { line: liveCacheLine, title: liveCacheTitle };
    }
    const got = await readLiveContext({
      readForeground,
      tidy: pageName,
      timeline: () => liveTimeline,
      remember: (label, at) => {
        liveTimeline = pushTimeline(liveTimeline, { at, label });
      },
    });
    if (got.idleMs >= 0) lastIdleMs = got.idleMs;
    if (got.line !== '') {
      liveCacheAt = now;
      liveCacheLine = got.line;
      liveCacheTitle = got.title;
    }
    return { line: got.line, title: got.title };
  };
  /** 上下文块的固定写法：空串就什么都不加。 */
  const contextBlock = (line: string): string =>
    line === ''
      ? ''
      : `\n\n【他这会儿】${line}\n（这是背景：你知道他在忙什么，别一条条念出来，也别反问他「你在干嘛」。）`;
  /**
   * 查资料的账本（本鱼 · 11-10 m18596）。
   * 按名字缓存 6 小时、每天最多查 12 个不同的名字——同一款游戏只烧一次配额，
   * 突变那几张只吃缓存，不会因为「刚切窗口」额外多一次网络请求。
   */
  // 【汐儿 · 11-16 m21257】取景改成三档（全屏 / 自动 / 窗口）：仍然整屏抓、内存里裁。
  // 上次（11-10）拿窗口矩形直接喂 gdigrab 是错的——逻辑像素 vs 物理像素差 1.5 倍，
  // 只会截到屏幕左上角，而且坏得看不出来。现在只让 gdigrab 抓整屏，裁剪在内存里做。
  let lastFg: ForegroundInfo | null = null;
  let cropCache: { rect: { x: number; y: number; w: number; h: number }; screenW: number; screenH: number } | null = null;
  let lastTargetLabel = '（整屏）';
  let lastTargetWin: WindowInfo | null = null;
  /** 现读一次前台/目标窗口，算出这一眼该裁哪块（全屏模式直接 null）。 */
  const refreshTarget = async (): Promise<void> => {
    const mode = watchMode();
    if (mode === 'full') {
      cropCache = null;
      lastTargetLabel = '（整屏）';
      lastTargetWin = null;
      return;
    }
    if (mode === 'window') {
      const wanted = manualHwnd();
      if (wanted <= 0) {
        cropCache = null;
        lastTargetLabel = '（整屏）';
        return;
      }
      const list = await listWindows(4_000);
      const hit = list.find((entry) => entry.hwnd === wanted);
      const win = hit === undefined ? null : (pickWindow([hit], wanted) ?? null);
      if (win === null) {
        cropCache = null;
        lastTargetLabel = '（那个窗口找不着了，先看整屏）';
        lastTargetWin = null;
        return;
      }
      lastTargetWin = win;
      lastTargetLabel = targetLine(win, 'window', '');
      cropCache = { rect: win.rect, screenW: lastFg?.screen.w ?? 0, screenH: lastFg?.screen.h ?? 0 };
      if (cropCache.screenW <= 0) cropCache = null;
      return;
    }
    const info = await readForeground(1_200);
    lastFg = info;
    const win = pickWindow([{ hwnd: info.hwnd, title: info.title, exe: info.exe, rect: info.rect }]) ?? null;
    if (win === null) {
      cropCache = null;
      lastTargetLabel = '（整屏）';
      lastTargetWin = null;
      return;
    }
    lastTargetWin = win;
    lastTargetLabel = targetLine(win, 'auto', info.url);
    cropCache = info.screen.w > 0 ? { rect: win.rect, screenW: info.screen.w, screenH: info.screen.h } : null;
  };
  // 【汐儿 · 11-11 m19834】视频字幕：登录信息填在宠物配置的 subtitle.sessData，
  // 同一个 BV 号两分钟内只抓一次；没填 cookie 就直接跳过，不报错。
  const subtitleBook = createSubtitleBook({ cookie: () => subtitleSessData() });
  /**
   * 聊天/语音里的「上网查」（本鱼 · 11-11 m20130 + m20199）。
   * 哥哥定：上网找、不做本地文件搜索、**她自己判断**（所以他后来说「直接把工具给模型」）、
   * 开关放状态子菜单、默认开、不设次数上限。
   * 这里只管两头：**耗时有封顶**（搜索 2 秒到点放弃）、**搜不到就明说没查到**；
   * 搜索预算与缓存在 chat-search 里，同一个查询 10 分钟内只搜一次。
   */
  const logChatSearch = (line: string): void => {
    try {
      const dir = join(userRoot, 'logs');
      mkdirSync(dir, { recursive: true });
      noteLog('mind.log', 'search', line);
    } catch {
      /* 日志写不进去不能影响回话 */
    }
  };
  /** 联网查资料的总开关：只有显式写 `search.enabled = false` 才算关（默认开） */
  /** 耳朵常驻（配置 ear.resident；没设 = 关。菜单与设置页改的是同一个字段） */
  const earResident = (): boolean => {
    const found = findPetInstance(readAllConfig(configPaths), 'main');
    const section = (found?.conf.ear ?? null) as Record<string, unknown> | null;
    return section?.resident === true;
  };
  const searchEnabled = (): boolean => {
    const found = findPetInstance(readAllConfig(configPaths), 'main');
    const section = (found?.conf.search ?? null) as Record<string, unknown> | null;
    return section?.enabled !== false;
  };
  /**
   * 搜索来源（【汐儿 · 11-22 m35769】哥哥：「现在的联网查效果太差了……不过免费接口也要保留」）。
   * `free` = 抓搜索引擎结果页；`deepseek` = DeepSeek 搜索 API（每条带 600~800 字长摘要）。
   * 选了 deepseek 但没填 key 时按 free 跑——不然她这轮会白等一个 2 秒的失败。
   */
  const searchSource = (): SearchProvider => {
    const found = findPetInstance(readAllConfig(configPaths), 'main');
    const section = (found?.conf.search ?? null) as Record<string, unknown> | null;
    const apiKey = typeof section?.apiKey === 'string' ? section.apiKey.trim() : '';
    const wanted = section?.provider === 'deepseek' ? 'deepseek' : 'free';
    const baseUrl =
      typeof section?.baseUrl === 'string' && section.baseUrl.trim() !== ''
        ? section.baseUrl.trim()
        : 'https://api.deepseek.com';
    const model = typeof section?.model === 'string' ? section.model.trim() : '';
    return { kind: apiKey === '' ? 'free' : wanted, baseUrl, apiKey, model };
  };
  const searchRunner = createSearchRunner({ provider: searchSource });
  const watchSceneDir = layout.watchNotes;
  const watchScenePath = join(watchSceneDir, 'scene.json');
  // 【汐儿 · 11-11 m20008】视频模式改成「单张图 + 整片剧情梗概」：
  // 字幕落 `陪伴\字幕`，压好的梗概落 `陪伴\剧情`（哥哥要求分好类、定时删）。
  const storySubtitleDir = layout.watchSubtitles;
  const storyTextDir = layout.watchStory;
  /** 视频、网页模式只要单张（宫格太慢）；游戏维持单帧 + 六宫格 */
  const storyCache = createStoryCache({
    subtitleDir: storySubtitleDir,
    storyDir: storyTextDir,
    fetchLines: (url) => subtitleBook.allFor(url),
    ask: async (prompt, system) => {
      const found = findPetInstance(readAllConfig(configPaths), 'main');
      if (found === undefined) return '';
      try {
        const gateway = createModelGateway({
          readConfig: () => fillCloudBackend(parseModelConfig(found.conf.model)),
          session: null,
          extraHeaders: backendHeaders,
        });
        const result = await generateChatViaGateway(gateway, system, [], prompt, [], 60_000);
        return result.ok ? result.text : '';
      } catch {
        return '';
      }
    },
    keepDays: 30,
    log: (message) => console.log('[剧情] ' + message),
  });
  // 两次开口的间隔与兜底都从配置读（watch.talkGapSec / watch.fallbackSec）
  const loadWatchScene = async (): Promise<void> => {
    try {
      const raw = await readFile(watchScenePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SceneArchive>;
      watchScene = {
        ...emptyScene(),
        ...parsed,
        events: Array.isArray(parsed.events) ? parsed.events.slice(-5) : [],
        talked: Array.isArray(parsed.talked) ? parsed.talked.slice(-5) : [],
        lookedUp: Array.isArray(parsed.lookedUp) ? parsed.lookedUp.slice(-8) : [],
        topics: Array.isArray(parsed.topics) ? parsed.topics.slice(-12) : [],
      };
    } catch {
      /* 第一次跑没有档案，很正常 */
    }
  };
  /** 写盘节流：最多一分钟写一次，别每张图都砸硬盘 */
  const saveWatchScene = (): void => {
    const now = Date.now();
    if (now - watchSceneSavedAt < 60_000) return;
    watchSceneSavedAt = now;
    void (async () => {
      try {
        await mkdir(watchSceneDir, { recursive: true });
        await writeFile(watchScenePath, JSON.stringify(watchScene, null, 2), 'utf8');
      } catch {
        /* 写不进去就算了，档案是辅助不是命脉 */
      }
    })();
  };
  /** 话题主题：同一款游戏里的同一件事才算一条（用来合并池子里的重复） */
  const topicKey = (game: string, event: string, note: string): string =>
    `${game}|${event.trim() === '' ? note.slice(0, 10) : event.trim()}`;

  /** 哥哥 11-09 晚 m16399：「我得看看笔记和上下文的记录，还有识图到底看了些什么」。
   *  所以每次陪伴出图都留档：${userRoot}/logs/陪伴/YYYY-MM-DD.jsonl 一行 + sheets/ 里一张 PNG。
   *  写失败只丢记录，绝不影响看护本身。 */
  const watchLogDir = layout.watchNotes;
  const watchSheetDir = layout.watchShots;
  /* 【汐儿 · 11-19 m30766/m30770】陪伴攒宫格：环形缓冲留最近 6 帧（每张 ~150KB），
   * 攒够 3 张、且离上次拼图超过 20 秒才拼一张 3×2 —— 拼一次 ~0.4 秒，别每张都拼。
   * 手动「看一眼」走 lookOnce，不走这里，保持单张（哥哥定的）。 */
  const gridDir = join(watchSheetDir, 'grid');
  const gridRing: { at: number; image: Buffer }[] = [];
  let gridLastAt = 0;
  let watchTimeline: TimelineEntry[] = [];
  /** 新一轮陪伴开始/结束都清一遍：旧帧拼进新宫格 = 她描述的是十几分钟前的屏幕（11-20 哥哥问「拼图做了吗」时查出来的） */
  const resetGridRing = (): void => {
    gridRing.length = 0;
    gridLastAt = 0;
    watchTimeline = [];
  };
  const rememberGridFrame = (image: Buffer, at: number): void => {
    gridRing.push({ at, image });
    while (gridRing.length > GRID_FRAMES) gridRing.shift();
  };
  // 【11-20 体检】这里出的是 JPEG，字段还叫 png 会误导后来人（也误导我自己一次）
  const maybeComposeGrid = async (): Promise<{ image: Buffer; frames: number; ms: number } | null> => {
    const now = Date.now();
    if (gridRing.length < 3 || now - gridLastAt < 20_000) return null;
    const bin = resolvedFfmpeg();
    if (bin === undefined) return null;
    const picked = gridRing.slice(-GRID_FRAMES);
    const files: string[] = [];
    try {
      await mkdir(gridDir, { recursive: true });
      for (let i = 0; i < picked.length; i += 1) {
        const frame = picked[i] as { at: number; image: Buffer };
        const file = join(gridDir, `f${i}-${frame.at}.jpg`);
        await writeFile(file, frame.image);
        files.push(file);
      }
      const out = join(gridDir, `grid-${now}.jpg`);
      const result = await composeGrid({
        frames: files.map((file, i) => ({ file, at: (picked[i] as { at: number }).at })),
        out,
        ffmpegPath: bin,
      });
      if (!result.ok) {
        debugTrace('[watch] 拼宫格失败：' + String(result.message ?? ''));
        return null;
      }
      const image = await readFile(result.out);
      gridLastAt = now;
      noteLog('mind.log', 'grid', `frames=${result.frames} ms=${result.ms} bytes=${image.length}`);
      return { image, frames: result.frames, ms: result.ms };
    } catch (error) {
      debugTrace('[watch] 拼宫格出错：' + (error instanceof Error ? error.message : String(error)));
      return null;
    } finally {
      removeQuietly(files);
      removeQuietly([join(gridDir, `grid-${now}.jpg`)]);
    }
  };
  const appendWatchLog = (entry: Record<string, unknown>): void => {
    void (async () => {
      try {
        await mkdir(watchSheetDir, { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        await appendFile(join(watchLogDir, `${day}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');
      } catch {
        /* 记录写不进去就算了 */
      }
    })();
  };
  const saveWatchSheet = async (png: Buffer, meta: WatchSheetMeta): Promise<string> => {
    try {
      await mkdir(watchSheetDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      // 【11-20 体检】内容是 JPEG（encodeJpeg 出的），扩展名别再说谎；
      // 老的 .png 清理时一并收（见 pruneWatchSheets）。
      const name = `${stamp}_${meta.reason}.jpg`;
      await writeFile(join(watchSheetDir, name), png);
      await pruneWatchSheets();
      return name;
    } catch {
      return '';
    }
  };
  /** 哥哥 11-09 晚 m16721 说留一天；11-20 m32088 改成「别留太多」→ 3 天 / 150MB（原来是 1 天 / 200MB）。
   *  规则在 ./retention（先按 24 小时、再按 200MB，从最老的删，永远留最新 20 张）。 */
  const pruneWatchSheets = async (): Promise<void> => {
    const now = Date.now();
    const log = (line: string): void => console.log(line);
    // 0.6 起是 .jpg；0.5.x 留下的是 .png（内容同样是 JPEG），两种都要收，不然老图永远清不掉。
    for (const ext of ['.jpg', '.png']) {
      await pruneDir(watchSheetDir, { now, keepDays: 3, maxBytes: 150 * 1024 * 1024, ext, log });
    }
  };
  const watchSheet = async (png: Buffer, meta: WatchSheetMeta): Promise<void> => {
    const eyes = servicesProvider('main').eyes.available();
    if (!eyes.ready) {
      debugTrace('[watch] 识图没就绪：' + String(eyes.reason?.message ?? ''));
      return;
    }
    if (watchBusy) {
      debugTrace('[watch] 上一张还没处理完，跳过 #' + meta.index);
      return;
    }
    watchBusy = true;
    const t0 = Date.now();
    pushHint('watch', '【在看】', 'task');
    // 【汐儿 · 11-16 体检 B3】准备段以前在 try 外面：readForeground / refreshTarget / storyCache
    // 任何一个抛异常，watchBusy 就永远是 true（之后每张图都被「上一张还没处理完」挡掉），
    // 【在看】也一直挂着。现在全部圈进来，出错走同一个出口。
    let fg: ForegroundInfo;
    let targetWin: WindowInfo | null = null;
    let title = '';
    let winLine = '';
    let story: Awaited<ReturnType<typeof storyCache.get>> = null;
    try {
      // 前台窗口 + 空闲时长 + 浏览器网址一次拿到（本鱼 · 11-10 m18596 / 11-11 m19041）：
      // 窗口标题里往往就是游戏名，浏览器里就是页面标题，地址栏还能给出网址——
      // 有了这些才分得清「在打游戏 / 在看视频 / 在看网页」，也才有名字去查资料。
      // 字符串不经过坐标系，所以没有 11-09 那个 DPI 坑。
      fg = await readForeground();
      if (fg.idleMs >= 0) lastIdleMs = fg.idleMs;
      lastFg = fg;
      await refreshTarget();
      // 【汐儿 · 11-16 m21257/m21304】不再分游戏/视频/网页三套逻辑，也不再「先查资料再说话」：
      // 名字就是窗口标题（剥掉浏览器尾巴），查不查由她自己决定（提示词里教她输出检索标记）。
      targetWin = lastTargetWin;
      title = targetWin === null ? pageName(fg.title) : pageName(targetWin.title);
      winLine = targetWin === null ? '（整屏，没读到具体窗口）' : lastTargetLabel;
      // B站剧情梗概留着（哥哥 11-16 m21310「b站的部分我支持你留」）：有网址才取，拿不到就 null。
      story = fg.url.includes('bilibili.com/video/') ? await storyCache.get(fg.url, title) : null;
    } catch (error) {
      debugTrace('[watch] 取景准备失败：' + String(error instanceof Error ? error.message : error));
      watchBusy = false;
      dropHint('watch');
      return;
    }
    // 【汐儿 · 11-19 m30770】他这会儿：①窗口时间线（名字变了才记）②离开多久 ③窗口形状+屏幕尺寸
    if (title !== '') watchTimeline = pushTimeline(watchTimeline, { at: t0, label: title });
    // 【汐儿 · 11-22 m35769】窗口名也进日志（以前只写在陪伴 jsonl 里，`mind.log` 里查不到）
    noteLog('mind.log', 'watch', `win=${title === '' ? '-' : title}`);
    const screenCtx = contextLine({
      timeline: watchTimeline,
      idleMs: fg.idleMs,
      rect: targetWin?.rect ?? fg.rect,
      screen: fg.screen,
      now: t0,
    });
    let spoke = '';
    let gridFrames = 0;
    let gridMs = 0;
    let gateBusy = false;
    /**
     * 说一句。三道闸都在这：45 秒间隔 / 他停手了（重要性 3 例外）/ 接入接管。
     * 【汐儿 · 11-10 m17986 第三刀】流式和整段处理共用这一个口子，
     * 所以「话先到嘴」时能立刻开口，不必等「现况」那几行也生成完。
     */
    const trySpeak = async (
      text: string,
      imp: number,
      note: string,
    ): Promise<'said' | 'gap' | 'busy' | 'bridge' | 'dupe' | 'empty'> => {
      if (spoke !== '') return 'said';
      if (gateBusy) return 'dupe';
      const clipped = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      if (clipped === '') return 'empty';
      gateBusy = true;
      try {
        const nowMs = Date.now();
        const elapsed = watchLastSpokeAt === 0 ? watchFallbackMs() : nowMs - watchLastSpokeAt;
        // 最大兜底留着（超过 3 分钟没开口就免掉「等他停手」），但按新时机基本不会触发
        const force = elapsed >= watchFallbackMs();
        if (watchLastSpokeAt !== 0 && nowMs - watchLastSpokeAt < watchTalkGapMs() && !force) return 'gap';
        // 【汐儿 · 11-10 m18204 哥哥拍板】「本身就不需要操作时才接话」——
        // 打游戏手基本不停，旧闸门（idle<2 秒就不许说）把 83/87 张图全吞了。
        // 现在不看他停没停手，开不开口交给她自己判断（提示词里写清「没意思就写 -」）。
        // 接入 DSH 开着：把看到的交给会话，身体不再自己说（哥哥 11-09 选 A）
        if (await bridgeHandoff('watch', note)) {
          watchLastSpokeAt = Date.now();
          debugTrace('[watch] 交给 DSH 会话');
          return 'bridge';
        }
        watchLastSpokeAt = Date.now();
        watchLastSaid = clipped;
        spoke = clipped;
        // 走同一个喇叭：陪伴的优先级最高，上一句没说完就排队等
        void centerSay({
          priority: 'high',
          text: clipped,
          voice: watchSpeakEnabled(),
          source: 'companion',
          fallbackMs: 12_000,
        });
        return 'said';
      } finally {
        gateBusy = false;
      }
    };
    try {
      const found = findPetInstance(readAllConfig(configPaths), 'main');
      const persona = found ? petSystemPrompt(found) : '';
      const tpl = watchTemplates();
      // 【汐儿 · 11-19 m30766】攒够就拼一张 3×2 送识图，比单帧更能看出「刚才在干嘛」
      rememberGridFrame(png, t0);
      const grid = await maybeComposeGrid();
      gridFrames = grid === null ? 0 : grid.frames;
      gridMs = grid === null ? 0 : grid.ms;
      const lookImage = grid === null ? png : grid.image;
      // 【汐儿 · 11-16 m21304】一套提示词；「查不查」交给模型自己判断（它输出 [[web_search: 词]]）
      const prompt = buildWatchPrompt({
        scene: watchScene,
        notes: watchNotes,
        lastSaid: watchLastSaid,
        lastSaidAgoMs: watchLastSpokeAt === 0 ? 0 : Date.now() - watchLastSpokeAt,
        idleMs: lastIdleMs,
        persona,
        cropped: meta.cropped,
        window: winLine,
        context: screenCtx,
        ...(grid === null ? {} : { grid: true }),
        ...(story !== null ? { bili: story.summary } : {}),
        impNeed: watchImpNeed(),
        template: tpl.prompt,
      });
      // 流式：一句一句收，第一行「要说的话」够了就先开口，剩下的（现况/游戏名）边生成边看
      let streamed = '';
      let consumedUpTo = 0;
      const early = { say: '', imp: 0, note: '', fired: false };
      const onDelta = (chunk: string): void => {
        streamed += chunk;
        for (;;) {
          const nl = streamed.indexOf('\n', consumedUpTo);
          if (nl < 0) break;
          const line = streamed.slice(consumedUpTo, nl).trim();
          consumedUpTo = nl + 1;
          const hit = /^([1-7])\s*[|｜]\s*(.*)$/u.exec(line);
          if (!hit) continue;
          const slot = hit[1];
          const body = (hit[2] ?? '').trim();
          if (slot === '3') {
            const said = body.replace(/^(要说的话|说话|say)\s*[:：]?\s*/i, '').trim();
            if (said !== '' && !/^[-－—]+$/u.test(said)) early.say = said;
          } else if (slot === '2') {
            const n = Number((/\d/.exec(body) ?? ['2'])[0]);
            early.imp = n >= 1 && n <= 3 ? n : 2;
          } else if (slot === '1') {
            early.note = body;
          }
          if (!early.fired && early.say !== '' && early.imp > 0) {
            early.fired = true;
            const wait = Date.now() - t0;
            void trySpeak(early.say, early.imp, early.note).then((result) => {
              debugTrace(`[watch] 流式开口（${wait}ms 时拿到话）：${result} ${early.say}`);
            });
          }
        }
      };
      // 只此一次调用：要说的话、关键点、重要性、现况一起回来
      const seen = await servicesProvider('main').eyes.look({ image: lookImage, prompt, onDelta });
      const noteMs = Date.now() - t0;
      const reply = parseWatchReply(String(seen.text ?? ''));
      const idleMs = fg.idleMs;
      if (reply.note === '') return;
      // 【汐儿 · 11-10 m18222】她要看细节：拿「最近那一帧」的单张大图再问一次（每张六宫格最多一次）
      let detailText = '';
      let detailMs = 0;
      if (reply.detail !== '' && meta.cropped) {
        const d0 = Date.now();
        try {
          const still = await grabStill(watchFfmpeg());
          const ask = await servicesProvider('main').eyes.look({
            image: still,
            prompt: buildDetailPrompt(reply.detail, tpl.detail, title),
          });
          detailText = String(ask.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
        } catch (error) {
          debugTrace('[watch] 回看失败：' + (error instanceof Error ? error.message : String(error)));
        }
        detailMs = Date.now() - d0;
        if (detailText !== '') debugTrace(`[watch] 回看「${reply.detail}」→ ${detailText}`);
      }
      const nowMs = Date.now();
      const noteText = detailText === '' ? reply.note : `${reply.note}（细看：${detailText}）`;
      watchNotes.push({ at: nowMs, note: noteText, imp: reply.imp });
      pruneWatchNotes(nowMs);
      watchScene = mergeScene(watchScene, {
        nowMs,
        kind: reply.kind,
        game: reply.game,
        brief: reply.brief,
        note: noteText,
      });
      debugTrace(
        `[watch] 笔记 #${meta.index} ${reply.imp}|${noteText}${reply.say === '' ? '' : ` 想说「${reply.say}」`}`,
      );
      // 【11-18 待办第 2 条】笔记落进屏幕流水（`memory/screens/<日期>.jsonl`），
      // 不再混进当天记忆：那边是「说了什么」，笔记只是「看到了什么」，只做 3 条注入。
      void appendScreen(screensDir, {
        at: nowMs,
        app: fg.exe,
        title: title === '' ? fg.title : title,
        note: noteText,
      }).catch(() => {});
      const sheetName = await saveWatchSheet(png, meta);
      const staleAt = Date.now() - meta.shotAtMs;
      const logBase = {
        t: new Date(nowMs).toISOString(),
        reason: meta.reason,
        kind: meta.kind,
        score: Math.round(meta.score),
        sheet: sheetName,
        grid: gridFrames === 0 ? null : { frames: gridFrames, ms: gridMs },
        note: noteText,
        imp: reply.imp,
        noteMs,
        idleMs,
        detailMs,
        staleMs: staleAt,
        window: fg.title,
        exe: fg.exe,
        mode: watchMode(),
        url: fg.url,
        target: {
          title,
          cropped: meta.cropped,
          hwnd: targetWin?.hwnd ?? 0,
          rect: targetWin?.rect ?? null,
        },
        bili: {
          ok: story !== null,
          chars: story?.summary.length ?? 0,
          cached: story?.cached ?? false,
        },
      };
      // 攒话题（哥哥 11-10：放弃同话题硬冷却，改成攒着、同主题合并、说完标记消耗）
      if (reply.say !== '') {
        watchScene = {
          ...watchScene,
          topics: mergeTopics(watchScene.topics, {
            key: topicKey(reply.game, reply.event, reply.note),
            text: reply.say,
            at: nowMs,
            imp: reply.imp,
          }),
        };
      }
      // 流式那步已经把话说了，这里只补账；没说成就从池子里挑一条再到闸门走一遍
      let outcome: 'said' | 'gap' | 'busy' | 'bridge' | 'dupe' | 'empty' | 'nothing' =
        spoke === '' ? 'nothing' : 'said';
      let spokenKey = '';
      if (spoke === '') {
        const topic = pickTopic(watchScene.topics, nowMs);
        if (topic) {
          outcome = await trySpeak(topic.text, topic.imp, reply.note);
          if (outcome === 'said') spokenKey = `${topic.key}@${topic.at}`;
        }
      }
      if (spoke !== '') {
        const at = watchLastSpokeAt;
        watchScene = {
          ...mergeScene(watchScene, { nowMs: at, said: spoke }),
          topics: watchScene.topics.map((t) =>
            t.text === spoke || `${t.key}@${t.at}` === spokenKey
              ? ({ ...t, consumed: true } satisfies TalkTopic)
              : t,
          ),
        };
        // 说出口的话进对话历史（和语音走同一个池）；识图笔记仍然只走 source='watch'
        void memoryStore.remember({ role: 'pet', text: spoke, source: 'chat' }).catch(() => {});
        digestHighlight(`${hhmm(Date.now())} 看到他${noteText}`);
        appendWatchLog({
          ...logBase,
          said: spoke,
          voice: watchSpeakEnabled(),
          totalMs: Date.now() - meta.shotAtMs,
        });
      } else {
        appendWatchLog({ ...logBase, said: '', drop: outcome === 'nothing' ? 'nothing' : outcome });
      }
      saveWatchScene();
    } catch (error) {
      debugTrace('[watch] 看护失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      watchBusy = false;
      dropHint('watch');
    }
  };

  // 【汐儿 · 11-16 m21257】自动/窗口模式每 5 秒看一眼前台是谁，窗口换了跟着换。
  // 全屏模式不巡检（没必要每 5 秒开一个 PowerShell）。
  let targetTimer: ReturnType<typeof setInterval> | null = null;
  const startTargetPoll = (): void => {
    if (targetTimer !== null) return;
    targetTimer = setInterval(() => {
      // 陪伴没在跑（停了 / 抓屏连着起不来）就别再每 5 秒起一次 PowerShell（11-16 体检 B3）。
      if (watch === null || watchMode() === 'full' || !watch.status().running) return;
      void refreshTarget().catch(() => {});
    }, 5_000);
    targetTimer.unref?.();
  };
  const stopTargetPoll = (): void => {
    if (targetTimer === null) return;
    clearInterval(targetTimer);
    targetTimer = null;
  };
  let watch: WatchHandle | null = null;
  /**
   * 最近一次「有人找她」的时刻（对话、看一眼、外部 /say、/say-loud 都算）。
   * 静止收工前拿它判「人还在不在」——画面十分钟不动，可能只是在看文档。
   */
  let lastUserTouchAt = 0;
  const touchUser = (): void => { lastUserTouchAt = Date.now(); };
  let watchPace: WatchPace = 'normal';
  /** 按节奏给「够不够格开口」的重要性门槛：密档 1、正常/轻 2（哥哥 11-09 晚：「密档也几乎不说话」）。 */
  const watchImpNeed = (): number => (watchPace === 'dense' ? 1 : 2);
  /**
   * 菜单要显示的档位：跑着时用内存里的，关着时读存档。
   *
   * 【11-20 哥哥 m34789「陪伴开关状态不会正常切换」】原来 `watchPace` 开机写死 'normal'，
   * 关着的时候标题永远显示「正常」，换过档位也看不出来——现在关着也照实显示上次的档。
   */
  const watchPaceNow = (): WatchPace => {
    if (watchRunning()) return watchPace;
    const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
    const saved = ((conf.watch ?? {}) as Record<string, unknown>).pace;
    if (saved === 'calm' || saved === 'normal' || saved === 'dense') return saved;
    return watchPace;
  };
  // 【汐儿 · 11-10 m17532】原来这里有个 20 秒「过期就不说」的预算（m16589 定的），
  // 结果那 20 秒会把整条消息吞掉。哥哥说：延迟该想办法，不是把话丢了。已撤销。
  const startWatch = (pace?: WatchPace): { ok: true } | { ok: false; message: string } => {
    // 闸门是**眼睛**：看护的产出全靠识图，眼睛没接上就别让人白等 CPU
    const eyes = servicesProvider('main').eyes.available();
    if (!eyes.ready) return { ok: false, message: '眼睛没接上，陪伴开不了' };
    if (pace) {
      watchPace = pace;
      // 菜单选的节奏写回配置：下次点「看护」按这个来（和陪伴改间隔同一个做法）
      updateUserConfig((raw) => {
        const section =
          raw.watch !== null && typeof raw.watch === 'object' ? (raw.watch as Record<string, unknown>) : {};
        raw.watch = { ...section, pace };
      });
    } else {
      const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
      const saved = ((conf.watch ?? {}) as Record<string, unknown>).pace;
      if (saved === 'calm' || saved === 'normal' || saved === 'dense') watchPace = saved;
    }
    // 开机自恢复（哥哥 11-09 晚：「我重启后明明开着」）：菜单一开就记下 autoStart
    updateUserConfig((raw) => {
      const section =
        raw.watch !== null && typeof raw.watch === 'object' ? (raw.watch as Record<string, unknown>) : {};
      raw.watch = { ...section, autoStart: true };
    });
    resetGridRing();
    if (!watch) {
      watch = createWatchMode({
        ffmpegPath: watchFfmpeg(),
        tuning: watchTuning(),
        onSheet: watchSheet,
        // 【汐儿 · 11-16 m21257】宫格整套删掉，永远单张；这里只交出「该裁哪块」
        cropTarget: () => cropCache,
        log: (message) => console.log(message),
        // 哥哥 11-09 晚改：连续 15 分钟画面没变化才收工（6 分钟会误伤读文档/看视频的人）；
        // 这段时间里只要有人找过她，就当人还在，重新计 15 分钟。收工前吭一声，别悄无声息消失。
        stillStopSec: 15 * 60,
        shouldStillStop: () => Date.now() - lastUserTouchAt < 15 * 60 * 1000,
        onStillStop: () => {
          void servicesProvider('main')
            .bubble.say({ petId: 'main', text: '我先眯会儿，有事叫我', source: 'companion', duration: 10_000 })
            .catch(() => {});
        },
        // 抓屏连着三次没起来：菜单的 ✓ 要跟着变回「关」，取景轮询也停掉（11-16 体检 B3）。
        onCaptureLost: () => {
          stopTargetPoll();
          refreshPetMenu();
        },
      });
    }
    if (watch.status().running) return watch.setPace(watchPace);
    // 新一轮看护：笔记和「上次说过什么」清零（跨轮的记忆靠 memory 里的 watch 条目，不靠内存）
    watchNotes = [];
    watchLastSpokeAt = 0;
    watchLastSaid = '';
    watchBusy = false;
    const started = watch.start(watchPace);
    // 自动/窗口模式：每 5 秒看一眼前台是谁（11-16 m21257）
    if (started.ok) startTargetPoll();
    return started;
  };
  const stopWatch = (): void => {
    watch?.stop();
    stopTargetPoll();
    cropCache = null;
    // 手动关掉 = 下次开机不要自己开（哥哥 11-09 晚：autoStart）
    updateUserConfig((raw) => {
      const section =
        raw.watch !== null && typeof raw.watch === 'object' ? (raw.watch as Record<string, unknown>) : {};
      raw.watch = { ...section, autoStart: false };
    });
  };
  const watchRunning = (): boolean => watch !== null && watch.status().running;
  // ===================== 歌词气泡（默认关） =====================
  // 【本鱼改造 · 10-30】旧版在 extras 里自己 HTTP 回环写 /lyric；新版唯一出口是 state 的 lyric 叶子，
  // 壳侧渲染（sprite.js 的 setLyric）早就有了，这里只负责"算出此刻该显示哪一行"。
  const lyricCacheDir = join(userRoot, 'lyric-cache');
  let lyricAgent: ReturnType<typeof createLyricAgent> | null = null;
  const startLyric = (): { ok: true } | { ok: false; message: string } => {
    if (lyricAgent) return { ok: true };
    try {
      const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
      const raw = (conf.lyric ?? {}) as Record<string, unknown>;
      lyricAgent = createLyricAgent({
        setLyric: (text, instrumental) => {
          state.writePet('main', 'lyric', { text, instrumental });
        },
        cacheDir: lyricCacheDir,
        config: {
          ...(typeof raw.cacheTtlDays === 'number' ? { cacheTtlDays: raw.cacheTtlDays } : {}),
          ...(typeof raw.cacheSweepHours === 'number' ? { cacheSweepHours: raw.cacheSweepHours } : {}),
          ...(typeof raw.maxDriftMs === 'number' ? { maxDriftMs: raw.maxDriftMs } : {}),
        },
        log: (message) => console.log(message),
      });
      lyricAgent.start();
      return { ok: true };
    } catch (error) {
      lyricAgent = null;
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  const stopLyric = (): void => {
    lyricAgent?.stop();
    lyricAgent = null;
  };

  // ===================== 「本鱼陪伴」右键菜单（宿主自持） =====================
  // 【本鱼改造 · 11-01】这两层菜单原本由**附属插件** dsh-pet-extras 注册（它 POST /menu/item 到
  // 自己的 owner `本鱼陪伴`，再长轮询 /menu/events）。独立版不加载任何 Cordis 插件 → 没人注册 →
  // 壳侧 buildCompanionBranch 拿到空数组返回 null，「陪伴」整层从右键菜单里消失。
  // 现在改由宿主自己注册、自己消费：一份代码在 DSH 内与独立模式都生效，且不再依赖 extras。
  //
  // 壳侧的拼法是按 label 前缀来的（shared-core.js buildCompanionBranch）：owner 必须是
  // `本鱼陪伴`，`陪伴：xxx` 平铺成一级，其他前缀（`歌词：`）各自套一层子菜单
  // —— label 文案是壳的输入，拼法见 ./pet-menu。
  //
  // 注册语义是**整体覆盖**，所以每次刷新都要给全量：菜单项 = 此刻真实能力清单，
  // 不留下已停掉却还挂着的僵尸项（也顺带给当前档位打 ✓）。
  let refreshPetMenu: () => void = () => {};
  /** 气泡状态提示：看一眼/识图这类要等几秒的活，先冒「正在做」、失败也要说清楚（哥哥 11-01 要的反馈）。 */
  const statusBubble = async (text: string, duration = 15_000): Promise<void> => {
    // 【汐儿 · 11-15】状态提示走「提示层」：不进说话队列；正在说话时不盖人家的气泡。
    await centerHint(text, duration);
  };
  /** 拍一张全屏给识图看（「看一眼」与陪伴共用同一套截屏 + 识图服务，不各写一套） */
  // 【本鱼 · 11-01】识图提示词：哥哥要「看图的要求写清楚，回到 DSH 里才好用」——默认那套
  // 「一句话、20 字」只够气泡念；投进会话的描述要能看出程序、标题、关键文字和异常。
  // 【汐儿 · 11-17 m26171】哥哥要「别念文件名」——问句里就不许问窗口标题的原文，
  //   只让它判断「他在用什么软件、在干什么」，描述里自然就不会出现 xxx.ts。
  const LOOK_DETAIL_PROMPT =
    '看一眼这张图，只回答三点，每点一行：1) 他在用什么软件、在干什么（说人话，例如「在改设置页」「在打游戏」）；'
    + '2) 画面里能核对的具体东西：数字、按钮、报错的大意（不要念文件名和路径）；'
    + '3) 有没有卡住、出错、在等。看不清就写「看不清」。200 字以内。';
  /** 识图提示词带上「这是哪个窗口」，省得它猜（哥哥 m31134）。 */
  const lookPrompt = (windowName: string): string =>
    windowName === '' ? LOOK_DETAIL_PROMPT : `${LOOK_DETAIL_PROMPT}\n（这应该是「${windowName}」窗口的截图。）`;
  const lookOnce = async (): Promise<{ ok: boolean; message?: string }> => {
    const lookT0 = Date.now();
    const lookMark = (what: string): void => {
      noteLog('mind.log', 'look', `${what} +${Date.now() - lookT0}ms`);
    };
    lookMark('begin');
    // 【汐儿 · 11-15 23:16】一眼看**不再打断**正在说的话（哥哥定：陪伴、一眼看不该掐语音）。
    touchUser();
    // 【汐儿 · 11-16 晚 m24151】这是哥哥手按的动作：先把「在听 / 在想」撤掉，
    // 否则他按完看一眼，结果那句 high 也会被 earMuted() 挡掉——看着就像「看一眼把语音挤没了」。
    setEarPhase('idle');
    dropHint('think');
    // 【11-20 m31853】灯要跟着他按下去那一刻亮：一眼看整轮 4~5 秒里，
    // 截屏 ~0.5 秒 + 识图 2~5 秒 + 生成 1~2 秒，以前灯只在最后一段亮，看着像「没反应，最后闪一下」。
    pushHint('watch', '【在看】', 'task');
    // 先冒「正在偷看」：截屏 + 识图 + 对话要好几秒，不冒的话哥哥只会觉得「没反应」。
    // 【汐儿 · 11-16】封顶 30 秒；成功说完立刻撤掉（失败那句 18 秒自己会走）。
    const fail = async (message: string): Promise<{ ok: false; message: string }> => {
      await statusBubble(`看一眼失败：${message}`, 18_000);
      return { ok: false, message };
    };
    // 哥哥 10-30：没接聊天模型就别给开「看一眼」——识图原文直接念出来只是机械复读，
    // 所以这里和陪伴用同一道闸：先有模型，才谈看不看。
    if (!chatModelReady()) return fail('未接入聊天模型');
    try {
      await screenCapture.capture();
      const shot = screenCapture.lastShotPath();
      lookMark('shot');
      if (!shot) return fail('还没截到图');
      const eyes = servicesProvider('main').eyes.available();
      if (!eyes.ready) return fail(`识图接口没配好：${eyes.reason?.message ?? '未知原因'}`);
      const live = await liveContext();
      // 【汐儿 · 11-22 m35769】哥哥问「读窗口名生效了吗」——以前窗口名只进提示词、不落日志，
      // 事后根本查不出来。这里记一行，`logs/mind.log` 里 `[look] win=` 就是当时的窗口名。
      noteLog('mind.log', 'look', `win=${live.title === '' ? '-' : live.title}`);
      const seen = await servicesProvider('main').eyes.look({ image: shot, prompt: lookPrompt(live.title) });
      lookMark('eyes');
      const description = (seen.text ?? '').trim();
      if (!description) return fail('识图没说出画面');
      // 接入 DSH 开着：身体只说"我看到了什么"，说什么交给会话（哥哥 11-09 选 A）
      if (await bridgeHandoff('look', description)) {
        await statusBubble('（看一眼交给 DSH 了，等她回话）', 6_000);
        return { ok: true };
      }
      // 第二步：把「看到的」交给聊天模型，让它用自己的语气说（和陪伴同一个 prompt）
      const found = findPetInstance(readAllConfig(configPaths), 'main');
      if (!found) return fail('找不到桌宠配置');
      // 刚看到的那张图本身就是这次的话头；再带上最近 10 分钟的笔记（如果陪伴同时开着）
      const system =
        petSystemPrompt(found) +
        (await memoryBlockFor('看一眼')) +
        (await recentSightBlock()) +
        '\n\n' +
        reasonBlock({ kind: 'look', idleMs: lastIdleMs }) +
        contextBlock(live.line);
      const pool =
        found.conf.chatImageEnabled === true
          ? limitPool(memePoolFor(found.entry, found.conf), Number(found.conf.chatImageLimit))
          : [];
      lookMark('gen');
      const generated = await thinkOnScreen((signal) =>
        usesOwnModel(found.conf)
          ? generateChatViaGateway(
              gatewayFor(found.conf),
              system,
              [],
              companionLookPrompt(description),
              pool,
              undefined,
              signal,
            )
          : generateChat(
              ctx,
              system,
              [],
              companionLookPrompt(description),
              pool,
              configuredModel(found.conf, 'chatModel'),
            ),
      );
      if (!generated.ok) return fail(generated.message ?? '模型没接上');
      const text = generated.text.trim();
      if (!text) return fail('模型没说话');
      // 看一眼和陪伴一样是最高的优先级（哥哥 11-09 晚定的规矩）
      await sayWithVoice('main', text, generated.image, 'high');
      dropHint('status');
      // 「看一眼」说出口的话也进对话历史（和陪伴、语音同一个池）
      void memoryStore.remember({ role: 'pet', text, source: 'chat' }).catch(() => {});
      digestHighlight(`${hhmm(Date.now())} ${text}`);
      // 【本鱼 · 11-01】菜单/语音触发的「看一眼」是本鱼自己在看：看到的画面也得投进 DSH 会话，
      // 否则会话里只有本鱼说了一句话、没有任何依据（哥哥报「看完图没发给会话」）。
      // 桥那边（会话里贴图）是另一条路，由插件自己 lookImage + 回投，不会重复。
      void (async () => {
        try {
          const bridge = await refreshDshBridge();
          if (bridge.enabled && dshBridgeUrl !== '') {
            await sayToDsh(dshBridgeUrl, imageHandoffText(description));
          }
        } catch {
          /* 投递失败不影响本鱼已经说出口的那句 */
        }
      })();
      return { ok: true };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    } finally {
      // 兜底：成功时这盏已经在 show() 里灭了，这里只负责失败/提前 return 不留灯。
      dropHint('watch');
    }
  };
  /**
   * 放一段音频（点「声音：说一句」时用）。
   *
   * 为什么要显式定 ffplay 路径：家里真正带 ffplay 的是 RVC 那套，它不在 PATH 里；
   * 依赖 PATH 会得到「配置都没错、就是没声音」这种最难查的失败。放完删临时文件。
   */
  /** /say-loud 的诊断流水：每次收/念各一行，出现「同句两遍」时先看这里。 */
  const logSayLoud = (line: string): void => {
    try {
      const dir = join(userRoot, 'logs');
      mkdirSync(dir, { recursive: true });
      noteLog('mouth.log', 'say-loud', line);
    } catch {
      /* 日志写不进去不能影响出声 */
    }
  };
  /** 独占那条嘴：/say-loud 的播放器。同一时间只允许一个 ffplay，新的先掐掉旧的。 */
  let loudChild: { kill: () => void } | null = null;
  let loudFile = '';
  /**
   * 正在播的那条（普通播放，含对话/陪伴/桥）：记它什么时候开的、最晚该在什么时候结束。
   * 开新句前先看一眼，超过 deadline 还活着就当成卡死直接掐掉——不然它永远占着嗓子。
   */
  let activePlay: {
    child: { kill: () => void };
    startedAtMs: number;
    budgetMs: number;
    /** 正在播的临时音频；打断时连它的停旗标一起清 */
    file: string;
    /** 淡出用的停旗标文件：写一下，播放器自己把音量降到 0 再收（哥哥 11-18 m27977） */
    stopFile: string;
  } | null = null;
  /**
   * 常驻嗓子：一个养着 MediaPlayer 的 PowerShell，每句只多 ~200ms（现起要 1.7 秒）。
   * 起不来就 `ready === false`，播放退回 ffplay。
   */
  // 常驻嗓子起不来要留下痕迹（11-20：daemon 静默失败会让每句都退化成 1.5 秒的一次性播放器）
  const voicePlayer = createVoicePlayer({ log: (line: string) => noteVoiceIssue(line) });
  // 开机就预热常驻嗓子：不然第一句话要等 PowerShell 起来（1.5 秒），字和声就错开了
  ctx.effect(() => {
    voicePlayer.warm();
    return () => {
      voicePlayer.dispose();
    };
  });
  /** 现在挂在屏幕上的那句气泡是谁写的（打断时要跟着收掉，别「没声音了字还挂着」）。 */
  let bubbleOwner: { petId: string; source: 'chat' | 'companion' } | null = null;
  /** 陪伴刚说出口、还没真正出声的那句话（等 runSpeakClip 播放开始时写气泡） */
  let companionPending: { text: string; image?: string } | null = null;
  /** 兜底：1.5 秒还没等到 play，就把真话写出来（宁可晚一点，也不能没字） */
  let companionFlush: ReturnType<typeof setTimeout> | null = null;
  const clearCompanionPlaceholder = (): void => {
    if (companionFlush !== null) {
      clearTimeout(companionFlush);
      companionFlush = null;
    }
  };
  /** 立刻闭嘴：kill 正在播的那条 + 收掉它写的气泡（队列由 centerInterrupt 清）。 */
  const stopLoud = (bump = true): void => {
    if (bump) epoch += 1;
    const playing = activePlay;
    activePlay = null;
    // 【汐儿 · 11-18 m27977】哥哥要「淡出，不要硬切」：系统播放器一边播一边看停旗标，
    // 看到就把音量分 10 步降到 0；这里只负责写旗标，0.9 秒还没收再硬杀（播放器卡死那档）。
    if (playing !== null && playing.stopFile !== '') {
      try {
        writeFileSync(playing.stopFile, '1');
      } catch {
        /* 写不进去就交给下面的兜底 */
      }
      const child = playing.child;
      const late = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已经退了 */
        }
      }, 900);
      late.unref?.();
    } else {
      try {
        playing?.child.kill();
      } catch {
        /* 旧进程可能已经退了 */
      }
    }
    if (bubbleOwner !== null) {
      const owner = bubbleOwner;
      bubbleOwner = null;
      clearSayBubble(owner.petId, owner.source);
    }
  };
  /**
   * 播放卡死自愈（【汐儿 · 11-15】）：播放器进程死活不退时，嗓子就被一直占着。
   * 开新句之前先检查：上一条超过它的看门狗 deadline 还活着 → 当它死了，掐掉、让位。
   */
  const healStuckPlay = (): void => {
    if (activePlay === null) return;
    const cost = Date.now() - activePlay.startedAtMs;
    if (cost <= activePlay.budgetMs) return;
    noteVoiceIssue(`heal stuck-play cost=${cost}ms budget=${activePlay.budgetMs}ms kill`);
    try {
      activePlay.child.kill();
    } catch {
      /* 已经退了 */
    }
    activePlay = null;
  };
  /** 播放留痕：ffplay 的退出码与 stderr 以前被 stdio:'ignore' 吞掉，
   *  「有气泡没声音」在外面看不出任何痕迹。失败（或秒退）时写一行到 logs\mouth.log（tag=play）。
   *  【汐儿 · 11-10 m17532】哥哥同意加，只为定位，不改行为。 */
  const noteVoiceIssue = (line: string): void => {
    try {
      const dir = join(userRoot, 'logs');
      mkdirSync(dir, { recursive: true });
      noteLog('mouth.log', 'play', line);
    } catch {
      /* 记不了日志不能影响出声 */
    }
  };
  /**
   * 气泡留痕（【汐儿 · 11-10 01:12】哥哥：「气泡也监控一下，避免出现bug」）。
   *
   * 为什么单开一份：气泡「有没有写出去」和「声音有没有放出来」是两条独立的路，
   * 混在一个文件里分不清是谁没成。只记写没写、写的什么长度、为什么没写，不改行为。
   */
  const noteBubble = (line: string): void => {
    try {
      const dir = join(userRoot, 'logs');
      mkdirSync(dir, { recursive: true });
      noteLog('mouth.log', 'bubble', line);
    } catch {
      /* 记不了日志不能影响冒泡 */
    }
  };
  /**
   * 账本只留三本（哥哥 11-19 同意合并）：`mouth.log` 嘴 / `sense.log` 耳眼 / `mind.log` 想。
   *
   * 为什么并：原来 8 本（speak / voice-play / bubble / say-loud / chat-search / summarize / sense / mind），
   * 查一次「怎么没声音」要开四五个文件对时间，还常常对不上（时间戳只到毫秒、文件名各写各的）。
   * 现在按「嘴 / 耳眼 / 想」三路分，每行带 `[tag]` 分清来源，一个 `rg` 就能顺着一条时间线看完。
   *
   * 什么时候别用：陪伴的逐张笔记仍走 `logs/陪伴/<日期>.jsonl`（那是数据不是日志，要能被程序读回来）。
   */
  const noteLog = (file: 'mouth.log' | 'sense.log' | 'mind.log', tag: string, line: string): void => {
    try {
      const dir = join(userRoot, 'logs');
      mkdirSync(dir, { recursive: true });
      void appendFile(join(dir, file), `${new Date().toISOString()} [${tag}] ${line}\n`).catch(() => {});
    } catch {
      /* 记不了日志不能影响正事 */
    }
  };

  /**
   * 「听和看」的账本（【汐儿 · 11-17】第 2 批）：每条事件进来时记一行，
   * 出问题时能一眼看出「谁产的、几级、走的哪条路」。等级由事件自带，想和嘴不许改。
   */
  const noteSense = (line: string): void => {
    try {
      const dir = join(userRoot, 'logs');
      mkdirSync(dir, { recursive: true });
      noteLog('sense.log', 'sense', line);
    } catch {
      /* 记不了日志不能影响说话 */
    }
  };
  /**
   * 接线表（11-19 薄版注册表）：输入 / 想 / 输出三张表在这里登记一次。
   *
   * 以后加一条输入，只要写进 `sources/`、在这里多一行；加一种输出同理写 `sinks/`。
   * `emitSense` 只做「记账 + 扇出」，谁去想仍由上面的流程决定（接管调用顺序是后面的活）。
   */
  const registry = createRegistry({
    log: (line) => {
      noteSense(line);
    },
  });
  registry.registerSource(EAR_SOURCE);
  registry.registerSource(MANUAL_SOURCE);
  registry.registerSource(VISION_SOURCE);
  registry.registerMind(CHAT_MIND);
  registry.registerMind(SCREEN_MIND);
  registry.registerSink(MOUTH_SINK);
  registry.registerSink(BUBBLE_SINK);
  registry.registerSink(HINT_SINK);
  registry.registerSink(ANIM_SINK);
  registry.registerSink(HANDOFF_SINK);
  /**
   * 嘴的账本（【汐儿 · 11-17】9.16 ⑦ 定过、今天补上）：每次说话一行，`start / finish / drop / interrupt`。
   *
   * 为什么单开：`mouth.log` 里 `[bubble]` 记的是「字出没出」、`[play]` 记的是「声放没放」，
   * 但「这句话是根本没进嘴、还是进了被顶掉、还是说了被掐」只有嘴自己知道。
   * 查「她怎么不说话」时先看这份，再顺着 key 去另外两份对时间。
   */
  const noteSpeak = (line: string): void => {
    try {
      const dir = join(userRoot, 'logs');
      mkdirSync(dir, { recursive: true });
      noteLog('mouth.log', 'speak', line);
    } catch {
      /* 记不了日志不能影响说话 */
    }
  };
  /**
   * 专项账本（11-18 待办第 7 条）：`mind.log`（两个想谁掐了谁、换卷与摘要，tag 分开）。
   *
   * 为什么分家：sense.log 是所有事件的时间线，一长就淹；查「刚才那句为什么被取消」
   * 只需要看想的那几行。分出来不影响 sense.log 仍然全记一份。
   */
  const noteTo = (name: string, line: string): void => {
    // 【11-19】原来按 name 分文件（mind.log / roll.log / …），现在统一进 mind.log，name 变 tag。
    noteLog('mind.log', name, line);
  };

  /** 两个「想」的并发表：同会话新顶旧，4/5 级掐别的会话（11-17 第 3 批） */
  const mind = createMind({
    log: (line) => {
      noteSense(line);
      noteTo('mind', line);
    },
  });
  /**
   * 第 4 级「手动」（11-18 补）：他亲手点的、按的，比屏幕上正在跑的「想」要紧。
   *
   * 只做两件事：记一条 command 事件进账本；把正在跑的**屏幕想**掐掉（不动主聊天——
   * 他点菜单不代表不想听完她正在回的那句话）。
   */
  const noteCommand = (source: 'menu' | 'hotkey' | 'bridge', text: string): void => {
    registry.emitSense(manualEvent(source, text));
    const stopped = mind.cancel('screen', `manual-${source}`);
    if (stopped > 0) noteTo('mind', `preempt screen=${stopped} by=${source}`);
  };

  /**
   * 「屏幕想」：陪伴/一眼看的生成也登记进并发表（session='screen'，2 级）。
   * 4/5 级的手动动作来了会把它掐掉；底层支持 AbortSignal 的那条（网关）真掐，DSH 那条只登记。
   */
  const thinkOnScreen = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const run = mind.begin('screen', 2);
    // 【11-20 m31853】这盏灯不再由这里点：它在「截屏 + 识图」都做完之后才轮到，
    // 亮得晚、灭得快（哥哥看到的就是「话快出来了才冒【在看】」）。
    // 「在看」统一挂在调用方开始那一刻（lookOnce / 陪伴取帧前），这里只登记并发的想。
    try {
      return await fn(run.signal);
    } finally {
      run.end();
    }
  };
  /**
   * 放一段音频（仲裁中心内部专用；外面一律走 centerSay / centerPlayClip）。
   * 看门狗按音频时长算，卡住就掐；ffplay 起不来换 Windows 自带播放器。
   */
  const playAudio = (audio: Uint8Array, mime: string, onStart?: () => void, atEpoch?: number): Promise<void> => {
    return new Promise((resolve) => {
      // 先看一眼上一条是不是已经卡死了：是就先掐掉，别让新的一句跟着排队等死（11-15）。
      healStuckPlay();
      // 【11-20 哥哥 m34789】说层静音：音频照合成，只是不播——气泡、日志、排队语义全不变，
      //   「开始播」也要照常回调，否则气泡会一直等不到 show()。
      if (!voiceSpeakOn()) {
        noteVoiceIssue(`play-skip muted voice.speak=false bytes=${audio.byteLength}`);
        try {
          onStart?.();
        } catch {
          /* 同上：回调出错不影响收尾 */
        }
        resolve();
        return;
      }
      // 合成途中被打断（代数变了）：这条已经过时，直接不播。
      if (atEpoch !== undefined && atEpoch !== epoch) {
        noteVoiceIssue(`play-skip stale-epoch epoch=${atEpoch} now=${epoch} bytes=${audio.byteLength}`);
        resolve();
        return;
      }
      let file = '';
      // 「声音真的出来了」只回调一次：气泡要等语音**开始**才冒（哥哥 10-31 定）。
      let started = false;
      let settled = false;
      let current: ReturnType<typeof spawn> | null = null;
      /** 播放在看门狗：播放器卡死时到点掐掉，别让它一直占着嗓子（11-15 的那个 bug）。 */
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const clearWatchdog = (): void => {
        if (watchdog !== null) {
          clearTimeout(watchdog);
          watchdog = null;
        }
      };
      const fireStart = (): void => {
        if (started) return;
        started = true;
        try {
          onStart?.();
        } catch {
          /* 回调里出错不该把播放搞挂 */
        }
      };
      /** 删播放用的临时音频：Windows 上播放器可能还握着句柄，删不掉就改名成 .tmp 留给下次启动清 */
      const removeVoiceFile = (target: string): void => {
        if (target === '') return;
        try {
          rmSync(target, { force: true });
        } catch (error) {
          try {
            renameSync(target, `${target}.tmp`);
          } catch {
            noteVoiceIssue(
              `voice-file 删不掉也改不了名 ${target} | ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearWatchdog();
        // 停旗标不清掉，下次同名字的文件（基本不会重名，但别留垃圾）
        try {
          rmSync(`${file}.stop`, { force: true });
        } catch {
          /* 没有就算了 */
        }
        if (activePlay !== null && (current === null || activePlay.child === current)) activePlay = null;
        removeVoiceFile(file);
        resolve();
      };
      try {
        const dir = join(userRoot, 'voice');
        mkdirSync(dir, { recursive: true });
        file = join(dir, `say-${Date.now()}${mime === 'audio/wav' ? '.wav' : '.mp3'}`);
        writeFileSync(file, audio);
      } catch {
        fireStart(); // 落盘都不成：气泡照常冒，只是没声音（声音是锦上添花）
        resolve();
        return;
      }
      /** 停旗标：系统播放器看到它就淡出收尾（打断用）。 */
      const stopFile = `${file}.stop`;
      const fallback = (): void => {
        // 系统播放器起不来（个别机器没有 WPF 组件）——退回 ffplay，别一声不吭就没声。
        const volume = voiceVolume();
        const ffplayBin =
          process.env.DSH_PET_FFPLAY?.trim() ||
          (existsSync('D:\\AI\\RVC\\工具\\ffmpeg\\ffplay.exe')
            ? 'D:\\AI\\RVC\\工具\\ffmpeg\\ffplay.exe'
            : 'ffplay');
        noteVoiceIssue(`系统播放器起不来，改用 ffplay | ${mime} ${audio.length}B`);
        run(
          ffplayBin,
          ['-nodisp', '-autoexit', '-loglevel', 'quiet', ...(volume < 100 ? ['-volume', String(volume)] : []), file],
          'ffplay',
        );
      };
      const expectedMs = audioDurationMs(audio);
      const budgetMs = playbackWatchdogMs(expectedMs);
      const run = (command: string, args: string[], via: string): void => {
        // ffplay 起不来 → fallback() 会再调一次 run()：旧看门狗必须先清掉，
        // 否则它到点会对已经退出的子进程开火，把新一轮播放的 finish() 提前触发（11-15 体检 B2）。
        clearWatchdog();
        const startedAtMs = Date.now();
        let stderrText = '';
        let failed = false;
        const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        current = child;
        activePlay = { child, startedAtMs, budgetMs, file, stopFile };
        // 「开始播」也留一行：卡死的时候至少能看出是「合成没出来」还是「合成出来了没播」。
        noteVoiceIssue(
          `start via=${via} ${mime} ${audio.length}B expected=${expectedMs}ms budget=${budgetMs}ms volume=${voiceVolume()}`,
        );
        // 看门狗：到点还活着就是卡死了，掐掉、收尾，别让嗓子一直被占（11-15）。
        watchdog = setTimeout(() => {
          noteVoiceIssue(`timeout via=${via} cost=${Date.now() - startedAtMs}ms expected=${expectedMs}ms kill`);
          try {
            child.kill();
          } catch {
            /* 已经退了 */
          }
          fireStart();
          finish();
        }, budgetMs);
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderrText.length < 800) stderrText += chunk.toString('utf8');
        });
        // ffplay 起进程到真的出声之间有一小段（开音频设备），180ms 是实测手感；
        // 它就是「气泡晚一点点冒」的那个 delay —— 要让字和声音一起出现。
        child.once('spawn', () => {
          setTimeout(fireStart, VOICE_START_DELAY_MS);
        });
        child.on('error', (err: Error) => {
          failed = true;
          noteVoiceIssue(`error via=${via} ${err.message} | ${mime} ${audio.length}B`);
          if (via === 'system') {
            // 系统播放器起不来 → 退回 ffplay（11-15 外部用户报过没装 ffmpeg 的那类机器）
            fallback();
            return;
          }
          fireStart();
          finish();
        });
        child.on('close', (code: number | null, signal: string | null) => {
          if (failed) return;
          const cost = Date.now() - startedAtMs;
          if (code !== 0 || cost < 600) {
            noteVoiceIssue(
              `exit=${code ?? 'null'} via=${via} signal=${signal ?? '-'} cost=${cost}ms ${mime} ${audio.length}B ` +
                `file=${file} stderr=${stderrText.replace(/\s+/g, ' ').trim().slice(0, 300)}`,
            );
          }
          finish();
        });
      };
      // 【汐儿 · 11-18 m27977】首选**常驻**的嗓子（core/voice-player.ts）：
      // 它一直养着一个 MediaPlayer，每句只多 ~200ms；现起 PowerShell 要 1.7 秒，
      // 每句都慢这么多，字和声就彻底错开了。它能一边播一边降音量，打断才是「淡出」。
      // 常驻进程没起来（个别机器没有 WPF）→ 退回 ffplay：有声音比淡出要紧。
      if (voicePlayer.ready && audio.length > 0) {
        clearWatchdog();
        const startedAtMs = Date.now();
        // 常驻嗓子的「子进程」就是这个播放器本身：stopLoud 调 child.kill() 即 `voicePlayer.stop()`
        activePlay = { child: { kill: () => voicePlayer.stop() }, startedAtMs, budgetMs, file, stopFile };
        noteVoiceIssue(
          `start via=daemon ${mime} ${audio.length}B expected=${expectedMs}ms budget=${budgetMs}ms volume=${voiceVolume()}`,
        );
        watchdog = setTimeout(() => {
          noteVoiceIssue(`timeout via=daemon cost=${Date.now() - startedAtMs}ms expected=${expectedMs}ms stop`);
          voicePlayer.stop();
          fireStart();
          finish();
        }, budgetMs);
        void voicePlayer
          .play(file, voiceVolume(), () => setTimeout(fireStart, VOICE_START_DELAY_MS))
          .then((result) => {
            if (!result.ok) {
              noteVoiceIssue(`daemon 播不出来，改用 ffplay | ${mime} ${audio.length}B`);
              fallback();
              return;
            }
            noteVoiceIssue(
              `exit=0 via=daemon faded=${result.faded} cost=${result.endedAtMs - startedAtMs}ms ${mime} ${audio.length}B`,
            );
            finish();
          })
          .catch((error: unknown) => {
            noteVoiceIssue(`daemon 出错 ${error instanceof Error ? error.message : String(error)}`);
            finish();
          });
        return;
      }
      const sys = systemPlayerCommand(file, mime, voiceVolume(), stopFile);
      run(sys.command, sys.args, 'system');
    });
  };
  /**
   * 念一句（气泡链路的「出声」版）：嗓子没配好就静默返回 false，绝不弹报错——
   * 哥哥 10-30 定：「不要出现因为没有接嗓子而出现的报错」。
   */
  /**
   * 这段音频大概多长（毫秒）——气泡要**跟着声音走**：哥哥 10-31 说"气泡需要等语音播报"，
   * 所以固定 10 秒是错的：话短了气泡还在发呆，话长了声音没完气泡先消。
   * 【本鱼 · 11-03】真身搬到 `core/audio-duration.ts`：以前只解 wav，Edge / OpenAI 兼容回的
   * mp3 一律按 4 秒兜底 —— 结果「念 16 秒、气泡 6 秒就收起来」，哥哥报的「长对话气泡中途消失」
   * 就是这个。现在 wav / mp3（含 Xing 帧数、CBR 折算）都真算。
   */

  /**
   * 写入气泡并出声（对话/陪伴/看一眼共用）：**一句话一个气泡，按句依次冒**
   * （哥哥 11-01：「一个一个冒，并设置好语音间隔」）。
   *
   * 规矩：
   * - 每句独立合成、独立播放、独立气泡；气泡时长 = 该句音频 + 2 秒尾巴。
   * - 句与句之间至少隔 `SAY_GAP_MS`：`waitSpeakGap()` 在每句**起念前**统一补。
   * - 一次回复只占一个号（`saySeq`）：中途有新的一句进来，剩下的句子直接不念，
   *   免得旧回复在人家新话后面还接着巴拉巴拉。
   * - 配图挂最后一句：说完最后一句再出表情，不会抢在话前面。
   * - 嗓子没配好：整段当一个普通气泡写出去（不能因为没嗓子就不让人看见字）。
   */
  /** 冒一句气泡：对话走 renderer 的 say 叶子；陪伴/看一眼走 core 的 bubble（来源可区分） */
  /**
   * 【汐儿 · 11-16 m24046】「在听 / 在想」——哥哥按说话录音、等回答的那段时间。
   * 录音时挂【在听】、出字后换【在想】；这段时间里别的声音和气泡一律让路，
   * 免得他说着话、旁边还在自顾自聊天（哥哥原话：在听的时候其他语音和气泡会跳出来）。
   * 手动动作（urgent：Alt+T 打断、说一句、桥 say-loud）不受限——那是他自己要的。
   */
  type EarPhase = 'idle' | 'listen' | 'think';
  let earPhase: EarPhase = 'idle';
  let earPhaseAt = 0;
  /**
   * 兜底：脚本报上来的状态万一来不及撤（听.py 崩了 / 断线）就自动失效。
   * 【汐儿 · 11-16 晚 m24151】原来 120 秒太长——哥哥看到【在听】挂着两分钟。
   * 收短到 45 秒，另由 ear.js 每 8 秒心跳续命（长按说话也不会中途掉状态）。
   */
  const EAR_PHASE_TTL_MS = 45_000;
  const earPhaseNow = (): EarPhase => {
    if (earPhase === 'idle') return 'idle';
    if (Date.now() - earPhaseAt <= EAR_PHASE_TTL_MS) return earPhase;
    // 超时了：状态要失效，提示层那行也得跟着走，不然【在听】会挂到天荒地老。
    earPhase = 'idle';
    dropHint('ear');
    return 'idle';
  };
  /**
   * 【汐儿 · 11-16 夜 m24648】哥哥说「听话之后、说话之前还是会闪一秒【在想】」。
   * 原因：短句两秒就出话，提示层刚亮就灭，肉眼看就是闪一下。
   * 改法：**延迟 1.2 秒再亮**，中途只要切到别的状态（比如开始说话）就取消——
   * 真等得久才看得见，快答的短句根本看不见。
   */
  let thinkHintTimer: ReturnType<typeof setTimeout> | null = null;
  const clearThinkHint = (): void => {
    if (thinkHintTimer !== null) {
      clearTimeout(thinkHintTimer);
      thinkHintTimer = null;
    }
  };
  const setEarPhase = (phase: EarPhase): void => {
    earPhase = phase;
    earPhaseAt = Date.now();
    clearThinkHint();
    if (phase === 'listen') pushHint('ear', '【在听】', 'task');
    else if (phase === 'think') {
      thinkHintTimer = setTimeout(() => {
        thinkHintTimer = null;
        if (earPhaseNow() === 'think') pushHint('ear', '【在想】', 'task');
      }, 1200);
      thinkHintTimer.unref?.();
    } else dropHint('ear');
    // 【汐儿 · 11-16 晚 m24151】哥哥看到「头顶气泡 + 提示气泡」两个一起挂：
    // 头顶那个是听.py 自己写的「我在听…（再按一下停）」（60 秒），和我们的提示层重复。
    // 一进入「在听 / 在想」，就把头顶气泡收掉，只留提示层那一行。
    if (phase !== 'idle') {
      try {
        state.writePet('main', 'say', { clear: true });
      } catch {
        /* 收不掉就算了，不能因为收气泡把嗓子搞挂 */
      }
    }
  };
  /** 在听或在想：别的声音让路（manual/urgent 例外） */
  const earMuted = (): boolean => earPhaseNow() !== 'idle';
  /** 【汐儿 · 11-20 m30910】主气泡的「占位权」：碎碎念（1 级）不许盖掉陪伴/一眼看（2~3 级）刚写的那句。
   * 记一句写到什么时候为止，过了就不管。 */
  let sayBubbleGuard: { level: number; until: number } | null = null;
  const markSayGuard = (level: number, duration: number | undefined): void => {
    sayBubbleGuard = { level, until: Date.now() + Math.max(1_500, duration ?? 6_000) };
  };
  const writeSayBubble = (
    petId: string,
    source: 'chat' | 'companion',
    payload: {
      text: string;
      image?: string;
      duration?: number;
      imageDuration?: number;
      /** 谁写的：3 = 对话，2 = 陪伴/一眼看，1 = 碎碎念（默认按 source 推） */
      level?: number;
      /** 第三方投喂用：常驻气泡 / 配一段动画（原 /services/bubble 的 sticky / anim） */
      sticky?: boolean;
      anim?: string;
    },
  ): void => {
    // 【汐儿 · 11-17 m24756】主气泡**只装她说的话**：只在正在录音那几秒让位。
    // 等待反馈是「状态」，交给副气泡【在想】，不许往主气泡塞占位词。
    if (earPhaseNow() === 'listen') return;
    const level = payload.level ?? (source === 'companion' ? 2 : 3);
    if (source === 'companion') {
      void servicesProvider('main')
        .bubble.say({ petId, text: payload.text, duration: payload.duration, source: 'companion' })
        .catch(() => {});
      markSayGuard(level, payload.duration);
      return;
    }
    state.writePet(petId, 'say', payload);
    markSayGuard(level, payload.duration);
  };

  /**
   * 主气泡的唯一写入入口（第二批细化：`mouth` 接管之前先收口）。
   * 全身体只有这里能碰 `pets.<id>.say` —— 碎碎念、say-loud 表情包这些「不等声音」的写法都走它。
   * 以后接进 `mouth.ts` 时，只需要把这一处换成 `mouth.show()`，别处一个都不用动。
   */
  const writeSayNow = (petId: string, payload: Record<string, unknown>, level = 1): void => {
    // 【汐儿 · 11-20 m30910】碎碎念不许盖掉她刚说的话：低级别让位给还在显示的高级别气泡
    if (level < 2 && sayBubbleGuard !== null && Date.now() < sayBubbleGuard.until && sayBubbleGuard.level > level) {
      noteBubble(`skip-now pet=${petId} level=${level} busy=${sayBubbleGuard.level}`);
      return;
    }
    state.writePet(petId, 'say', payload as never);
    noteBubble(`write-now pet=${petId} text=${String(payload.text ?? '').slice(0, 20)}`);
  };

  /** 收掉一句气泡（打断 / 卡死时用）：声音没了，字不该还挂着 */
  const clearSayBubble = (petId: string, source: 'chat' | 'companion'): void => {
    try {
      if (source === 'chat') state.writePet(petId, 'say', { clear: true });
      else void servicesProvider('main').bubble.clear(petId).catch(() => {});
    } catch {
      /* 收不掉就算了，不能因为收气泡把嗓子搞挂 */
    }
  };
  /** 读 voice 段里的一个数字（音量 / 秒 / 毫秒），坏值回默认（哥哥 11-15 要能在设置页调） */
  const voiceNumber = (key: string, fallback: number, min: number, max: number): number => {
    const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
    const section = conf.voice;
    const raw =
      section !== null && typeof section === 'object' ? (section as Record<string, unknown>)[key] : undefined;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  /** 说话音量（0~100）：设置页的 voice.volume；没配按 100 */
  const voiceVolume = (): number => voiceNumber('volume', 100, 0, 100);
  /**
   * 出不出声（`voice.speak`，11-20 哥哥 m34789「统一成声音开关」）。
   *
   * 干什么：关掉之后所有话头**照常生成、照常冒气泡**，只是不发声——陪伴、聊天、一眼看、
   * 说一句、碎碎念、桥 /say-loud 全走这一个闸（闸在 playAudio 里，只有一处）。
   * 没配就是开：老配置里没有这个键，不能因为没写就变静音。
   */
  const voiceSpeakOn = (): boolean => {
    const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
    const section = conf.voice;
    const raw = section !== null && typeof section === 'object' ? (section as Record<string, unknown>).speak : undefined;
    return raw !== false;
  };
  /** 排队多久算过期（从入队算，不重置），默认 15 秒 */
  const voiceStaleMs = (): number => voiceNumber('staleSec', 15, 1, 600) * 1_000;
  /** 句与句之间的空隙，默认 0.5 秒（哥哥 11-15：太长会显得卡卡的） */
  const voiceGapMs = (): number => voiceNumber('gapMs', SAY_GAP_MS, 0, 5_000);
  /** 读任意一段里的一个整数（带范围夹），坏值回默认 */
  const sectionInt = (section: string, key: string, fallback: number, min: number, max: number): number => {
    const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
    const raw = conf[section];
    const value = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  /** 换卷字数（11-18 待办第 5 条）：`context.rollChars`，没配就跟 session.ts 的 ROLL_CHARS 一致 */
  const contextRollChars = (): number => sectionInt('context', 'rollChars', ROLL_CHARS, 800, 20_000);
  /** 嘴边最多排几条：`mouth.queueMax`，没配就是 MOUTH_QUEUE_MAX */
  const mouthQueueMax = (): number => sectionInt('mouth', 'queueMax', MOUTH_QUEUE_MAX, 1, 10);
  /** 每轮注入几张卡：`context.cardInject`，没配就 5 */
  const cardInjectCount = (): number => sectionInt('context', 'cardInject', CARD_INJECT, 1, 20);

  /**
   * 合成一句（带体积校验）：极短句（一个字）SAPI 会合成出 46 字节的空 wav（只有文件头），
   * 合成完先量大小，太小重试一次。
   *
   * 【汐儿 · 11-20 半流式】从 runSpeakTextInner 里提出来，好让「提前合成」和「播放」共用同一个入口。
   */
  const synthLine = async (line: string): Promise<{ audio: Uint8Array; mime: string } | null> => {
    const attempt = async (): Promise<{ audio: Uint8Array; mime: string } | null> => {
      try {
        const said = await servicesProvider('main').voice.speak({ text: line });
        if (!said || said.audio.byteLength < 2000) {
          noteVoiceIssue(`synth-thin bytes=${said?.audio.byteLength ?? 0} say=${line.slice(0, 24)}`);
          return null;
        }
        return said;
      } catch {
        return null;
      }
    };
    return (await attempt()) ?? (await attempt());
  };

  /**
   * 提前合成的池子：key = 句子文本，value = 已经在跑的那次合成。
   *
   * 【汐儿 · 11-20 半流式】生成还是流式的，第一句在整段生成完之前就定型了；
   * 先开跑合成，等播放侧来取时多半已经好了——这一两秒就是这么省下的。
   */
  const synthWarm = new Map<string, { at: number; job: Promise<{ audio: Uint8Array; mime: string } | null> }>();
  const SYNTH_WARM_TTL_MS = 60_000;
  const pruneWarmSynth = (): void => {
    const now = Date.now();
    for (const [key, hit] of synthWarm) {
      if (now - hit.at > SYNTH_WARM_TTL_MS) synthWarm.delete(key);
    }
  };
  /** 喊一声「这句先合成着」：同一句只跑一次，重复喊不重来 */
  const warmSynth = (line: string): void => {
    const trimmed = String(line ?? '').trim();
    if (trimmed === '') return;
    // 嗓子没接上就别预热：播放侧也不会合成，提前跑纯属白花 CPU
    if (!servicesProvider('main').voice.available().ready) return;
    pruneWarmSynth();
    if (synthWarm.has(trimmed)) return;
    noteLog('mouth.log', 'warm', `start chars=${trimmed.length} say=${trimmed.slice(0, 24)}`);
    synthWarm.set(trimmed, { at: Date.now(), job: synthLine(trimmed) });
  };
  /** 播放侧取货：取到就从池子里拿掉（同一句只享受一次提前合成） */
  const takeWarmSynth = (line: string): Promise<{ audio: Uint8Array; mime: string } | null> | undefined => {
    const trimmed = String(line ?? '').trim();
    const hit = synthWarm.get(trimmed);
    if (hit === undefined) {
      noteLog('mouth.log', 'warm', `miss chars=${trimmed.length} say=${trimmed.slice(0, 24)}`);
      return undefined;
    }
    noteLog('mouth.log', 'warm', `hit waited=${Date.now() - hit.at}ms chars=${trimmed.length}`);
    synthWarm.delete(trimmed);
    return hit.job;
  };

  /**
   * 念一段话（仲裁中心内部专用）：**一句话一个气泡，按句依次冒**（哥哥 11-01）。
   *
   * 规矩：
   * - 每句独立合成、独立播放、独立气泡；气泡时长 = 该句音频 + 2 秒尾巴。
   * - 句与句之间至少隔 `SAY_GAP_MS`：`waitSpeakGap()` 在每句**起念前**统一补。
   * - 代数（`epoch`）变了就整段让位：新的一句进来，旧回复剩下的句子直接不念。
   * - 配图挂最后一句：说完最后一句再出表情，不会抢在话前面。
   * - 嗓子没配好：整段当一个普通气泡写出去（不能因为没嗓子就不让人看见字）。
   */
  const runSpeakText = async (spec: SpeakSpec, myEpoch: number): Promise<SpeakOutcome> => {
    // 【汐儿 · 11-20 m30910】【在说】改成**声音真的起来那一刻**才挂（原来在合成前就挂，
    // 合成要 1.5~3 秒，看起来就是「提示先冒、声音后到」，哥哥说延迟高）。
    try {
      return await runSpeakTextInner(spec, myEpoch);
    } finally {
      dropHint('say');
    }
  };

  const runSpeakTextInner = async (spec: SpeakSpec, myEpoch: number): Promise<SpeakOutcome> => {
    const petId = spec.petId;
    const source: 'chat' | 'companion' = spec.source === 'chat' ? 'chat' : 'companion';
    const { text, image } = spec;
    if (!spec.voice) {
      writeSayBubble(petId, source, image === undefined ? { text } : { text, image });
      return { ok: true };
    }
    const sentences = splitSentences(text);
    const voice = servicesProvider('main').voice.available();
    if (!voice.ready) {
      // 【汐儿 · 11-10】嗓子没接上：这句只会变成字，留痕好查「有气泡没声音」
      noteVoiceIssue(`synth-skip voice-not-ready pet=${petId} src=${source} chars=${text.length} say=${text.slice(0, 24)}`);
      writeSayBubble(petId, source, image ? { text, image } : { text });
      return { ok: true };
    }
    // 【汐儿 · 11-15 23:20】串行合成、首句优先：并发会把嗓子堵死（实测首句等了 21.7 秒）。
    // 链上第一个就是第一句，后面排着队合成；念到哪、合成到哪，不抢。
    let synthChain: Promise<unknown> = Promise.resolve();
    const jobs = sentences.map((line, i) => {
      // 首句最可能已经被「提前合成」接走了：直接等它，不排到链子尾巴上
      const warm = i === 0 ? takeWarmSynth(line) : undefined;
      const task = warm ?? synthChain.then(() => synthLine(line));
      // 后面的句子串在首句（哪怕是提前起跑的那次）之后，避免两句同时合成把嗓子堵住
      synthChain = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    });
    for (let i = 0; i < sentences.length; i += 1) {
      if (myEpoch !== epoch) {
        noteVoiceIssue(`synth-skip superseded epoch=${myEpoch} now=${epoch} i=${i}/${sentences.length} pet=${petId}`);
        return { ok: false, interrupted: true };
      }
      const line = sentences[i];
      const isLast = i === sentences.length - 1;
      const said = await jobs[i];
      if (!said) {
        // 合成失败是「有气泡没声音」的头号嫌疑，必须留痕；剩下的字一次写出去。
        // 【11-18】嗓子打结：先让她说一句人话，再把剩下的字留给气泡
        writeSayBubble(petId, source, { text: '嗓子打结了，我先写给你看。', duration: 2_000 });
        noteVoiceIssue(`synth-failed pet=${petId} src=${source} i=${i}/${sentences.length} say=${line.slice(0, 24)}`);
        if (myEpoch === epoch) {
          const left = sentences.slice(i).join('');
          writeSayBubble(petId, source, isLast && image ? { text: left, image } : { text: left });
          bubbleOwner = { petId, source };
        }
        return { ok: true };
      }
      const duration = Math.max(3000, audioDurationMs(said.audio) + VOICE_TAIL_MS);
      // 真的要出声了：保底闸从「合成 30 秒」换成「音频时长 + 3 秒」，重新计时（哥哥 11-15）
      spec.onPlayStart?.(audioDurationMs(said.audio));
      await waitSpeakGap();
      if (myEpoch !== epoch) {
        noteVoiceIssue(`synth-skip superseded-after-gap epoch=${myEpoch} now=${epoch} i=${i}/${sentences.length} pet=${petId}`);
        return { ok: false, interrupted: true };
      }
      // 气泡等语音**开始**才冒（哥哥 10-31 定），时长 = 音频 + 2 秒尾巴。
      let shown = false;
      const show = (): void => {
        if (shown) return;
        shown = true;
        dropHint('think');
        // 她开口了：在听 / 在想到此为止（不撤的话那行会一直挂着）
        setEarPhase('idle');
        if (myEpoch !== epoch) {
          noteBubble(`skip superseded epoch=${myEpoch} now=${epoch} i=${i}/${sentences.length} pet=${petId} src=${source} chars=${line.length}`);
          return;
        }
        bubbleOwner = { petId, source };
        // 【汐儿 · 11-20 m30910】声音起来了才挂【在说】（和气泡同一个起点）
        // 【11-20 m31853】同时把「在看」撤掉：她已经在说了，屏幕上不该再挂着「正在看」。
        dropHint('watch');
        if (spec.text.trim() !== '') pushHint('say', '【在说】', 'task');
        // 【汐儿 · 11-18 m27977】上下文两边同步：她**真说出口**的每句话都在这一刻进卷。
        // 以前只有对话那条路记一次整段（chatWithPet），陪伴 / 一眼看 / 说一句说的话一句都不进卷，
        // 结果她在陪伴里刚说完什么，转头聊天完全不知道 —— 哥哥说的「会说重复的话」就是这么来的。
        void sessionRef
          ?.append({ kind: 'said', text: line })
          .catch(() => undefined);
        writeSayBubble(
          petId,
          source,
          isLast && image
            ? { image, imageDuration: MEME_SHOW_MS, text: line, duration }
            : { text: line, duration },
        );
        noteBubble(`write pet=${petId} src=${source} i=${i}/${sentences.length} chars=${line.length} dur=${duration}ms image=${image ?? '-'}`);
      };
      await playAudio(said.audio, said.mime, show, myEpoch);
      if (!shown) {
        noteBubble(`fallback no-start-callback pet=${petId} src=${source} chars=${line.length} dur=${duration}ms`);
        show();
      }
      markSpeakEnd();
    }
    return myEpoch === epoch ? { ok: true } : { ok: false, interrupted: true };
  };

  // ===================== 嗓子仲裁（哥哥 11-15 定；纯函数在 core/speak-center.ts） =====================
  // 五条出声路径全部归到这里：对话 / 陪伴 / 一眼看 / 碎碎念 / 菜单说一句 / 桥的 say-loud。
  // ① 同一时刻只有一条在响；② 手动动作是 urgent：掐掉正在播的、清空队列；
  // ③ 排队超过 SPEAK_EXPIRE_MS（15 秒，设置页「排队过期」可调）作废；④ 每条 job 有上限（音频时长+5s，不知道时长按字数估，封顶 60s）；
  // ⑤ 语音 + 气泡 + 表情包是同一个 job，一起排队、一起收尾。
  interface SpeakOutcome {
    ok: boolean;
    message?: string;
    /** 被后来的人打断了（声音没念完、气泡没冒完） */
    interrupted?: boolean;
  }
  interface SpeakSpec {
    key: string;
    priority: SpeakPriority;
    kind: 'say' | 'clip';
    text: string;
    image?: string;
    /** 要不要出声；false = 只冒泡（陪伴的独立开关走这里） */
    voice: boolean;
    /** 嗓子不可用 / 只冒泡时的气泡时长 */
    fallbackMs: number;
    source: 'chat' | 'companion' | 'dsh';
    petId: string;
    /** clip 专用：已经合成好的音频 */
    audio?: Uint8Array;
    mime?: string;
    /** clip 的音频时长（毫秒），用来算上限 */
    audioMs?: number;
    /** 播放真的开始时回调（写气泡） */
    onStart?: () => void;
    /** clip 专用：播放开始时写进气泡的文字（陪伴的自动出声走这里，和声音同一个起点） */
    bubbleText?: string;
    /** clip 专用：气泡里一起显示的表情包 */
    bubbleImage?: string;
    /** 真的开始出声：把保底闸换成「音频时长 + 3 秒」重新计 */
    onPlayStart?: (audioMs: number) => void;
    /** 新请求进来时把排着的、key 以此开头的旧请求踢掉（对话顶掉旧对话） */
    replacePrefix?: string;
    settle?: (outcome: SpeakOutcome) => void;
  }
  let speakJobSeq = 0;
  /** 代数：每次真的开新 job 或被打断都 +1。在途的回调一看代数变了就闭嘴（取代旧的 saySeq / loudEpoch） */
  let epoch = 0;
  let speakActive: SpeakSpec | null = null;
  let speakQueue: SpeakJob[] = [];
  const speakSpecs = new Map<string, SpeakSpec>();
  /**
   * 【汐儿 · 11-16 体检 B1】**丢掉一个还没轮到的任务时必须兑现它的 Promise**。
   * 原来四条丢弃路径（过期 / 被同类顶掉 / 队列满 / 手动打断）只 `speakSpecs.delete()`，
   * 于是 `await sayWithVoice(...)`、`await centerSay(...)`、`await speakOnce()` 永远挂着，
   * 桥的 `POST /say` 也就永远不回包。凡是「任务离队」，一律走这里。
   */
  /** 取出一个轮到的任务：离开排队表，但**不算丢**——它马上要播，Promise 由播完那边兑现。 */
  const takeSpeakSpec = (key: string): SpeakSpec | undefined => {
    const spec = speakSpecs.get(key);
    speakSpecs.delete(key);
    return spec;
  };
  /**
   * 【11-18 待办第 1 条】「想说没说」的账。
   * `sessionStore` 在这个函数后面才建（读音如卷要等数据目录就位），所以先留一个晚绑定的引用；
   * null 时直接跳过——宁可少记一笔，也不让记账把说话流程带崩。
   */
  let sessionRef: SessionStore | null = null;
  let lastThought: { text: string; at: number } | null = null;
  const rememberThought = (spec: SpeakSpec, reason: string | undefined): void => {
    if (spec.kind !== 'say') return;
    if (!shouldRecordThought(spec.priority, reason)) return;
    const text = spec.text.trim();
    if (text === '') return;
    const nowMs = Date.now();
    if (isDuplicateThought(lastThought, text, nowMs)) return;
    lastThought = { text, at: nowMs };
    const store = sessionRef;
    if (store === null) return;
    void store.append({ kind: 'thought', text, at: nowMs }).catch(() => {});
    noteSpeak(`thought reason=${reason} chars=${Array.from(text).length}`);
  };
  const dropSpeakJob = (key: string, outcome: SpeakOutcome): void => {
    const gone = speakSpecs.get(key);
    if (gone === undefined) return;
    speakSpecs.delete(key);
    noteSpeak(`drop key=${key} reason=${outcome.message ?? (outcome.interrupted === true ? 'interrupted' : 'dropped')}`);
    // 丢掉的句子记一笔「想说没说」（只有 high 以上才记，碎碎念天天被丢，记了是噪音）
    rememberThought(gone, outcome.message ?? (outcome.interrupted === true ? 'interrupted' : undefined));
    try {
      gone.settle?.(outcome);
    } catch {
      /* 回调出错不该把队列搞挂 */
    }
  };
  const speakBusy = (): boolean => speakActive !== null;
  const asJob = (spec: SpeakSpec): SpeakJob => ({
    key: spec.key,
    priority: spec.priority,
    // 【汐儿 · 11-15 22:40 修复】这里原来写死 0，于是每个任务一进队列就被 expirePending 判成
    // 「等了 1.79e12 毫秒」当场作废 —— 表现是「重启后没声音、什么功能都没生效」。
    enqueuedAt: Date.now(),
    kind: spec.kind,
    text: spec.text,
    chars: Array.from(spec.text).length,
  });

  /** 没轮到的过期句子攒在这儿，并进下一句（哥哥 11-15 23:16：超时把信息带进下一句话） */
  let speakCarry = '';
  const carrySpeak = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const merged = speakCarry === '' ? trimmed : speakCarry + ' ' + trimmed;
    speakCarry = Array.from(merged).slice(-120).join('');
    noteVoiceIssue('carry chars=' + Array.from(speakCarry).length);
  };
  const takeSpeakCarry = (): string => {
    const text = speakCarry;
    speakCarry = '';
    return text;
  };

  const pumpSpeak = (): void => {
    if (speakActive !== null) return;
    const now = Date.now();
    const { keep, expired } = expirePending(speakQueue, now, voiceStaleMs());
    if (expired.length > 0) {
      for (const gone of expired) {
        dropSpeakJob(gone.key, { ok: false, message: 'expired' });
        noteVoiceIssue(`expire key=${gone.key} priority=${gone.priority} waited=${now - gone.enqueuedAt}ms`);
        // 作废不等于白丢：内容攒起来并进下一句（哥哥 11-15）
        if (gone.kind === 'say') carrySpeak(gone.text);
      }
      speakQueue = keep;
    }
    const picked = pickNext(speakQueue);
    if (picked.next === undefined) return;
    speakQueue = picked.rest;
    const spec = takeSpeakSpec(picked.next.key);
    if (spec === undefined) {
      pumpSpeak();
      return;
    }
    speakActive = spec;
    epoch += 1;
    const myEpoch = epoch;
    const startedAt = Date.now();
    // 【汐儿 · 11-15 23:20】保底闸分两段（哥哥定）：合成阶段 30 秒；开始出声后改成音频时长 + 3 秒。
    let budget = SYNTH_GUARD_MS;
    noteVoiceIssue(
      `start key=${spec.key} priority=${spec.priority} kind=${spec.kind} chars=${spec.text.length} epoch=${myEpoch} budget=${budget}ms`,
    );
    noteSpeak(
      `start key=${spec.key} priority=${spec.priority} kind=${spec.kind} chars=${Array.from(spec.text).length} epoch=${myEpoch} budget=${budget}ms`,
    );
    let settled = false;
    const done = (outcome: SpeakOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (speakActive !== null && speakActive.key === spec.key) speakActive = null;
      markSpeakEnd();
      noteVoiceIssue(
        `finish key=${spec.key} ok=${outcome.ok} interrupted=${outcome.interrupted === true} cost=${Date.now() - startedAt}ms`,
      );
      noteSpeak(
        `finish key=${spec.key} ok=${outcome.ok} interrupted=${outcome.interrupted === true} cost=${Date.now() - startedAt}ms message=${outcome.message ?? ''}`,
      );
      try {
        spec.settle?.(outcome);
      } catch {
        /* 回调出错不该把队列搞挂 */
      }
      // 【11-18 缺口①】换卷检查放在这里，不是「聊天说完才查」——
      // 陪伴 / 一眼看 / 碎碎念的发言也进卷，只在聊天里查会漏掉它们，卷会一直涨。
      if (spec.kind === 'say') void sessionRef?.rollIfNeeded().catch(() => undefined);
      pumpSpeak();
    };
    const onGuard = (): void => {
      if (speakActive === null || speakActive.key !== spec.key) return;
      noteVoiceIssue(`speak-stuck key=${spec.key} over ${budget}ms force-release`);
      noteSpeak(`drop key=${spec.key} reason=stuck budget=${budget}ms`);
      stopLoud();
      speakActive = null;
      done({ ok: false, message: 'stuck' });
    };
    let guard = setTimeout(onGuard, budget);
    /** 出声时重计保底闸（合成慢不该连累长句） */
    const armGuard = (audioMs: number): void => {
      budget = playGuardMs(audioMs);
      clearTimeout(guard);
      guard = setTimeout(onGuard, budget);
      noteVoiceIssue(`play-start key=${spec.key} audio=${Math.round(audioMs)}ms budget=${budget}ms`);
    };
    spec.onPlayStart = armGuard;
    const run = spec.kind === 'clip' ? runSpeakClip(spec, myEpoch) : runSpeakText(spec, myEpoch);
    void run.then(done).catch((error) => {
      done({ ok: false, message: error instanceof Error ? error.message : String(error) });
    });
  };

  /** 收下一条：替换同类旧请求 → 仲裁 → 入队 → 试着开念 */
  const enqueueSpeak = (spec: SpeakSpec): Promise<SpeakOutcome> => {
    if (spec.replacePrefix !== undefined && spec.replacePrefix !== '') {
      for (let i = speakQueue.length - 1; i >= 0; i -= 1) {
        if (speakQueue[i].key.startsWith(spec.replacePrefix)) {
          dropSpeakJob(speakQueue[i].key, { ok: false, message: 'replaced' });
          speakQueue.splice(i, 1);
        }
      }
    }
    const decision = admitSpeak(
      speakActive === null ? null : asJob(speakActive),
      speakQueue,
      asJob(spec),
      mouthQueueMax(),
    );
    if (!decision.accepted) {
      debugTrace(`[speak] 丢掉 ${spec.key}：${decision.reason ?? 'unknown'}`);
      noteSpeak(`reject key=${spec.key} priority=${spec.priority} reason=${decision.reason ?? 'unknown'}`);
      return Promise.resolve({ ok: false, message: decision.reason ?? 'dropped' });
    }
    for (const gone of decision.dropped) dropSpeakJob(gone.key, { ok: false, message: 'queue-full' });
    speakQueue = decision.queue;
    return new Promise<SpeakOutcome>((resolve) => {
      speakSpecs.set(spec.key, { ...spec, settle: resolve });
      pumpSpeak();
    });
  };

  /** 说一句（对话 / 陪伴 / 一眼看 / 碎碎念共用）：排队，不叠音；气泡跟着语音走 */
  const centerSay = (req: {
    text: string;
    image?: string;
    voice?: boolean;
    priority?: SpeakPriority;
    source?: 'chat' | 'companion' | 'dsh';
    petId?: string;
    fallbackMs?: number;
    replacePrefix?: string;
  }): Promise<SpeakOutcome> => {
    if (req.text.trim() === '') return Promise.resolve({ ok: true });
    // 在听 / 在想的时候，陪伴、一眼看、碎碎念都别出声（回话本身不受影响：那时状态已经撤了）
    if (earMuted() && (req.priority ?? 'normal') !== 'urgent') return Promise.resolve({ ok: false, message: 'ear-busy' });
    const priority = req.priority ?? 'normal';
    // 上一句没轮到的，并到这一句前面一起说（urgent 是手动动作，不背旧账）
    const carried = priority === 'urgent' ? '' : takeSpeakCarry();
    const text = carried === '' ? req.text : carried + ' ' + req.text;
    const source = req.source ?? 'chat';
    const prefix =
      priority === 'urgent' ? 'manual' : priority === 'high' ? 'look' : source === 'companion' ? 'watch' : 'chat';
    const spec: SpeakSpec = {
      key: `${prefix}:${++speakJobSeq}`,
      priority,
      kind: 'say',
      text,
      ...(req.image === undefined ? {} : { image: req.image }),
      voice: req.voice !== false,
      fallbackMs: req.fallbackMs ?? 12_000,
      source,
      petId: req.petId ?? 'main',
      ...(req.replacePrefix === undefined ? {} : { replacePrefix: req.replacePrefix }),
    };
    return enqueueSpeak(spec);
  };

  /**
   * 说一句（对话 / 看一眼 / 陪伴共用）：排队，不叠音；气泡跟着语音走（时长 = 音频 + 尾巴）。
   * 【汐儿 · 11-15】现在只是 centerSay 的薄封装，名字保留是因为调用点太多（20 多处）。
   */
  const sayWithVoice = async (
    petId: string,
    text: string,
    image?: string,
    priority: SpeakPriority = 'normal',
  ): Promise<void> => {
    if (text.trim() === '') return;
    await centerSay({
      text,
      ...(image === undefined ? {} : { image }),
      priority,
      source: 'chat',
      petId,
      replacePrefix: priority === 'high' ? '' : 'chat:',
    });
  };

  /** 播一段已经合成好的音频（桥的 say-loud 走这里）：默认 urgent，先掐掉正在念的 */
  const centerPlayClip = (req: {
    audio: Uint8Array;
    mime: string;
    text: string;
    priority?: SpeakPriority;
    petId?: string;
    onStart?: () => void;
    bubbleText?: string;
    bubbleImage?: string;
  }): Promise<SpeakOutcome> => {
    // 同一道闸：在听 / 在想的时候，别人（陪伴的自动出声）播的音频让路；urgent 照旧
    if (earMuted() && (req.priority ?? 'urgent') !== 'urgent') return Promise.resolve({ ok: false, message: 'ear-busy' });
    const spec: SpeakSpec = {
      key: `clip:${++speakJobSeq}`,
      priority: req.priority ?? 'urgent',
      kind: 'clip',
      text: req.text,
      voice: true,
      fallbackMs: 12_000,
      source: 'dsh',
      petId: req.petId ?? 'main',
      audio: req.audio,
      mime: req.mime,
      audioMs: audioDurationMs(req.audio),
      ...(req.onStart === undefined ? {} : { onStart: req.onStart }),
      ...(req.bubbleText === undefined || req.bubbleText === '' ? {} : { bubbleText: req.bubbleText }),
      ...(req.bubbleImage === undefined ? {} : { bubbleImage: req.bubbleImage }),
    };
    return enqueueSpeak(spec);
  };

  /** 播一段音频（clip job）：气泡由 onStart 回调写，收尾统一在这里 */
  const runSpeakClip = async (spec: SpeakSpec, myEpoch: number): Promise<SpeakOutcome> => {
    if (spec.audio === undefined || spec.mime === undefined) return { ok: false, message: 'clip 缺音频' };
    let shown = false;
    const show = (): void => {
      if (shown) return;
      shown = true;
      try {
        spec.onStart?.();
      } catch {
        /* 回调出错不该把播放搞挂 */
      }
      // 【汐儿 · 11-16】clip（陪伴的自动出声）以前只有声音没有字：
      // 这里在「音频真的开始」这一刻写气泡，时长口径与对话那条一致（音频 + 2 秒尾巴）。
      if (spec.bubbleText !== undefined && spec.bubbleText.trim() !== '') {
        const clipMs = spec.audioMs ?? (spec.audio === undefined ? 0 : audioDurationMs(spec.audio));
        const clipDur = Math.max(3000, clipMs + VOICE_TAIL_MS);
        writeSayBubble(
          spec.petId,
          'companion',
          spec.bubbleImage === undefined
            ? { text: spec.bubbleText.trim(), duration: clipDur }
            : { text: spec.bubbleText.trim(), image: spec.bubbleImage, duration: clipDur },
        );
        noteBubble(
          `clip-write pet=${spec.petId} chars=${spec.bubbleText.trim().length} dur=${clipDur}ms image=${spec.bubbleImage ?? '-'}`,
        );
      }
    };
    await playAudio(spec.audio, spec.mime, show, myEpoch);
    if (!shown) show();
    return myEpoch === epoch ? { ok: true } : { ok: false, interrupted: true };
  };

  /** 立刻闭嘴 + 清空队列（手动动作 / 卡死 / 退出）：同时收掉自己写的气泡 */
  const centerInterrupt = (reason: 'manual' | 'stuck' | 'shutdown'): void => {
    const dropped = speakQueue.length + (speakActive === null ? 0 : 1);
    epoch += 1;
    stopLoud(false);
    for (const job of speakQueue) dropSpeakJob(job.key, { ok: false, interrupted: true, message: `interrupted:${reason}` });
    speakQueue = [];
    const active = speakActive;
    speakActive = null;
    if (active !== null) {
      try {
        active.settle?.({ ok: false, interrupted: true, message: `interrupted:${reason}` });
      } catch {
        /* 回调出错不影响打断 */
      }
    }
    noteVoiceIssue(`interrupt reason=${reason} dropped=${dropped}`);
    noteSpeak(`interrupt reason=${reason} dropped=${dropped}`);
  };

  /**
   * 提示层（哥哥 11-16 m21310）：独立通道，不占说话气泡。
   * - task：后台正在做的事，做完才消失（【在看】【在听】【在想】）
   * - event：转瞬即逝的状态，几秒自己走（【陪伴：切换为全屏】）
   * 多件事一行一个，渲染层实时增减。
   */
  const hintItems = new Map<string, { id: string; text: string; kind: 'task' | 'event'; ttlMs?: number; at: number; until: number }>();
  /** 提示气泡的位置偏移与字号（设置页拖预览 / 滑杆写进配置，这里读出来跟着每帧带下去）。 */
  /** 小气泡默认位置（哥哥 11-17 定的标准档）：脑袋右边一点点，和本机现用值一致 */
  const HINT_DEFAULT_X = -79;
  const HINT_DEFAULT_Y = -7;
  const hintStyle = (): { x: number; y: number; size: number } => {
    const conf = findPetInstance(readAllConfig(configPaths), 'main')?.conf;
    const raw = (conf?.hint ?? {}) as { x?: unknown; y?: unknown; size?: unknown };
    const num = (value: unknown, fallback: number, lo: number, hi: number): number => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
    };
    // 默认位置（哥哥 11-17 m26607）：「以我现在这个为标准，刚好在脑袋右边一点点」→ -79 / -7
    return { x: num(raw.x, HINT_DEFAULT_X, -400, 400), y: num(raw.y, HINT_DEFAULT_Y, -400, 400), size: num(raw.size, 15, 10, 22) };
  };
  const flushHint = (): void => {
    const nowMs = Date.now();
    for (const [key, item] of hintItems) {
      if (item.until > 0 && nowMs >= item.until) hintItems.delete(key);
    }
    // 【11-18】最多 4 行；挤爆时先丢 status（toast），再丢 watch，最后才动 say（文档 9.9）
    const HINT_RANK: Record<string, number> = { status: 0, watch: 1, say: 2 };
    const items = [...hintItems.values()]
      .sort((a, b) => {
        const ka = a.kind === 'task' ? 0 : 1;
        const kb = b.kind === 'task' ? 0 : 1;
        if (ka !== kb) return ka - kb;
        const ra = HINT_RANK[a.id] ?? 3;
        const rb = HINT_RANK[b.id] ?? 3;
        if (ra !== rb) return ra - rb;
        return a.at - b.at;
      })
      .slice(0, 4)
      .map((item) => ({ id: item.id, text: item.text, kind: item.kind, at: item.at }));
    // 【汐儿 · 11-16 m21833】位置和字号跟着一起写：渲染层只管照着摆，不自己读配置。
    const style = hintStyle();
    try {
      state.writePet('main', 'hint', { items, offset: { x: style.x, y: style.y }, size: style.size });
    } catch {
      /* 提示写不进去不影响主流程 */
    }
  };
  /** 起一条提示；同 id 会就地更新（不会一行变两行）。 */
  const pushHint = (id: string, text: string, kind: 'task' | 'event' = 'task', ttlMs = 0): void => {
    const nowMs = Date.now();
    hintItems.set(id, { id, text, kind, ttlMs, at: nowMs, until: ttlMs > 0 ? nowMs + ttlMs : 0 });
    flushHint();
    if (ttlMs > 0) {
      const timer = setTimeout(() => {
        hintItems.delete(id);
        flushHint();
      }, ttlMs);
      timer.unref?.();
    }
  };
  /**
   * 【汐儿 · 11-17】灯的自愈（文档 9.14 缺口②）：`listen` 60 秒、其余任务灯 90 秒没人续就自动收，
   * 并记一行 `lamp-timeout`。模块崩了、心跳断了，副气泡不会永远挂着骗人。
   */
  const LAMP_TTL_MS: Readonly<Record<string, number>> = {
    listen: 60_000,
    ear: 60_000,
    think: 90_000,
    // 【在看】这盏（watch）也归这里兜：只有它一条，「陪伴取帧 / 一眼看」共用同一个 id。
    watch: 90_000,
    say: 90_000,
  };
  const lampTimer = setInterval(() => {
    const nowMs = Date.now();
    for (const item of [...hintItems.values()]) {
      const ttl = LAMP_TTL_MS[item.id];
      if (ttl === undefined || item.kind !== 'task') continue;
      if (nowMs - item.at <= ttl) continue;
      hintItems.delete(item.id);
      flushHint();
      noteBubble(`lamp-timeout id=${item.id} age=${nowMs - item.at}ms`);
    }
  }, 30_000);
  lampTimer.unref?.();

  const dropHint = (id: string): void => {
    if (hintItems.delete(id)) flushHint();
  };
  /** 状态气泡（看一眼/识图这类）：走提示层，不盖说话气泡 */
  const centerHint = async (text: string, duration = 15_000): Promise<void> => {
    pushHint('status', text, 'event', Math.max(1_000, duration));
  };

  /** 最近三句「说一句」说的话（去重用） */
  const recentSays: string[] = [];
  /**
   * 【11-18 待办第 4 条】说一句不再随机抽台词：读卷 + 看时辰，让模型随口一句。
   * 8 秒抢不到就回落到按时辰挑的兜底台词——点了菜单必须出声，不能干等。
   */
  const sayOnceText = async (): Promise<string> => {
    const nowMs = Date.now();
    const found = findPetInstance(readAllConfig(configPaths), 'main');
    if (found) {
      try {
        // 【11-20 m34508】说一句也带记忆块：摘要 / 最近 12 条 / 想说没说 / 记着的事 / 记忆怎么用。
        // 卷的内容全交给 memoryBlockFor，sayOncePrompt 只留「点了一下说一句」的指令和去重——
        // 两边都给的话，摘要和最近几句会在 system 和 prompt 里各出现一次，模型容易当成两件事说。
        const prompt = sayOncePrompt({ nowMs, summary: '', recent: [], recentSaid: recentSays });
        const live = await liveContext();
        const memory = await memoryBlockFor('说一句');
        const system =
          petSystemPrompt(found) +
          '\n\n' +
          STYLE_RULES +
          '\n\n' +
          memory +
          reasonBlock({ kind: 'say', idleMs: lastIdleMs }) +
          contextBlock(live.line);
        const ask = usesOwnModel(found.conf)
          ? generateChatViaGateway(gatewayFor(found.conf), system, [], prompt, [], 8_000)
          : generateChat(ctx, system, [], prompt, [], configuredModel(found.conf, 'chatModel'));
        const timeout = new Promise<null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 8_000);
          timer.unref?.();
        });
        const result = await Promise.race([ask, timeout]);
        if (result !== null && result.ok) {
          const said = tidySayOnce(result.text);
          if (said !== '' && !recentSays.includes(said)) return said;
        }
      } catch {
        /* 模型这条不通就走兜底，菜单点一下不能因为模型挂了没反应 */
      }
    }
    return pickFallback(nowMs, recentSays);
  };
  /** 说一句：用配好的嗓子出声 + 同时冒气泡（点菜单的即时反馈）——走仲裁，urgent */
  const speakOnce = async (): Promise<{ ok: boolean; message?: string }> => {
    const voice = servicesProvider('main').voice.available();
    if (!voice.ready) return { ok: false, message: `声音后端没配好：${voice.reason?.message ?? '未知原因'}` };
    const text = await sayOnceText();
    recentSays.push(text);
    while (recentSays.length > 3) recentSays.shift();
    const outcome = await centerSay({ text, priority: 'urgent', source: 'companion', petId: 'main', fallbackMs: 8_000 });
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message ?? '这句没念出来' };
  };

  /**
   * 改用户配置里的一点东西（右键菜单里"调一下"用）。
   *
   * 为什么不走 `saveUserConfig`：那是 `/config` PUT 的白名单重建，里头没有 `eventsRefreshSec`
   * 这一层，用它调间隔会被整段丢掉。这里读**用户层原对象**、只动目标字段、原样写回——
   * 未识别的键（memes / physics / 手写注释之外的字段）一个都不碰。
   * 没注释的 JSON 会被重新序列化成 2 空格缩进（与 PUT 写盘一致）。
   */
  const updateUserConfig = (mutate: (raw: Record<string, unknown>) => void): void => {
    const raw = (readUserConfig(configPaths) ?? {}) as Record<string, unknown>;
    mutate(raw);
    writeFileSync(configPaths.userFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    // 【11-18 10.5】写完立刻作废读盘缓存：同一毫秒内写完又读，光靠 mtime 分不出来
    invalidateConfigCache();
  };
  /** 自动碎碎念的总开关：写在 `pets[].whisperEnabled`（实例级，和设置页那个勾是同一个值） */
  const setWhisperEnabled = (enabled: boolean): void => {
    updateUserConfig((raw) => {
      const pets = Array.isArray(raw.pets) ? (raw.pets as Record<string, unknown>[]) : [];
      const found =
        pets.find((item) => item !== null && typeof item === 'object' && item.id === 'main') ?? pets[0];
      const target = (found ?? { id: 'main' }) as Record<string, unknown>;
      if (!found) {
        pets.unshift(target);
        raw.pets = pets;
      }
      target.whisperEnabled = enabled;
    });
  };
  /** 歌词开关：写进顶层 `lyric.enabled`，重启后按哥哥最后一次的选择来（11-02 要「默认开、别自己关」） */
  const setLyricEnabled = (enabled: boolean): void => {
    updateUserConfig((raw) => {
      const section =
        raw.lyric !== null && typeof raw.lyric === 'object' ? (raw.lyric as Record<string, unknown>) : {};
      raw.lyric = { ...section, enabled };
    });
  };
  /** 碎碎念间隔：写在顶层 `eventsRefreshSec.whisper`（秒） */
  const setWhisperInterval = (seconds: number): void => {
    updateUserConfig((raw) => {
      const section =
        raw.eventsRefreshSec !== null && typeof raw.eventsRefreshSec === 'object'
          ? (raw.eventsRefreshSec as Record<string, unknown>)
          : {};
      raw.eventsRefreshSec = { ...section, whisper: seconds };
    });
  };
  /** 打开碎碎念池：文件不在就先放一份能照着改的示例，再用系统默认程序打开 */
  const openWhisperPool = (): { ok: boolean; message?: string } => {
    try {
      if (!existsSync(whisperPoolFile)) {
        mkdirSync(userRoot, { recursive: true });
        const sample = [
          { text: '冒尖的白米饭最好吃。' },
          { text: '哥哥，记得喝口水。' },
          { text: '本鱼在这儿晃尾巴。', meme: '开心的摇尾巴' },
        ];
        writeFileSync(whisperPoolFile, `${JSON.stringify(sample, null, 2)}\n`, 'utf8');
      }
      // 用系统默认程序打开：记事本 / VSCode 都行，壳这边不替哥哥选编辑器
      spawn('cmd.exe', ['/c', 'start', '', whisperPoolFile], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      return { ok: true, message: '池子打开了' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };

  /**
   * 「碎碎念 → 自定义间隔…」：打开一个只有输入框的小窗（浏览器里，带令牌）。
   *
   * 右键菜单只能点 label、没法输入数字，而哥哥要"菜单里就能手填秒数"——所以菜单项负责开门，
   * 真正的输入在那页做，保存后写的是同一个 `eventsRefreshSec.whisper`。
   * 只有独立版拿得到带令牌的地址；DSH 插件模式回一句明确原因，不假装打开。
   */
  const openWhisperIntervalWindow = (): { ok: boolean; message?: string } => {
    try {
      const tray = ctx.standalonePetTray as { settingsUrl?: () => string } | undefined;
      const settingsUrl = typeof tray?.settingsUrl === 'function' ? tray.settingsUrl() : '';
      if (!settingsUrl) return { ok: false, message: '只有独立版能从菜单改间隔（插件模式请在配置里改）' };
      // `…/standalone-pet/#token=…` → `…/standalone-pet/whisper#token=…`（令牌原样带过去）
      const url = settingsUrl.replace('/standalone-pet/', '/standalone-pet/whisper');
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return { ok: true, message: '小窗打开了：填秒数点保存' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };

  /**
   * 「陪伴 → 自定义…」：和碎碎念共用同一个小窗，只是带 `target=companion`（哥哥 11-02 要自定义分钟数）。
   */
  const openCompanionIntervalWindow = (): { ok: boolean; message?: string } => {
    try {
      const tray = ctx.standalonePetTray as { settingsUrl?: () => string } | undefined;
      const settingsUrl = typeof tray?.settingsUrl === 'function' ? tray.settingsUrl() : '';
      if (!settingsUrl) return { ok: false, message: '只有独立版能从菜单改间隔（插件模式请在配置里改）' };
      const base = settingsUrl.replace('/standalone-pet/', '/standalone-pet/whisper');
      // target 走 query（不是 hash）：cmd 的 `start` 会把未加引号的 `&` 当命令分隔符，
      // 之前拼成 `#token=…&target=companion` 会开不出窗口（哥哥 11-02 报「没弹窗」）。
      const hashAt = base.indexOf('#');
      const url = hashAt >= 0 ? `${base.slice(0, hashAt)}?target=companion${base.slice(hashAt)}` : `${base}?target=companion`;
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return { ok: true, message: '小窗打开了：填分钟数点保存' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };

  /**
   * 把配置里的三个热键写成 `hotkeys.json` 给桌面壳读（`ear.js` 每 5 秒重读，改完不用重启）。
   *
   * 为什么绕一层文件而不是环境变量：热键是"随时会改"的东西，环境变量只在起壳那一次有效，
   * 改一次就得重启整个桌宠；给它一个文件，ear 自己会跟上。
   * 空字符串/非法值一律不写（让 ear 用它的默认 Alt+T / Alt+G / Alt+S），免得把热键写死成按不动的键。
   */
  const writeHotkeysFile = (): void => {
    try {
      const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
      const keys = (conf.hotkeys ?? {}) as Record<string, unknown>;
      const pick = (name: string): string => (typeof keys[name] === 'string' ? String(keys[name]).trim() : '');
      const out: Record<string, string> = {};
      const ear = pick('earHotkey');
      const peek = pick('peekHotkey');
      const say = pick('sayHotkey');
      if (ear !== '') out.earHotkey = ear;
      if (peek !== '') out.peekHotkey = peek;
      if (say !== '') out.sayHotkey = say;
      const file = join(userRoot, 'hotkeys.json');
      mkdirSync(userRoot, { recursive: true });
      writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    } catch (error) {
      debugTrace(`写 hotkeys.json 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** 执行一次菜单点击（认不出的 label 静默忽略：可能是旧版本残留或第三方项） */
  /**
   * 「嗓子 / 眼睛」点一下切一档：关 → 本地 → 云 → 关（哥哥 10-31 定的循环）。
   *
   * 为什么保留旧目标：切到「关」时只把 enabled 关掉、后端指向原样留着，
   * 再点一下回到本地/云时不用重新填地址——不然「关一下再开」就得重配一遍，太折腾。
   */
  /**
   * 【汐儿 · 11-17 m26051】右鍵菜单的「状态：嗓子」按四块循环：模型直连 → 本地 TTS → Windows → Edge → 回模型直连。
   * 和设置页共用 `applyVoicePick`（同一份口径），切块时别块的地址/密钥/参考音一个不丢。
   */
  // 【0.6 第 4 步 补二】菜单里直接点某一块（不再只能循环），所以把「写哪一块」抽出来
  const setVoicePick = (next: VoicePick): { ok: boolean; message?: string } => {
    updateUserConfig((raw) => {
      const applied = applyVoicePick(raw as Record<string, unknown>, next);
      raw.model = applied.model as typeof raw.model;
      raw.voice = applied.voice as typeof raw.voice;
    });
    return { ok: true, message: `嗓子换成「${voicePickWord(next)}」` };
  };

  const cycleVoicePick = (): { ok: boolean; message?: string } => {
    const found = findPetInstance(readAllConfig(configPaths), 'main');
    const conf = (found?.conf ?? {}) as Record<string, unknown>;
    const modelSection = conf.model;
    const current = pickOf(
      conf,
      modelSection !== null && typeof modelSection === 'object'
        ? (modelSection as Record<string, unknown>).tts
        : undefined,
    );
    return setVoicePick(nextVoicePick(current));
  };

  const setBackend = (
    capability: 'tts' | 'vision',
    next: BackendWord,
  ): { ok: boolean; message?: string } => {
    updateUserConfig((raw) => {
      const base = parseModelConfig(raw.model);
      const prev = capability === 'tts' ? base.tts : base.vision;
      const backend: typeof prev =
        next === 'local'
          ? {
              enabled: true,
              backend: { kind: 'local', endpoint: prev.backend.kind === 'local' ? prev.backend.endpoint : '' },
            }
          : next === 'remote'
            ? {
                enabled: true,
                backend:
                  prev.backend.kind === 'remote'
                    ? prev.backend
                    : { kind: 'remote', baseUrl: '', model: '', apiKey: '' },
              }
            : { enabled: false, backend: prev.backend };
      raw.model = toConfigSection({
        chat: base.chat,
        vision: capability === 'vision' ? backend : base.vision,
        tts: capability === 'tts' ? backend : base.tts,
      });
    });
    const name = capability === 'tts' ? '嗓子' : '眼睛';
    return { ok: true, message: `${name}切换为${modeWord(next)}` };
  };

  const cycleBackend = (capability: 'tts' | 'vision'): { ok: boolean; message?: string } => {
    const found = findPetInstance(readAllConfig(configPaths), 'main');
    const conf = (found?.conf ?? {}) as Record<string, unknown>;
    const cap = capability === 'tts' ? parseModelConfig(conf.model).tts : parseModelConfig(conf.model).vision;
    const currentWord: BackendWord = !cap.enabled ? 'off' : cap.backend.kind === 'local' ? 'local' : 'remote';
    return setBackend(capability, nextBackendWord(currentWord));
  };

  const runPetMenuAction = async (label: string): Promise<void> => {
    const action = parsePetMenuLabel(label);
    if (!action) return;
    // 【11-18】第 4 级：他亲手点的菜单项 → 记账 + 让屏幕想让路（打开菜单本身不算）
    noteCommand('menu', label.slice(0, 24));
    let result: { ok: boolean; message?: string };
    switch (action.kind) {
      case 'look':
        result = await lookOnce();
        lookCount += 1; // 状态行的「看过 N 次」要算上手动这一眼
        refreshPetMenu(); // 立刻把新计数写进菜单（否则要等下一次别的事件才刷新）
        return; // 「看一眼」自己会冒气泡，不再额外说一句
      case 'status': {
        // 哥哥 10-30：状态不只是陪伴开没开，要一口气报陪伴/歌词/看图/声音。
        // 四项里两项看运行态、两项看模型配置的 enabled + kind（off/local/remote）。
        const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<
          string,
          unknown
        >;
        const mc = parseModelConfig(conf.model);
        const word = (cap: typeof mc.vision): 'off' | 'local' | 'remote' =>
          !cap.enabled ? 'off' : cap.backend.kind === 'local' ? 'local' : 'remote';
        result = {
          ok: true,
          message: petStatusText({
            companionRunning: companion !== null && companion.status().running,
            companionIntervalMs: companionIntervalMs > 0 ? companionIntervalMs : configuredCompanionMs(),
            lyricRunning: lyricAgent !== null,
            vision: word(mc.vision),
            voice: word(mc.tts),
            watchRunning: watchRunning(),
            watchPace,
            watchSpeak: watchSpeakEnabled(),
            watchMode: watchMode(),
          }),
        };
        break;
      }
      case 'companion-custom':
        result = openCompanionIntervalWindow();
        break;
      case 'companion-start': {
        // 闸门挪进 startCompanion 了：现在陪伴要「念人话」，真正的前置是**聊天模型**，
        // 识图/嗓子没接只是静默降级（不出声、不看图），不该再拦人也不该冒报错气泡。
        result = startCompanion(action.intervalMs);
        break;
      }
      case 'companion-stop':
        stopCompanion();
        result = { ok: true };
        break;
      // 状态那一层的「陪伴」：点一下 = 开/关切换（哥哥 10-31：陪伴只要开关）
      case 'companion-toggle': {
        const runningNow = companion !== null && companion.status().running;
        if (runningNow) {
          stopCompanion();
          result = { ok: true, message: '陪伴停了' };
        } else {
          const started = startCompanion();
          result = started.ok
            ? { ok: true, message: '陪伴开了：按配置里的间隔看一眼' }
            : started;
        }
        break;
      }
      // 状态那一层的「陪伴」（11-09 改名，原「看护」）：开关切换（节奏沿用上次的）
      case 'watch-toggle': {
        if (watchRunning()) {
          stopWatch();
          result = { ok: true, message: '陪伴停了' };
        } else {
          result = startWatch();
        }
        break;
      }
      case 'watch-start':
        result = startWatch(action.pace);
        break;
      // 陪伴的独立声音开关（哥哥 11-09 晚：不是所有陪伴都要出声）
      // 【11-20 哥哥 m34789】陪伴的出声项和「说」层是**同一个开关**（voice.speak）：
      //   两处各存一份的话，关了一个另一个还开着，就又回到"为什么她还在响"的老问题。
      case 'watch-voice-toggle': {
        const next = !voiceSpeakOn();
        updateUserConfig((raw) => {
          const section =
            raw.voice !== null && typeof raw.voice === 'object' ? (raw.voice as Record<string, unknown>) : {};
          raw.voice = { ...section, speak: next };
        });
        result = { ok: true, message: next ? '会出声了' : '安静了（只看不说）' };
        break;
      }
      case 'say-toggle': {
        const next = !voiceSpeakOn();
        updateUserConfig((raw) => {
          const section =
            raw.voice !== null && typeof raw.voice === 'object' ? (raw.voice as Record<string, unknown>) : {};
          raw.voice = { ...section, speak: next };
        });
        result = { ok: true, message: next ? '出声了' : '静音了（只看不说）' };
        break;
      }
      case 'say-volume': {
        const now = voiceVolume();
        const next = now <= 30 ? 100 : now - 10;
        updateUserConfig((raw) => {
          const section =
            raw.voice !== null && typeof raw.voice === 'object' ? (raw.voice as Record<string, unknown>) : {};
          raw.voice = { ...section, volume: next };
        });
        result = { ok: true, message: `音量 ${next}` };
        break;
      }
      // 哥哥 11-09 晚：「让我看看笔记和识图的记录」——直接打开 logs\陪伴
      case 'watch-open-log': {
        void mkdir(watchLogDir, { recursive: true })
          .then(() => {
            spawn('cmd.exe', ['/c', 'start', '', layout.watchShots], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            }).unref();
          })
          .catch(() => {});
        result = { ok: true, message: '记录在 shots\\watch' };
        break;
      }
      // 哥哥 11-11 m19041：三个模式（自动检测 / 游戏 / 视频）。写进配置，下一张图就按新规则走，
      // 不用重启、也不用重开陪伴（watchSheet 里每张都现读 watchMode()）。
      // 【0.6 第 4 步 补 · 哥哥 m33124】取景收成一条：点一下 全屏 → 自动 → 窗口 → 全屏
      case 'watch-mode-cycle': {
        const nowMode: WatchMode = ((findPetInstance(readAllConfig(configPaths), 'main')?.conf as Record<string, unknown> | undefined)?.watch as Record<string, unknown> | undefined)?.mode as WatchMode | undefined ?? 'auto';
        const order: WatchMode[] = ['full', 'auto', 'window'];
        const nextMode = order[(order.indexOf(nowMode) + 1) % order.length];
        updateUserConfig((raw) => {
          const section =
            raw.watch !== null && typeof raw.watch === 'object' ? (raw.watch as Record<string, unknown>) : {};
          raw.watch = { ...section, mode: nextMode };
        });
        refreshPetMenu();
        result = {
          ok: true,
          message:
            nextMode === 'auto'
              ? '取景换成「自动」：跟着最前面的窗口截'
              : nextMode === 'full'
                ? '取景换成「全屏」：整块屏幕都算'
                : '取景换成「窗口」：只截当前那个窗口',
        };
        break;
      }
      case 'watch-mode': {
        updateUserConfig((raw) => {
          const section =
            raw.watch !== null && typeof raw.watch === 'object' ? (raw.watch as Record<string, unknown>) : {};
          raw.watch = { ...section, mode: action.mode };
        });
        refreshPetMenu();
        result = {
          ok: true,
          message:
            action.mode === 'auto'
              ? '陪伴换成「自动」：跟着最前面的窗口截'
              : action.mode === 'full'
                ? '陪伴换成「全屏」：整屏都截'
                : '陪伴换成「窗口」：只截你选的那个窗口',
        };
        break;
      }
      // 状态层第四项：联网查资料的总开关（默认开；只写 enabled，别的字段不动）
      case 'search-toggle': {
        const next = !searchEnabled();
        updateUserConfig((raw) => {
          const section =
            raw.search !== null && typeof raw.search === 'object' ? (raw.search as Record<string, unknown>) : {};
          raw.search = { ...section, enabled: next };
        });
        refreshPetMenu();
        result = { ok: true, message: next ? '联网查资料开了' : '联网查资料关了' };
        break;
      }
      // 【汐儿 · 11-22 m35769】搜索来源：免费爬虫 ↔ DeepSeek 搜索 API（写配置 search.provider）
      case 'search-source': {
        const next = searchSource().kind === 'deepseek' ? 'free' : 'deepseek';
        updateUserConfig((raw) => {
          const section =
            raw.search !== null && typeof raw.search === 'object' ? (raw.search as Record<string, unknown>) : {};
          raw.search = { ...section, provider: next };
        });
        refreshPetMenu();
        const hasKey = searchSource().apiKey !== '';
        result = {
          ok: true,
          message:
            next === 'deepseek'
              ? hasKey
                ? '搜索改用 DeepSeek（一条能带六七百字摘要）'
                : '搜索想用 DeepSeek，但还没填 key——现在仍按免费跑，去设置页「其他」填一把'
              : '搜索改回免费那条（抓搜索引擎结果页）',
        };
        break;
      }
      // 【11-20 体检 ⑦】听常驻开关（写配置 ear.resident；听.py 每次录音前读 /services/asr）
      // 【0.6 第 4 步】「听：听写模型 · medium」：本机只有一档，点了说明一句，不假装能切
      case 'asr-model':
        result = { ok: true, message: '听写模型只有 medium 一档（本机没装别的）' };
        break;
      case 'ear-resident-toggle': {
        const next = !earResident();
        updateUserConfig((raw) => {
          const section = raw.ear !== null && typeof raw.ear === 'object' ? (raw.ear as Record<string, unknown>) : {};
          raw.ear = { ...section, resident: next };
        });
        refreshPetMenu();
        result = { ok: true, message: next ? '耳朵常驻开了（下一句起 6 秒变 3 秒）' : '耳朵常驻关了' };
        break;
      }
      case 'watch-stop':
        stopWatch();
        result = { ok: true };
        break;
      // 状态那一层的「歌词」：开关切换
      case 'lyric-toggle': {
        if (lyricAgent !== null) {
          stopLyric();
          setLyricEnabled(false);
          result = { ok: true, message: '歌词气泡关了' };
        } else {
          const started = startLyric();
          if (started.ok) setLyricEnabled(true);
          result = started.ok ? { ok: true, message: '歌词气泡开了' } : started;
        }
        break;
      }
      // 状态那一层的「嗓子 / 眼睛」：点一下在 关 → 本地 → 云 → 关 之间循环
      case 'cycle-voice':
        result = cycleVoicePick();
        break;
      case 'cycle-vision':
        result = cycleBackend('vision');
        break;
      // 【0.6 第 4 步 补二】三级菜单里直接点某一档
      case 'voice-set':
        result = setVoicePick(action.pick);
        break;
      case 'vision-set':
        result = setBackend('vision', action.word);
        break;
      case 'lyric-start':
        result = startLyric();
        if (result.ok) setLyricEnabled(true);
        break;
      case 'lyric-stop':
        stopLyric();
        setLyricEnabled(false);
        result = { ok: true };
        break;
      case 'whisper-enable':
        setWhisperEnabled(true);
        result = { ok: true };
        break;
      case 'whisper-disable':
        setWhisperEnabled(false);
        result = { ok: true };
        break;
      case 'whisper-interval':
        setWhisperInterval(action.seconds);
        result = { ok: true };
        break;
      case 'whisper-pool':
        result = openWhisperPool();
        break;
      case 'whisper-custom':
        result = openWhisperIntervalWindow();
        break;
      case 'speak':
        result = await speakOnce();
        // 成功就不再补气泡：speakOnce 已经冒过那句话，再补「说完了」等于连发两条（哥哥 10-30 定）
        if (result.ok) {
          refreshPetMenu();
          return;
        }
        break;
      case 'dsh-toggle': {
        // 接入开关：开 = 桌宠的回答交给 DSH 本鱼；关 = 回到自带模型（默认关）
        const bridge = await refreshDshBridge();
        if (!bridge.available) {
          result = { ok: false, message: 'DSH 没开（桥插件连不上）：先把 DSH 打开再点这里' };
          break;
        }
        const nextEnabled = !bridge.enabled;
        const changed = await setDshBridgeConfig(dshBridgeUrl, { enabled: nextEnabled });
        if (!changed) {
          result = { ok: false, message: 'DSH 没响应（可能刚关了）：开起来再试' };
          break;
        }
        dshBridge = await fetchDshBridgeState(dshBridgeUrl);
        result = {
          ok: true,
          message: nextEnabled
            ? `接入 DSH：开${dshBridge.title !== '' ? `（${dshBridge.title}）` : ''}`
            : '接入 DSH：关',
        };
        break;
      }
      case 'dsh-install': {
        result = await installBridgeToDsh();
        break;
      }
      case 'dsh-picker': {
        // 「选会话…」：会话太多，菜单塞不下也翻不动 → 开网页挑（哥哥 11-01 晚提的）
        const bridge = await refreshDshBridge();
        if (!bridge.available) {
          result = { ok: false, message: '没连上 DSH（桥插件没开？）' };
          break;
        }
        try {
          spawn('cmd.exe', ['/c', 'start', '', `${dshBridgeUrl}/picker`], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          }).unref();
          result = { ok: true, message: '选会话的页面开了：点一行就接上' };
        } catch (error) {
          result = { ok: false, message: `打不开页面：${error instanceof Error ? error.message : String(error)}` };
        }
        break;
      }
    }
    refreshPetMenu(); // 跑没跑起来、当前是哪一档：都体现在菜单的 ✓ 上
    const text = petMenuFeedback(action, result);
    // 【汐儿 · 11-16 m21833】哥哥要「什么东西打开了也要塞进副气泡里去【例如开关碎碎念】」——
    // 菜单动作的反馈不再顶掉说话气泡，改成提示层里的一条事件（3.5 秒自己消失）。
    if (text !== '') pushHint('menu', text, 'event', 3_500);
  };

  /** 上一次推给 S 的标签串：一样就不重写（否则每拍都推 counter，前端白白重拉配置） */
  let lastPetMenuSignature = '';
  /** 手动点「看一眼」累计次数（进程内；菜单状态行里显示「看过 N 次」用） */
  let lookCount = 0;
  /**
   * 气泡的「谁最新」序号（哥哥 10-31 报的问题：气泡抢着冒，新的被旧的盖住）。
   *
   * 起因：气泡现在**等语音开始才写**（合成 + 播放器启动有几百毫秒），于是同一时刻
   * 两句话各自排着自己的定时器——先发的合成慢，后发的先冒，等先发的那个到点，
   * 反手把新的盖掉，看起来就是「冒完马上被换成上一句」。
   *
   * 规矩（11-15 起由仲裁中心的 `epoch` 统一管）：每次想说话先推一代；真要写叶子时再核对代数，
   * 不是最新就闭嘴。这样慢的那句自动让位，新的一定盖旧的。
   */
  /**
   * 两句之间要真有 SAY_GAP_MS 的**空隙**（哥哥 11-01：「一个一个冒，并设置好语音间隔」）。
   *
   * 起算点是「上一句**念完**的时刻」（`markSpeakEnd`），不是起念时刻——
   * 拿起念时刻算的话，音频本身比 1 秒长，下一句就会紧接着贴上来，间隔形同虚设（实测过）。
   */
  let lastSpeakEndAt = 0;
  const waitSpeakGap = async (): Promise<void> => {
    const wait = voiceGapMs() - (Date.now() - lastSpeakEndAt);
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
  };
  /** 一句念完了：记下来，下一句要等够间隔才能开口 */
  const markSpeakEnd = (): void => {
    lastSpeakEndAt = Date.now();
  };
  /** 按当下运行态重注册菜单（整体覆盖），并把快照推进 S 让壳下一拍就重拼 */
  refreshPetMenu = (): void => {
    // 用 status().running 而不是「句柄还在不在」：陪伴会在连续 idle / 识图连败时**自己停**，
    // 那时句柄还挂着但已经没在跑，菜单得如实显示成未启动（否则 ✓ 会骗人）。
    const running = companion !== null && companion.status().running;
    // 碎碎念那层（开关/间隔/池子）也要每次都按真实配置重算：菜单打 ✓ 靠它。
    // 注意分工：whisperEnabled 是**实例级**（pets[] 里那只）字段，eventsRefreshSec 是**条目级**。
    // 之前只取 .conf 导致 whisperEnabled 永远 undefined → 菜单明明开着却显示「自动开」。
    const whisperFound = findPetInstance(readAllConfig(configPaths), 'main');
    const whisperConf = (whisperFound?.conf ?? {}) as Record<string, unknown>;
    const whisperPet = (whisperFound?.pet ?? {}) as Record<string, unknown>;
    const labels = petMenuLabels({
      companionRunning: running,
      companionIntervalMs: companionIntervalMs > 0 ? companionIntervalMs : configuredCompanionMs(),
      lyricRunning: lyricAgent !== null,
      earResident: earResident(),
      // 状态层「联网查 · 开/关」：菜单标签读的就是这个字段（11-22 自测发现漏传 → 点了开关
      // 配置真变了、标签却永远显示「开」，看着像点了没反应）
      searchEnabled: searchEnabled(),
        // 【汐儿 · 11-22 m35769】搜索来源也进菜单状态（免费 / DeepSeek），标签要读这份
        searchProvider: searchSource().kind,
      // 状态那一层的「嗓子 / 眼睛」要显示当前后端（关/本地/云），读的是同一条 model 配置
      vision: backendWordOf(parseModelConfig(whisperConf.model).vision),
      voice: backendWordOf(parseModelConfig(whisperConf.model).tts),
      // 【汐儿 · 11-17 m26051】嗓子按四块显示（模型直连 / 本地 TTS / Windows / Edge）
      voicePick: pickOf(whisperConf, parseModelConfig(whisperConf.model).tts),
      // 「说」层：出不出声（全局）+ 当前音量
      speakEnabled: voiceSpeakOn(),
      voiceVolume: voiceVolume(),
      // 状态行（一级菜单上那句「陪伴 · 1 分钟 · 看过 3 次」）要的是真实计数：
      // ticks 是陪伴自己看的次数，lookCount 是手动点「看一眼」的次数。
      companionTicks: companion?.status().ticks ?? 0,
      // 看护：状态层那条要显示「开 正常 / 关」，明细层要打 ✓
      watch: { running: watchRunning(), pace: watchPaceNow(), speak: voiceSpeakOn(), mode: watchMode() },
      lookCount,
      whisperEnabled: whisperPet.whisperEnabled === true,
      // 这里**不能**调 whisperPeriodSec：它在下面才定义（const，TDZ），
      // 初始化时调会抛 "Cannot access 'whisperPeriodSec' before initialization"，
      // 整个菜单 effect 会被跳过 → 右键里只剩「更多」，看不到陪伴那一层。
      whisperIntervalSec: (() => {
        const n = Number((whisperConf.eventsRefreshSec as Record<string, unknown> | undefined)?.whisper);
        return Number.isFinite(n) && n > 0 ? n : 60;
      })(),
      // 状态 ▸ 接入：**永远都在**（桥没连上也显示「没连上」）——藏起来的话第一次用的人
      // 根本不知道有这功能（哥哥 11-01 报过一次「右键菜单里没有」）。标题只放会话名前 12 字。
      dshBridge: {
        // 11-03：DSH 关了以后发现文件还在，状态却读不到（available=false）——
        // 这时按最后一次连得上时的开关显示，并让菜单标出「没连上」，别假装一切正常或假装「关」。
        available: dshBridge.available,
        enabled: dshBridge.available ? dshBridge.enabled : dshBridgeWanted,
        title:
          dshBridgeUrl === ''
            ? '没连上'
            : dshBridge.title.length > 12
              ? `${dshBridge.title.slice(0, 12)}…`
              : dshBridge.title,
        // 选会话不塞菜单了（会话一多翻不动），菜单里只显示当前接的是谁 + 一个「选会话…」
        selectedTitle: (() => {
          const hit = dshBridge.sessions.find((item) => item.id === dshBridge.sessionId);
          return hit ? dshSessionLabel(hit) : '';
        })(),
      },
    });
    const signature = labels.join('\u0000');
    if (signature === lastPetMenuSignature) return; // 没变化：不打扰前端
    lastPetMenuSignature = signature;
    const registered = menuRegistry.register({ owner: PET_MENU_OWNER, labels });
    if (!registered.ok) {
      console.warn(`[dsh-pet] 陪伴菜单注册失败：${registered.message}`);
      return;
    }
    state.writeSection('menu', { items: menuRegistry.snapshot() });
  };
  // 注册一次（宿主起来就有菜单）+ 消费点击。轮询是**进程内**调用 registry，不走 HTTP 回环：
  // 同一进程自己请求自己只是绕远路，还多一份鉴权要维护。
  // 一次 poll 最多挂 MENU_WAIT_MAX_MS，醒了立刻重挂 —— 与 HTTP 长轮询同一条语义（读取即消费）。
  ctx.effect(() => {
    let disposed = false;
    refreshPetMenu();
    void (async () => {
      while (!disposed) {
        let events: Record<string, string | null> | null = null;
        try {
          events = await menuRegistry.poll(PET_MENU_OWNER, MENU_WAIT_MAX_MS);
        } catch (error) {
          console.warn(
            `[dsh-pet] 陪伴菜单轮询异常：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (disposed) break;
        // null = 这个 owner 已经不在了（被清掉/宿主重开）：重新注册再继续等。
        // 必须先清掉签名缓存 —— refreshPetMenu 有「标签没变就不写」的早退，
        // 不清的话这里会拿着旧签名一直早退，owner 永远注册不回来、poll 空转。
        if (events === null) {
          lastPetMenuSignature = '';
          refreshPetMenu();
          continue;
        }
        for (const [label, pet] of Object.entries(events)) {
          if (pet === null || disposed) continue; // 没点过的项是 null
          void runPetMenuAction(label);
        }
        // 陪伴会在连续 idle / 识图连败时自己停（companion.ts 内部 stop()，不回调宿主）。
        // 每醒一次对一下真实状态：停掉了就把 ✓ 撤掉（refresh 内部有签名比对，没变化不写 S）。
        refreshPetMenu();
      }
    })();
    return () => {
      disposed = true;
      menuRegistry.clear(PET_MENU_OWNER);
    };
  });
  // 歌词默认开：重启后不再自己关（哥哥 11-02）。配置里 lyric.enabled === false 时尊重关。
  ctx.effect(() => {
    const bootConf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
    const bootLyric = (bootConf.lyric ?? {}) as Record<string, unknown>;
    if (bootLyric.enabled === false) return () => {};
    const started = startLyric();
    if (started.ok) refreshPetMenu();
    else console.log('[lyric] 开机没起来：' + started.message);
    return () => {};
  });
  // 「接入 DSH」：初始化读一次发现文件，之后每 20 秒问一次桥（桥那边每次收到请求/改配置都会重写发现文件）
  // 【汐儿 · 11-03】失败一律吞掉：桥没起 / 请求被中止 / 配置读不到时这里 reject 是**常态**，
  // 不接住就是 unhandledRejection（源码形态下会让整份测试文件判红，宿主也可能被带崩）。
  const refreshBridgeQuiet = (): void => {
    void refreshDshBridge()
      .then(() => refreshPetMenu())
      .catch(() => {});
  };
  ctx.effect(() => {
    refreshBridgeQuiet();
    const timer = setInterval(refreshBridgeQuiet, 20_000);
    // 调参热更新（哥哥 11-10 m18312）：设置页保存后 5 秒内生效，不用重启身体。
    // 只在陪伴开着时同步，省得每 5 秒读一次配置——反正关着的时候没有帧要打分。
    const tuneTimer = setInterval(() => {
      if (watch && watch.status().running) watch.setTuning(watchTuning());
    }, 5_000);
    // 陪伴自恢复：上次是开着关掉的，就自己接着看。等眼睛就绪，最多试 12 次 × 5 秒。
    let autoTries = 0;
    const autoTimer = setInterval(() => {
      autoTries += 1;
      const conf = (findPetInstance(readAllConfig(configPaths), 'main')?.conf ?? {}) as Record<string, unknown>;
      const watchConf = (conf.watch ?? {}) as Record<string, unknown>;
      if (watchConf.autoStart !== true || watchRunning()) {
        clearInterval(autoTimer);
        return;
      }
      if (servicesProvider('main').eyes.available().ready) {
        const saved = watchConf.pace;
        const started = startWatch(saved === 'calm' || saved === 'normal' || saved === 'dense' ? saved : undefined);
        if (started.ok) {
          console.log('[watch] 开机自己接着陪（上次是开着的）');
          refreshPetMenu();
          clearInterval(autoTimer);
          return;
        }
      }
      if (autoTries >= 12) clearInterval(autoTimer);
    }, 5_000);
    // 【汐儿 · 11-11 m20008】字幕、剧情梗概都落盘，定期删掉过期的（哥哥：记得定时删除）
    void storyCache.cleanup().then((removed) => {
      if (removed > 0) console.log('[剧情] 清掉过期文件 ' + String(removed) + ' 个');
    }).catch(() => {});
    // 陪伴笔记（每日 jsonl）：保留 30 天 / 总量 20MB。以前完全不删，开着陪伴就一直涨。
    void pruneDir(watchLogDir, {
      now: Date.now(),
      keepDays: 30,
      maxBytes: 20 * 1024 * 1024,
      ext: '.jsonl',
      log: (line) => console.log(line),
    }).catch(() => {});
    // 屏幕流水也按 30 天 / 20MB 收（文档 5「落盘」）
    void pruneDir(screensDir, {
      now: Date.now(),
      keepDays: 30,
      maxBytes: 20 * 1024 * 1024,
      ext: '.jsonl',
      log: (line) => console.log(line),
    }).catch(() => {});
    return () => {
      clearInterval(timer);
      clearInterval(autoTimer);
      clearInterval(tuneTimer);
    };
  });
  // 系统通知帧：host 监听 DSH 宿主事件生成通知帧（帧契约与 shared/notify.ts 一致），写进 S 的
  // sections.notify，浏览器 1s 轮询 /state 后弹 toast。
  // 背景：DSH 0.1.5 删除浏览器侧 api.events.mux/host 事件流，改为 host 转发通道——
  // 不依赖 DSH 版本间变化的事件 API。
  // **单槽**（后到覆盖先到）：同一秒来多条只弹最后一条。这是有意的取舍——1 秒内连弹多个系统通知
  // 本身没有意义（反而更烦），所以不再带 seq / 增量帧队列（改造前的 frames 数组机制已删）。
  const pushNotifyFrame = (frame: HostNotifyFrame): void => {
    state.writeSection('notify', frame);
  }; /** 每会话 turn 级标志（goal 续跑轮判定；不参与展示，仅修正 turn/end 终局语义） */
  const turnFlags = new Map<string, WorkStatusTurnContext>();
  /** 终态（success/error）展示窗口定时器：约 60s 后清掉该会话条目，陈旧完成态不再浮上来（Bug 2/3） */
  const terminalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const TERMINAL_KEEP_MS = 60 * 1000;
  /** 取消某会话待执行的终态清理：会话已回到非终态，那次清理到点后既不清理也不重排，留着只会误导 */
  const cancelTerminalCleanup = (sessionId: string): void => {
    const t = terminalTimers.get(sessionId);
    if (t === undefined) return;
    clearTimeout(t);
    terminalTimers.delete(sessionId);
  };
  /** 排一个终态清理定时器（每会话一个，已排则跳过） */
  const scheduleTerminalCleanup = (sessionId: string): void => {
    if (terminalTimers.has(sessionId)) return;
    const t = setTimeout(() => {
      terminalTimers.delete(sessionId);
      const sessionState = workStatus.stateOf(sessionId);
      if (sessionState === 'success' || sessionState === 'error') {
        workStatus.clear(sessionId); // 条目连同它的任务详情文案一起消失，不残留到后续活动
        turnFlags.delete(sessionId);
        publishWorkStatus(); // 清完要写 S：否则前端一直挂着那条陈旧完成态
      }
    }, TERMINAL_KEEP_MS);
    terminalTimers.set(sessionId, t);
  };
  // 通知活动门（issue #114）：「对话完成」不立刻弹，先挂起，到点确认这条会话确实没活了再弹
  // （在跑的下属子代理 / 团队成员、后台任务、活跃提醒任一非空 → 丢弃这一帧）。
  //
  // 为什么必须延迟而不是同步查：`workspace/session-activity` 的 turn 族读的是**活 Agent 的
  // status**，而 turn/end 是在回合体的 finally 里追加的——同步那一刻它自己还是 running，判据必然
  // 非空，照「任一非空就不弹」写会把每一条通知都吞掉（详见 notify-events.ts 的 hasBlockingActivity）。
  // 延迟同时让「成员刚变 idle、Lead 下一秒 send_message 又把它唤醒」的窗口过去（队友邮箱是入队后
  // 立刻投递、空闲目标会起一轮）。
  //
  // 判据不可用（宿主没组合 workspace、standalone 伪 ctx 没有 waterfall、调用抛错、返回值形状不对）
  // → 一律放行：宁可多弹一条，也不能让通知被一次宿主变更整体打哑。
  const NOTIFY_ACTIVITY_DELAY_MS = 1500;
  /** 每会话一个待查定时器（同会话连续收尾只保留最后一次：后到覆盖先到，与单槽帧同语义） */
  const notifyActivityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** waterfall 只用到签名本身：DSH 未导出该事件的请求/响应类型，这里宽松声明（与 ctx 同为 any 的现状一致） */
  type Waterfall = (name: string, request: unknown, next: () => Promise<unknown[]>) => Promise<unknown>;
  /** 这条会话是否还有在跑的活；判据不可用一律 false＝放行 */
  const sessionHasRunningWork = async (sessionId: string): Promise<boolean> => {
    const waterfall = (ctx as { waterfall?: Waterfall }).waterfall;
    if (typeof waterfall !== 'function') return false;
    try {
      const activity = await waterfall.call(ctx, 'workspace/session-activity', { sessionId }, () =>
        Promise.resolve([]),
      );
      return hasBlockingActivity(activity);
    } catch {
      return false; // 查询失败不阻塞通知（与「判据不可用时放行」同一策略）
    }
  };
  /** 排一个活动门定时器：到点确认空闲才推这一帧 */
  const scheduleCompletionNotify = (sessionId: string, event: unknown): void => {
    const prev = notifyActivityTimers.get(sessionId);
    if (prev !== undefined) clearTimeout(prev);
    notifyActivityTimers.set(
      sessionId,
      setTimeout(() => {
        notifyActivityTimers.delete(sessionId);
        void (async () => {
          if (await sessionHasRunningWork(sessionId)) return; // 还有活：等真正的收尾轮再弹
          const frame = reduceNotifyFrame(event as Parameters<typeof reduceNotifyFrame>[0]);
          // 这条延迟路径（活动门等 1.5s 确认没活了才推的「对话完成」）最常被点，同样要带会话 id
          if (frame) pushNotifyFrame(withSessionId(frame, sessionId));
        })();
      }, NOTIFY_ACTIVITY_DELAY_MS),
    );
  };
  // 命令「当前桌宠」（/pet 选择、/chat 使用）：全局单值不分会话；进程内内存，重启回默认第一只
  let activePetId = '';
  // 碎碎念周期调度的「上次生成时刻」（按宠物）：调度拍据此判断到没到点。
  // 改造前这份节流靠 whisperCache（缓存 + ts 比较），现在"该不该生成"由调度侧决定、
  // "生成结果"直接写 S——多端共享同一句由 S 天然保证，不再需要第二份缓存。
  const lastWhisperAt = new Map<string, number>();

  // 【本鱼改造 · 短期记忆 10-30】记忆改成「当天回声」：只留今天真正调过模型的对话（chat / companion
  // 两条线分开记），一天一个 JSON（$DSH_HOME/dsh-pet/memory/YYYY-MM-DD.json，见 ./core/memory-store）。
  // 旧的 `memory.json`（跨天累积的那份）**不再读写**：文件留原地不动，但里面的历史从此不参与上下文——
  // 哥哥要的就是「桌宠不要长期记忆」，历史想留着自己翻文件。
  const memoryStore: MemoryStore = createMemoryStore({ dir: join(userRoot, 'memory') });
  // 屏幕流水目录 `screensDir` 声明在 apply 开头（同文件「为什么声明在这里」）：
  // 这边注册的定时器一执行就会用到它，写在这儿会撞 TDZ。
  // 【汐儿 · 11-17 第 4 批】换卷式上下文：卷满了（5000 字）就归档 + 摘要，旧卷不删。
  const sessionStore = createSessionStore({
    dir: join(userRoot, 'memory'),
    maxChars: contextRollChars,
    summarize: async (prompt) => {
      const found = findPetInstance(readAllConfig(configPaths), 'main');
      if (found === undefined) return '';
      const gateway = gatewayFor(found.conf);
      let out = '';
      for await (const frame of gateway.chat({
        messages: [{ role: 'system', text: '你是摘要器，只按要求输出摘要，不寒暄。' }, { role: 'user', text: prompt }],
        signal: AbortSignal.timeout(20_000),
      })) {
        if (frame.type === 'text' && typeof frame.text === 'string') out += frame.text;
        if (frame.type === 'error') return '';
      }
      return out;
    },
    log: (line) => {
      noteSense(line);
      noteTo('roll', line);
    },
    // 【11-18 第 11 条】换完卷叫她自己记卡片（`by:'pet'`）；包一层箭头，免得踩 TDZ
    remember: (turns) => rememberCards(turns),
  });
  // 「想说没说」记账要用同一个卷（晚绑定，见 rememberThought）
  sessionRef = sessionStore;
  // 长期卡片：他说「记住：…」或者设置页手填的，跨卷常驻
  let cardCache: Card[] | undefined;
  const cardsFile = join(userRoot, 'memory', 'cards.json');
  const loadCards = async (): Promise<Card[]> => {
    if (cardCache !== undefined) return cardCache;
    try {
      const parsed = JSON.parse(await readFile(cardsFile, 'utf8')) as { cards?: Card[] };
      cardCache = Array.isArray(parsed.cards) ? parsed.cards : [];
    } catch {
      cardCache = [];
    }
    return cardCache;
  };
  const saveCards = async (cards: Card[]): Promise<void> => {
    const { keep, archive } = splitOverflow(cards);
    cardCache = keep;
    await mkdir(dirname(cardsFile), { recursive: true });
    await writeFile(cardsFile, `${JSON.stringify({ cards: keep }, null, 2)}\n`, 'utf8');
    if (archive.length > 0) {
      const archiveFile = join(userRoot, 'memory', 'cards-archive.json');
      let old: Card[] = [];
      try {
        const parsed = JSON.parse(await readFile(archiveFile, 'utf8')) as { cards?: Card[] };
        if (Array.isArray(parsed.cards)) old = parsed.cards;
      } catch {
        old = [];
      }
      await writeFile(archiveFile, `${JSON.stringify({ cards: [...old, ...archive] }, null, 2)}\n`, 'utf8');
    }
  };
  /**
   * 换完卷，叫她自己记 1~2 张长期卡（`by:'pet'`，11-18 待办第 11 条）。
   *
   * 只挑「人、习惯、约定、梗」这类以后再聊会用到的；模型胡说或超时就算了，
   * 不阻塞换卷，也不往卡库里塞垃圾（同一句话已经在卡里就跳过）。
   */
  const rememberCards = async (turns: readonly { kind: string; text: string }[]): Promise<void> => {
    const spoken = turns
      .filter((turn) => turn.kind !== 'heard')
      .map((turn) => `${turn.kind === 'said' ? '你' : '他'}：${turn.text.replace(/\s+/gu, ' ').trim().slice(0, 80)}`)
      .filter((line) => line.length > 4)
      .slice(-12);
    // 【11-18 缺口②】门槛从 4 句放宽到 2 句（哥哥：「条数放宽，限制字数即可」）——
    // 短聊也有值得记的东西，卡库大小交给 CARD_MAX / CARD_TOTAL_CHARS 去管。
    if (spoken.length < 2) return;
    const found = findPetInstance(readAllConfig(configPaths), 'main');
    if (found === undefined) return;
    const prompt =
      '下面是一段刚聊完的对话。请挑出最多两条以后再聊会用到的长期事实（他是谁、习惯、约定、梗），' +
      '每条一行、不超过 30 字、不要编号不要解释；没有值得记的就输出一个「-」。\n\n' +
      spoken.join('\n');
    let out = '';
    try {
      if (usesOwnModel(found.conf)) {
        for await (const frame of gatewayFor(found.conf).chat({
          messages: [
            { role: 'system', text: '你只从对话里摘长期事实，不写评价、不寒暄。' },
            { role: 'user', text: prompt },
          ],
          signal: AbortSignal.timeout(12_000),
        })) {
          if (frame.type === 'text' && typeof frame.text === 'string') out += frame.text;
          if (frame.type === 'error') return;
        }
      } else {
        // 转给 DSH 的模型时自己没有网关，借宿主的聊天口（11-18 缺口②：这条路原来直接 return，
        // 卡片永远是 0 张）
        const result = await generateChat(
          ctx,
          '你只从对话里摘长期事实，不写评价、不寒暄。',
          [],
          prompt,
          [],
          configuredModel(found.conf, 'chatModel'),
        );
        if (result.ok !== true) return;
        out = result.text;
      }
    } catch {
      return;
    }
    const lines = out
      .split('\n')
      .map((line) => line.replace(/^[-\d.、*\s]+/gu, '').trim())
      .filter((line) => line !== '' && line !== '-')
      .slice(0, 2);
    if (lines.length === 0) return;
    const cards = await loadCards();
    const known = new Set(cards.map((card) => normalizeCardText(card.text)));
    const fresh = lines
      .filter((line) => !known.has(normalizeCardText(line)))
      .map((line) => makeCard({ text: line, by: 'pet' }))
      .filter((card): card is NonNullable<typeof card> => card !== undefined);
    if (fresh.length === 0) return;
    await saveCards([...cards, ...fresh]);
    noteSense(`cards pet +${fresh.length} ${fresh.map((card) => card.text.slice(0, 12)).join(' / ')}`);
  };

  /** 【刚聊过】最多带几条（哥哥 m33631：整卷 3,443 字把人设挤成零头，越聊越像复读机） */
  const RECENT_TURNS = 12;

  /** 这一段的摘要 + 最近几条 + 挑中的卡片，拼成系统提示词末尾的一块 */
  const memoryBlockFor = async (text: string): Promise<string> => {
    // 【11-20 m33631】只带最近 RECENT_TURNS 条 + 摘要：整卷 3,443 字会把 529 字的人设挤成零头，
    // 她照着旧话复读（「尾巴都打卷了」就是这么来的）。摘要兜住更早的事，条数兜住眼前的连贯。
    const [context, cards] = await Promise.all([sessionStore.context(RECENT_TURNS), loadCards()]);
    const picked = pickCards(cards, text, cardInjectCount());
    if (picked.length > 0) void saveCards(touchCards(cards, picked, Date.now())).catch(() => {});
    const lines: string[] = [];
    // 【11-20 m34441】三种毛病一起治：把背景当他刚说的、硬提旧事、记不清还编。
    if (lines.length === 0) lines.push(MEMORY_USAGE_RULES);
    if (context.summary !== '') lines.push('【上回说到】' + context.summary);
    if (context.turns.length > 0) {
      lines.push(
        '【刚聊过】' +
          context.turns
            .filter((turn) => turn.kind !== 'thought')
            .map((turn) => `${turn.kind === 'said' ? '你' : '他'}：${turn.text}`)
            .join(' / '),
      );
    }
    // 【刚才想说没说】只在 30 分钟内、最多 3 条——让她知道自己刚才有话没说出来
    const thoughts = recentThoughts(context.turns, Date.now());
    if (thoughts.length > 0) {
      lines.push('【刚才想说没说】' + thoughts.join(' / '));
    }
    if (picked.length > 0) {
      lines.push('【记着的事（这些是以前记下的，不是他刚说的）】' + picked.map((card) => card.text).join('；'));
    }
    return lines.length === 0 ? '' : '\n\n' + lines.join('\n');
  };
  // 对话写操作串行队列：read-modify-write 排队执行，防两端同时对话时交错写盘
  let chatQueue: Promise<void> = Promise.resolve();

  /** 对话上下文窗口：**最近 30 分钟**（哥哥 11-09：「上下文窗口改最近 30 分钟，不是轮数」）。
   *  为什么按时间：轮数在"聊两句就停"时太短、在"连问十句"时太长；按时间才像"刚才聊过"。
   *  跨零点只取当天（memory 按天分文件）——够用，先不跨天拼。 */
  const CHAT_WINDOW_MS = 30 * 60 * 1000;

  /** 窗口内的回声 → 生成侧要的 ChatMemoryMessage（role 映射：pet → assistant）。
   *  rounds 只有 /chat 的 GET 调试口还传，传了就在窗口结果上再按轮数截一次。 */
  const recentMessages = async (
    source: 'chat' | 'companion' = 'chat',
    rounds?: number,
  ): Promise<ChatMemoryMessage[]> => {
    const nowMs = Date.now();
    const all = await memoryStore.today(200);
    let turns = all.filter((t) => t.source === source && nowMs - t.at <= CHAT_WINDOW_MS);
    // 【汐儿 · 11-16 夜 m24648】历史里那些「照念屏幕」的旧话不能再喂回去——
    // 她已经念过一轮（验收/气泡/横纹），一读回去就接着念，重启后第一句尤其明显。
    if (source === 'chat') {
      const notes = all
        .filter((t) => t.source === 'watch' && nowMs - t.at <= 10 * 60 * 1000)
        .map((t) => t.text);
      if (notes.length > 0) {
        const kept = turns.filter((t) => !(t.role === 'pet' && looksLikeEcho(t.text, notes)));
        if (kept.length !== turns.length) {
          noteBubble(`echo-drop history ${turns.length - kept.length}`);
        }
        turns = kept;
      }
    }
    const mapped = turns.map((t) => ({
      role: t.role === 'pet' ? ('assistant' as const) : ('user' as const),
      content: t.text,
      ts: t.at,
    }));
    return rounds === undefined ? mapped : sliceMemoryRounds(mapped, rounds);
  };

  /** 「刚才在屏幕上看到的」：最近 10 分钟的识图笔记（source='watch'）。
   *  哥哥 11-09 定的是分两层：说出口的话进历史，识图笔记**只做注入**——每十几秒一条流水
   *  直接混进历史，她会变成报菜名。所以这里只拼进 system，绝不写进 messages。 */
  const SIGHT_WINDOW_MS = 10 * 60 * 1000;
  const recentSightBlock = async (nowMs: number = Date.now()): Promise<string> => {
    // 【11-18 待办第 2 条】改读屏幕流水；只取最新 3 条、10 分钟窗口（拼块和文案都在 pipeline/screens.ts）
    const notes = await readScreens(screensDir, dayOf(nowMs));
    if (notes.length === 0) return '';
    return screenBlock(notes, nowMs, SIGHT_WINDOW_MS, 3);
  };

  /** 把一次读写封进串行队列（同进程内防交错），返回 fn 的结果 */
  const withMemoryLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chatQueue.then(fn, fn);
    chatQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // ---- 配置消费：唯一入口 readAllConfig（./config）——返回值绝对正确，这里只读字段，零校验 ----

  /** 某宠物的最终人设 system：**实例级** `pets[].whisperPrompt` 优先，没写回落到所属条目
   *  （写在该条目 `pets` 里的实例 → 那个条目；主配置的实例 → `main`）的 whisperPrompt（合并器已填默认）。
   *  拼装本身在 ./persona（纯函数、有单测）：人设正文 + 一句名字声明（name，缺失已按 id）+ 一行时间背景
   *  （日期/星期/时刻/时段/工作日或周末/节日）——碎碎念与对话共用同一份拼装。
   *  时间每次现算（这里传 new Date()），所以拿到的永远是**当前**时刻，不需要额外的刷新机制。
   *
   *  收 `findPetInstance` 的**命中结果**而不是 `(petId, cfg)`：两个调用方都已经解析过了，这里再查一次
   *  只会多出一处"查不到就兜底 main"的不可达分支。 */
  const petSystemPrompt = (found: { conf: Record<string, unknown>; pet: Record<string, unknown> }): string =>
    composeSystemPrompt({
      prompt: petPersona(found.conf, found.pet),
      name: String(found.pet.name ?? ''),
      id: String(found.pet.id ?? ''),
      now: new Date(),
    });

  /** 对话记忆轮数（1 轮 = 1 问 1 答）：该宠物**所属条目**的 chatMemoryRounds（合并器已填默认非负数字）。
   *  同样收**已解析的条目配置**：两个调用方都已经拿到 `findPetInstance` 的结果。 */
  const memoryRounds = (conf: Record<string, unknown>): number => {
    const v = Number(conf.chatMemoryRounds);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
  };

  /** 生成/返回某宠物的一句碎碎念（周期 GET 与菜单手动触发共用的同一逻辑）：
   *  每只宠物独立生成（人设 = 它自己的 whisperPrompt，没写回落到所属条目）。生成成功就写进 S 的 pets.<id>.say——
   *  碎碎念 / 命令气泡 / 对话回复在前端本来就是**同一条展示链路**（同一个 triggerWhisper、
   *  同一个气泡槽、同一批 events.whisper 动画），所以合并成同一个叶子；"周期内不重复"由
   *  调度侧的 lastWhisperAt 保证，不再需要一份 whisperCache（多端共享也由 S 天然保证）。
   *  【本鱼改造 · 10-30 只走本地】哥哥的原话：「只走本地，用户可以自己写入（桌宠只负责在池子里抽卡）」。
   *  所以碎碎念**不再有模型兜底**：池子空着就是安静，不偷偷去调云端、不花一分钱。
   *  想换台词就改池文件（`$DSH_HOME/dsh-pet/碎碎念池.json`，按 mtime 自动重读，不用重启）。
   *
   *  失败**带回真实 reason**（含 `unknown-pet`：目标宠物在"校验那次读"与这里之间被删掉了）。
   *  成功**带回生成的文本**（与同时写进叶子的那份完全相同）——调用方拿到就不必再拉一拍 /state。 */
  const publishWhisper = async (
    petId: string,
  ): Promise<
    | { ok: true; text: string; image?: string }
    | {
        ok: false;
        reason: 'provider-missing' | 'generate-error' | 'unknown-pet' | 'empty-pool' | 'mouth-busy';
        message?: string;
      }
  > => {
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    // 宠物在"校验那次读"（requirePet / resolveActivePetId / 周期调度各自读的那一份）与这里之间被删了
    // ——配置随时可能被设置页 / 右键菜单 / 手改文件改动，两次读之间就是窗口。
    // **明确失败：不生成、不写 S**。写下去就是一只已不存在宠物的幽灵叶子（/state 里常驻到进程重启）。
    if (!found) return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
    // 【本鱼改造 · 碎碎念池】池文件在 → 随机取一句就用，**一个字都不叫模型**（省 token，也更快出话）。
    // 池里有条目但一条都不可用（既没字也没图）→ 明确回 empty-pool，不退化成"静默去叫模型"：
    // 那样用户改坏池文件后既看不到原因、又白花钱。
    const poolItems = readWhisperPool(whisperPoolFile, whisperPoolCache);
    if (poolItems.length > 0) {
      const said = pickFromWhisperPool(
        poolItems,
        memePoolFor(found.entry, found.conf),
      );
      if (!said) {
        return { ok: false, reason: 'empty-pool', message: '碎碎念池里没有可用的句子' };
      }
      // 【汐儿 · 11-20 m30910】碎碎念是 1 级：她正在说话（陪伴 / 一眼看 / 对话）时**整条让位**——
      // 以前这里无条件 epoch+=1，等于把正在念的那句掐掉，看着就像「陪伴的话被碎碎念挤掉了」。
      if (speakBusy()) {
        noteSpeak('reject key=whisper priority=low reason=mouth-busy');
        return { ok: false, reason: 'mouth-busy', message: '正在说话，碎碎念这次跳过' };
      }
      epoch += 1; // 碎碎念是「立刻说」：推一代，让还在合成中的旧句让位（哥哥 10-31 说的抢气泡）
      writeSayNow(petId, said as unknown as Record<string, unknown>);
      return { ok: true, ...said };
    }
    // 【本鱼改造 · 10-30 只走本地】独立模式下**到此为止**：池子空着就安静，不偷偷调云端。
    // 哥哥的原话是「只走本地，用户可以自己写入（桌宠只负责在池子里抽卡）」——所以这里
    // 绝不能回落成模型生成：那样既是"偷偷花钱"，也让"我明明关了 AI 它还在说话"变成怪事。
    // 插件模式（ctx.standaloneAi 不存在）保持老行为不动：那边一直是主人自己配的会话模型。
    // 【11-18 收口】碎碎念**两种模式都到此为止**：池空就安静，不回落模型。
    // 哥哥的原话「碎碎念就是个单纯的本地计时冒泡的」——它是 1 级（最不重要），
    // 花 token 让模型编一句嘟囔，既不值当，也让「我关了 AI 它还在说话」变成怪事。
    // 池文件坏了 / 没写，回 empty-pool 让人一眼看出原因（别静默成功）。
    return { ok: false, reason: 'empty-pool', message: '碎碎念池里没有可用的句子' };
  };

  /** 与某只宠物对话：截取最近记忆 → 生成回复 → 写入记忆 → 把回复写进 S 的 pets.<id>.say。
   *  供 POST /chat（动作端点）与 /chat 命令共用同一条路径（锁内读写，防两端交错写盘）。
   *  配图（chatImageEnabled 开启时）：把表情包清单交给模型按语境选一张，命中池内才随回复写回。
   *  成功**带回回复文本**（与同时写进叶子的那份完全相同）——调用方拿到就不必再拉一拍 /state。 */
  const chatWithPet = async (
    petId: string,
    text: string,
  ): Promise<
    | { ok: true; text: string; image?: string }
    | { ok: false; reason: 'provider-missing' | 'generate-error' | 'unknown-pet'; message?: string }
  > =>
    withMemoryLock(async () => {
      touchUser();
      // 【汐儿 · 11-17 第 2 批】等级由「听」这里定好交出去，想和嘴都不许改（哥哥批注三）。
      const heard = earEvent(text);
      registry.emitSense(heard);
      // 【汐儿 · 11-17 第 4 批】「记住：…」收进长期卡片；听到的话进这一卷
      const remember = parseRemember(text);
      if (remember !== undefined) {
        const card = makeCard({ text: remember, by: 'user' });
        if (card !== undefined) void loadCards().then((cards) => saveCards([...cards, card])).catch(() => {});
      }
      void sessionStore.append({ kind: 'heard', text }).catch(() => {});
      const memoryBlock = await memoryBlockFor(text).catch(() => '');
      // 从「收到话」到「开口」之间是空窗（模型要几秒）：先挂【在想】，开口那一刻撤（见 runSpeakTextInner）
      setEarPhase('think');
      const cfg = readAllConfig(configPaths);
      const found = findPetInstance(cfg, petId);
      // 宠物在"校验那次读"与这里之间被删了——本函数还要先排 withMemoryLock 的串行队列（等前一次生成
      // 跑完，窗口可能是**秒级**），所以这一支是真会命中的。
      // **明确失败：不生成、不写记忆也不写叶子**。否则会在 memory.json 里**永久**留下一个已删宠物的
      // 分桶，外加一只幽灵叶子（/state 里常驻到进程重启）。
      if (!found) return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
      // 「接入 DSH」开着：桌宠的话交给 DSH 本鱼，回复由桥在回合结束时送回气泡——这边不生成、
      // 也不写 pet 记忆（在 DSH 会话里聊什么，由 DSH 自己记；这里只记"我说了什么"）。
      if (dshBridgeUrl !== '' && (dshBridge.enabled || (!dshBridge.available && dshBridgeWanted))) {
        const sent = await sayToDsh(dshBridgeUrl, text);
        if (sent) {
          await memoryStore.remember({ role: 'user', text, source: 'chat' });
          // 回一句占位话给调用方：/chat 的调用方（热键「听」的听.py）拿空文本会当成"她没回话"
          // 报错。真正的内容等桥在回合结束时送回气泡/嗓子，这里只负责"我知道你在说了"。
          // 不写 pet 记忆（DSH 会话那边自己记），也不念出来（念就成第二份声音了）。
          pushHint('status', '转给 DSH 了，等她回话', 'event', 2_200);
          dropHint('think');
          // 状态也要一起撤：不撤的话接下来 45 秒里非 urgent 的声音全被挡（她自己也说不出来）
          setEarPhase('idle');
          return { ok: true as const, text: '（已转给本鱼，等她回话）' };
        }
        // 11-03：DSH 没开 / 桥插件没响应 → **降级自己答**，别把「DSH 那边没接住」丢给用户当错误。
        // 桥的状态顺手刷新一次，菜单和下一轮就知道它掉线了。
        dshBridge = await fetchDshBridgeState(dshBridgeUrl);
        pushHint('status', 'DSH 没开，先自己答', 'event', 2_400);
      }
      // 11-09：上下文改成「最近 30 分钟」时间窗，chatMemoryRounds 那一档不再截历史
      // 人设：实例级 whisperPrompt 优先，没写回落所属条目（与碎碎念同一拼装）
      // + 「刚看到」：最近 10 分钟的识图笔记（只进 system，不进历史）
      // 「上网查」：不再用关键词猜意图，改成**把搜索当工具交给她**（哥哥 m20199）——
      // 工具说明拼进 system，她需要查时只回一行 [[web_search: 查询词]]，宿主看见才真去搜。
      // 不查的时候一轮就结束：不多花模型调用，更不花网络。
      const searchOn = searchEnabled();
      // 聊天不看屏幕笔记（哥哥 11-17 m24834）：只带自己的会话上下文 + 卡片
      // 【汐儿 · 11-17 m26171】说话规矩两处共用（聊天 + 陪伴），以前聊天一条没有 → 像客服
      const live = await liveContext();
      const baseSystem =
        petSystemPrompt(found) +
        memoryBlock +
        '\n\n' +
        STYLE_RULES +
        '\n\n' +
        reasonBlock({ kind: 'chat', idleMs: lastIdleMs }) +
        contextBlock(live.line);
      const system = searchOn ? baseSystem + '\n\n' + SEARCH_TOOL_HINT : baseSystem;
      // 配图：开关关闭 → 空池（指令与解析都不介入，与旧行为逐字一致）；目录链按所属条目取。
      // 张数上限（chatImageLimit，0 = 不限制）：整张清单每条消息都要附，截断后费用上限可控。
      const pool =
        found.conf.chatImageEnabled === true
          ? limitPool(memePoolFor(found.entry, found.conf), Number(found.conf.chatImageLimit))
          : [];
      // 历史 = 最近 30 分钟：对话、看一眼、陪伴说的话共用这一个池（哥哥 11-09：不要隔离开）
      const list = await recentMessages();
      // 模型：条目配置的 chatModel 优先（留空 = 不指定）；生成侧失败会回落到当前对话的模型重试一次
      // 【汐儿 · 11-17 第 3 批】每问一次就开一轮「想」：他再开口时，上一轮没算完的自动作废。
      // 【汐儿 · 11-20 半流式】只预热首句：后面的句子播放时要串在首句后面合成，
      // 提前跑既白合成一遍、又会两句同时把嗓子堵住（11-15 实测首句等 21.7 秒就是这么来的）。
      let warmFirstUsed = false;
      const warmFirstSentence = (line: string): void => {
        if (warmFirstUsed) return;
        warmFirstUsed = true;
        warmSynth(line);
      };
      const ask = async (sys: string) => {
        const mine = mind.begin('main', heard.level);
        try {
          return usesOwnModel(found.conf)
            ? await generateChatViaGateway(gatewayFor(found.conf), sys, list, text, pool, undefined, mine.signal, warmFirstSentence)
            : await generateChat(ctx, sys, list, text, pool, configuredModel(found.conf, 'chatModel'));
        } finally {
          mine.end();
        }
      };
      let generated = await ask(system);
      if (!generated.ok) {
        dropHint('think');
        // 生成失败也要撤 ear 状态，否则接下来 45 秒里她一句都说不出来
        setEarPhase('idle');
        return generated;
      }
      // 她点名要查：搜一次（2 秒封顶），把资料塞回去请她用自己的话答。最多查一轮，防死循环。
      if (searchOn) {
        const call = parseToolCall(generated.text);
        if (call !== null) {
          const outcome = await searchRunner.run(call.query).catch(() => null);
          if (outcome !== null) {
            logChatSearch(
              `q=${outcome.query} ok=${outcome.ok} reason=${outcome.reason ?? '-'} hits=${outcome.hits} engine=${outcome.engine} cached=${outcome.cached} ms=${outcome.ms}`,
            );
            const follow = [
              baseSystem,
              '',
              outcome.note,
              '',
              '（这是你要查的东西，用你自己的话讲给他听；别照念标题，别编没查到的细节。）',
            ].join('\n');
            const second = await ask(follow);
            if (second.ok) generated = second;
          }
        }
      }
      // 记忆只存正文（配图属展示层，不进上下文——否则下次请求会把标记当历史读回去）
      await memoryStore.remember({ role: 'user', text, source: 'chat' });
      // 【汐儿 · 11-16 夜 m24648】如果这句基本是在照念屏幕上的字（验收清单、报错、测试结果），
      // 不存进「她说的话」——存了就变成下一轮的历史，她会自己喂自己，一句接一句念下去。
      {
        const sightNotes = (await memoryStore.today(200))
          .filter((t) => t.source === 'watch' && Date.now() - t.at <= 10 * 60 * 1000)
          .map((t) => t.text);
        if (looksLikeEcho(generated.text, sightNotes)) {
          noteBubble('echo-skip memory');
        } else {
          await memoryStore.remember({ role: 'pet', text: generated.text, source: 'chat' });
        }
      }
      // 【汐儿 · 11-16 晚 m24151】**回话本身就是等待的结束**：先把「在听 / 在想」撤掉再说话。
      // 不撤的话，下面的 sayWithVoice 走 normal 优先级，会被 earMuted() 的闸挡回来
      //（ear-busy，不出声也不冒泡）→ show() 永远不执行 → 状态永远停在【在想】= 死锁。
      setEarPhase('idle');
      dropHint('think');
      // 回复由 runSpeakTextInner 在**每句真的开播**时逐句写卷（11-18 m27977 统一口径），
      // 这里不再整段再记一次，否则卷里每条回复都会出现两遍。
      void sayWithVoice(petId, generated.text, generated.image, priorityFor(heard.level));
      // 同一份文本随返回值带出（叶子由 sayWithVoice 写，不是二选一）
      return { ok: true as const, text: generated.text, ...(generated.image ? { image: generated.image } : {}) };
    });

  /**
   * 当前生效宠物列表 = readAllConfig 成品拍平（main + 文件宠物全部条目；合并器已保证 id 唯一、
   * 字段填满），命令与桌面模式都从这里取。
   */
  const effectivePetList = (): Record<string, unknown>[] => flattenPetList(readAllConfig(configPaths));

  /** 余额刷新周期（秒）：成品 main 条目的 eventsRefreshSec.balance（合并器已填默认；非法兜底 1800） */
  const balancePeriodSec = (cfg: Record<string, Record<string, unknown>>): number => {
    const ers = cfg.main?.eventsRefreshSec as Record<string, unknown> | undefined;
    const n = Number(ers?.balance);
    return Number.isFinite(n) && n > 0 ? n : 1800;
  };

  /** 碎碎念周期（秒）：该宠物**所属条目**的 eventsRefreshSec.whisper（合并器已填默认；非法兜底 60）。
   *  收**已解析的条目配置**：唯一调用方是周期调度，而它的 `petId` 就是从**同一份 cfg** 拍平出来的，
   *  所以这里再查一次只会多出一处"查不到就兜底 main"的不可达分支。 */
  const whisperPeriodSec = (conf: Record<string, unknown>): number => {
    const ers = conf.eventsRefreshSec as Record<string, unknown> | undefined;
    const n = Number(ers?.whisper);
    return Number.isFinite(n) && n > 0 ? n : 60;
  };

  /**
   * 刷新余额并写入 S —— host 侧**唯一**的余额查询点。
   *
   * 改造前是每个客户端各自按自己的定时器去查（浏览器一个 + 桌面每窗口一个）：同一份外部 API
   * 被重复请求、两端还可能看到新旧不一致的数据。现在只有这里查，两端都从 /state 读同一份结果。
   *
   * 失败也写进 S（reason 区分 unsupported / credential-missing / fetch-error）——余额不可用要弹
   * 文字说明气泡，不能静默；意外异常同样落成 fetch-error，不吞。
   *
   * @param manual 这次刷新是不是"用户要的"（/balance 命令、桌面「查看余额」菜单）。
   *   标记随数据一起写进叶子：只有 host 知道是谁要的，前端据此决定余额不可用时要不要**必弹**
   *   文字说明（decideBalanceNotice 的 explicit；周期刷新则只在原因变化时弹一次，免得反复刷屏）。
   */
  /**
   * 账号服务要求的调用方身份（`AccountClientMetadata`）：Platform 用它派生五个客户端头，
   * 只影响**请求来源标识**与**服务端本地化文案**，不参与余额数值与币种。
   *
   * - version：本插件版本（读自身 package.json；读不到回落 '0.0.0'——该字段只是标识）
   * - locale：本插件是中文产品，固定 `zh-CN`（Platform 侧归一到 zh_CN）
   * - timezoneOffsetSeconds：本机 UTC 偏移（东八区为 +28800）
   */
  const accountClientMetadata = (): { version: string; locale: string; timezoneOffsetSeconds: number } => {
    let version = '0.0.0';
    try {
      const raw = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
      if (typeof raw.version === 'string' && raw.version.length > 0) version = raw.version;
    } catch {
      // 读不到不影响查询：version 只是平台侧的来源标识
    }
    return { version, locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 };
  };

  const refreshBalance = async (manual = false): Promise<void> => {
    const mark = <T>(v: T): T | (T & { manual: true }) => (manual ? { ...v, manual: true } : v);
    try {
      const sel = ctx.agentDefaultModel.currentSelection();
      const result = await queryBalance(
        sel.provider,
        async (ref) => {
          const rc = await ctx.credentials.resolve(credentialRef(ref));
          return rc?.value;
        },
        // `deepseek-account`（免费额度 / 平台登录）没有 API Key：它的凭证是 DSH 账号服务
        // 持有的授权记录，只能经 getBalance 查询。账号服务是**可选**服务（软取，不放进
        // inject）——没装账号插件时它不在场，此时该路由报 credential-missing 而不是崩。
        async () => {
          const account = ctx.get('deepseekAccount', false);
          if (!account) return undefined;
          return account.getBalance(accountClientMetadata());
        },
      );
      state.writeSection('balance', mark(result));
    } catch (e) {
      state.writeSection(
        'balance',
        mark({
          ok: false,
          provider: 'unknown',
          reason: 'fetch-error',
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  /** 当前交互桌宠 id：/pet 已选且仍存在 → 该宠物；未选/已失效 → 有效宠物列表第一只（进程内，重启回默认） */
  const resolveActivePetId = (): string => {
    try {
      const eff = effectivePetList();
      if (eff.length === 0) return '';
      if (activePetId && eff.some((p) => String(p.id) === activePetId)) return activePetId;
      return String(eff[0].id);
    } catch {
      return activePetId;
    }
  };

  /** 宠物的显示名（name，缺失回落 id）——命令文案用 */
  const petDisplayName = (pet: Record<string, unknown>): string => {
    const n = String(pet.name ?? '').trim();
    return n || String(pet.id ?? '');
  };

  let hasDesktopPet = false;
  /**
   * 桌面模式是否**曾经**成功启动过（粘性，仅本插件生命周期内有效）。
   * 把「没有桌面宠物就不启动」放宽成「从来没有过桌面宠物才不启动」：桌面宠物被全部改成
   * web/none 之后，Helper 仍会带着空宠物列表重启并常驻——因为托盘（桌面端显示开关）是此时
   * 唯一还能把宠物切回桌面的入口，Helper 一退它就没了。
   * 纯浏览器用户（从未有过桌面宠物）不受影响：照旧不探测、不下载、不拉起 Electron。
   */
  let desktopModeEverActive = false;
  const refreshDesktop = (): void => {
    hasDesktopPet = false;
    try {
      hasDesktopPet = effectivePetList().some((p) => isDesktopVisible(p.display));
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-pet] 宠物配置非法，桌面模式已跳过：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  refreshDesktop();

  /** 桌面可见宠物列表（[{id,size}]）：透传 Helper 决定创建几个局部窗口（每宠物一个）。 */
  const desktopPetList = (): Array<{ id: string; size: number }> => {
    try {
      return effectivePetList()
        .filter((p) => isDesktopVisible(p.display))
        .map((p) => ({ id: String(p.id), size: Number(p.size) }));
    } catch {
      return [];
    }
  };

  let helper: HelperProcess | undefined;
  let startRetryTimer: NodeJS.Timeout | undefined;
  let electronEnsure: Promise<void> | undefined;
  let disposed = false;
  /** 「无图形环境」提示只在进程生命周期内打一次，避免守护循环刷屏 */
  let displayWarned = false;

  /** 用已确认存在的 Electron 路径拉起桌面 Helper（每只桌面宠物一个局部小窗口）。 */
  const launchHelper = (electronPath: string | undefined): void => {
    if (helper || disposed) return;
    if (!hasDesktopPet && !desktopModeEverActive) return; // 无桌面宠物且桌面模式从未启用过：不启动
    const port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;
    if (!port || port <= 0) {
      // webServer 可能尚未完成监听（OS 分配端口时 port 短暂为 0）：延迟重试。
      if (!startRetryTimer) {
        startRetryTimer = setTimeout(() => {
          startRetryTimer = undefined;
          launchHelper(electronPath);
        }, 500);
        startRetryTimer.unref?.();
      }
      return;
    }
    const origin = `http://127.0.0.1:${port}`;
    // 右键「打开网站」交出去的是裸 origin：DSH 只在 `GET /` 接受本进程的启动令牌，换发绑定 authority 的
    // 签名 Cookie，其余请求一律 401 —— 默认浏览器没有该 authority 的 Cookie 时必然打不开（#87）。
    // 令牌等价登录态：只经子进程环境变量递到 helper 内存，不落盘、不进日志；authority 必须保持
    // 127.0.0.1（与 localhost 算两套 Cookie），故这里传 origin 而不是另拼地址。
    const siteUrl = ctx.connection.authenticatedUrl(origin);
    // 桌面渲染端也从同一份 handlePetRoute 拿成品配置（每只宠物一个局部小窗口；经管道，不走 HTTP——
    // DSH Desktop 2.0.3+ 会拦插件自拉进程的裸 HTTP 请求，浏览器访问闸门只放行带令牌的请求）
    const configUrl = `${origin}${ROUTE_PREFIX}/config`;
    helper = new HelperProcess(
      {
        electronPath,
        env: {
          DSH_PET_CONFIG_URL: configUrl,
          // 已鉴权站点 URL（含本进程启动令牌）：只供 helper 的「打开网站」使用，任何日志都不许出现它
          DSH_PET_SITE_URL: siteUrl,
          // 宿主形态决定工具项「打开网站」的去向（同名菜单项，两端两种语义）：
          //   desktop = 宿主是 DSH 桌面应用 → 唤起桌面应用主窗口（helper 走 dsh://open，见 main.js）
          //   site    = dsh web / 独立模式 → 系统默认浏览器打开站点（原行为，别破坏）
          DSH_PET_OPEN_TARGET: isDesktopHost() ? 'desktop' : 'site',
          DSH_PET_SCALE: '1',
          // 打开 bridge 协议：main.js 注册 dsh-pet-bridge scheme，把渲染端请求经管道转给宿主
          DSH_PET_BRIDGE: '1',
          // 每只桌面宠物一个局部小窗口：透传宠物列表（[{id,size}]）
          DSH_PET_PETS: JSON.stringify(desktopPetList()),
          // 独立版才有的托盘两项（「设置」/「退出」）。地址带令牌，**只经环境变量进壳内存**：
          // 不落盘、不进日志、不走 HTTP（与 DSH_PET_SITE_URL 同一条纪律）。
          // 插件模式下这两个 key 根本不存在，壳里对应的菜单项也就不出现。
          ...(ctx.standalonePetTray
            ? {
                // 设置合成一页后，托盘只认这一个地址（壳里也只留一个「设置…」）。
                // AI_SETTINGS 仍传但指向同一页：老版本壳读它也不会打开一份"第二份配置"。
                DSH_PET_TRAY_SETTINGS: String((ctx.standalonePetTray as { settingsUrl: () => string }).settingsUrl()),
                DSH_PET_TRAY_AI_SETTINGS: String((ctx.standalonePetTray as { settingsUrl: () => string }).settingsUrl()),
                // 热键从哪读：ear.js 原来写死读插件目录的 companion.json，独立版没有那个文件
                // （等于永远用默认 Alt+T/Alt+G，设置页改了也没处生效）。改指向我们自己的
                // hotkeys.json，由宿主在起壳前按配置写好；ear 每 5 秒重读一次，改了不用重启。
                DSH_PET_EAR_CONFIG: join(userRoot, 'hotkeys.json'),
                // 令牌：壳里所有写操作的 POST（点菜单/换显示位/退出）都要带 x-dsh-pet-token，
                // 否则被门禁挡成 403——热键「按了没反应」就是这个（键收到了，POST 被吞）。
                // 只进内存：不落盘、不进日志、不回显到任何页面。
                ...(typeof (ctx.standalonePetTray as { token?: () => string }).token === 'function'
                  ? { DSH_PET_API_TOKEN: String((ctx.standalonePetTray as { token: () => string }).token()) }
                  : {}),
              }
            : {}),
        },
        // bridge 协议处理器 = HTTP 路由同一份 handlePetRoute（业务逻辑唯一，两端天然一致）；
        // 素材过文件路径（main.js 自行读盘），json/text 过 body
        bridgeHandler: async (req) => {
          const result = await handlePetRoute(req.url ?? '/', req.method ?? 'GET', req.body);
          if (result.kind === 'file') {
            // file 分支恒 200（404/400 已由 text 分支表达）
            return { id: req.id, status: 200, contentType: result.contentType, file: result.file };
          }
          if (result.kind === 'text') {
            return { id: req.id, status: result.status, contentType: 'text/plain; charset=utf-8', body: result.body };
          }
          if (result.kind === 'none') {
            // 无需应答：管道侧不传 abort signal，正常到不了这里；保底给个空 204
            return { id: req.id, status: 204, contentType: 'text/plain; charset=utf-8', body: '' };
          }
          return {
            id: req.id,
            status: result.status,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify(result.obj),
          };
        },
      },
      ctx.logger ?? console,
    );
    try {
      helper.start();
      desktopModeEverActive = true; // 此后即使桌面宠物清零也保留 Helper：托盘常驻，可随时切回来
      ctx.logger?.info?.(`dsh-pet desktop helper started (config: ${configUrl})`);
    } catch (e) {
      ctx.logger?.warn?.(`dsh-pet desktop helper start failed: ${e instanceof Error ? e.message : String(e)}`);
      helper = undefined;
    }
  };

  /** 拉起桌面 Helper：先探测本机 Electron；缺失时进程内异步下载
   *  （不 spawn 子进程，CLI node 与 DSH Desktop 均适用），下载完成后自动拉起。 */
  const startHelper = (): void => {
    if (helper || electronEnsure || disposed) return;
    if (!hasDesktopPet && !desktopModeEverActive) return; // 无桌面宠物且桌面模式从未启用过：不启动
    // 无图形显示环境（Linux 服务器 / 容器）：直接放弃，不探测、不下载、不拉起。
    // 否则 Electron 会「拉起即崩」，被守护循环反复重启并刷满 core dump。
    if (!hasGraphicalDisplay()) {
      if (!displayWarned) {
        displayWarned = true;
        ctx.logger?.warn?.(
          '[dsh-pet] 未检测到图形显示环境（DISPLAY/WAYLAND_DISPLAY 均为空），已跳过桌面宠物。' +
            '浏览器内宠物不受影响；如需在服务器上启用桌面模式，请配置 Xvfb 后设置 DSH_PET_DESKTOP_FORCE=1。',
        );
      }
      return;
    }
    const found = resolveElectronPath();
    if (found) {
      launchHelper(found);
      return;
    }
    console.warn(`[dsh-pet] Electron not found, downloading to ${defaultElectronExe()} ...`);
    electronEnsure = ensureElectronDownload()
      .then((path) => {
        if (path) {
          launchHelper(path);
        } else {
          console.warn(
            '[dsh-pet] Electron download failed; desktop pet unavailable. Set DSH_PET_ELECTRON_PATH and restart, or retry later.',
          );
        }
      })
      .finally(() => {
        electronEnsure = undefined;
      });
  };

  /** 停止桌面 Helper（保留配置，可再次拉起）。宿主退出/插件卸载路径：不等它退干净（见 stopAndWait）。 */
  const stopHelper = (reason = 'settings-change'): void => {
    if (startRetryTimer) {
      clearTimeout(startRetryTimer);
      startRetryTimer = undefined;
    }
    helper?.stop(reason);
    helper = undefined;
  };

  /** 停止并**等旧 helper 真正退出**：配置变更触发的"停旧起新"专用（issue #64）。 */
  const stopHelperAndWait = async (reason: string): Promise<void> => {
    if (startRetryTimer) {
      clearTimeout(startRetryTimer);
      startRetryTimer = undefined;
    }
    const old = helper;
    helper = undefined;
    await old?.stopAndWait(reason);
  };

  /**
   * 宠物配置（display / size 等）变更后：重解析桌面宠物，**等旧 helper 退出**再拉起新的。
   *
   * 为什么要等（issue #64）：Electron 收到 SIGTERM 后关窗是异步的（几百 ms 起），"发完 kill 就 spawn
   * 新进程"会让旧窗口（旧大小）与新窗口（新大小）短暂共存——用户看到的就是"改完大小冒出来第二只宠物"。
   * 为什么要串行：连续保存会触发多次重启，两次重启交错同样会同时拉起两个 helper，所以用队列串起来。
   * 队列自身绝不留下 rejected 状态，否则后续保存再也不会重启 helper。
   */
  let desktopSyncQueue: Promise<void> = Promise.resolve();
  const syncDesktop = (): Promise<void> => {
    desktopSyncQueue = desktopSyncQueue
      .then(async () => {
        refreshDesktop();
        await stopHelperAndWait('desktop-config-change');
        startHelper();
      })
      .catch((e: unknown) => {
        ctx.logger?.warn?.(`[dsh-pet] 重启桌面 Helper 失败：${e instanceof Error ? e.message : String(e)}`);
      });
    return desktopSyncQueue;
  };

  /** 扩展名 → 素材子目录名（webm → webm/，mov → mov/；其余落在动画目录平级放行） */
  const animSubdirFor = (ext: string): string => (ext === '.mov' ? 'mov' : 'webm');

  /** 包内动画素材根：按扩展名取子目录（webm/ 随包发布；mov/ 不存在时为 404 兜底，仅 macOS 自维护）。 */
  const assetRootFor = (ext: string): string => join(PACKAGE_ROOT, 'assets', animSubdirFor(ext));

  /** 用户动画根：按扩展名取子目录（main-animation/webm 或 main-animation/mov）。 */
  const userRootFor = (ext: string): string => join(thumbUserRoot, animSubdirFor(ext));

  /** 单次业务路由(WebServer 注册 → HTTP 落盘 / 桌面 Helper 管道 → scheme 应答,共用同一份实现):
   *  输入只需 rawUrl(/dsh-pet-7340/... + 查询) + method + body 文本;返回 RouteResult(JSON/文本/文件),
   *  消费方各自落盘——业务逻辑只有一份,两端天然一致(硬契约:浏览器/桌面行为严格对齐)。
   *  signal（可选）：调用方断开时**中止挂起等待**（只有 /playback 的 wait 分支会用到）。
   *  管道侧不传——桌面渲染端不查 /playback；HTTP 侧由注册处按 res 的 close 触发。 */
  const handlePetRoute = async (
    rawUrl: string,
    method: string,
    body?: string,
    signal?: AbortSignal,
  ): Promise<RouteResult> => {
    const url = new URL(rawUrl, 'http://localhost');
    // 【汐儿 · 11-17 第 5 批】对外门面 `/v1/*`：第一版只做别名，内部路由一条不动。
    // `/v1` 不在免令牌名单里，所以外部调用天然要带 x-dsh-pet-token。
    const rawPath = url.pathname;
    const viaV1 = rawPath.startsWith('/v1/');
    // 只 decode 一次（双重编码不许被二次解码，见 thumb 路由的不变式）
    const mappedPath = viaV1 ? `${ROUTE_PREFIX}/${rawPath.slice('/v1/'.length)}` : rawPath;
    const rest = decodeURIComponent(mappedPath.slice(ROUTE_PREFIX.length + 1));
    if (viaV1) {
      const v1 = await handleV1Rest(rest, method, body);
      if (v1 !== undefined) return v1;
      noteSense(`v1 alias rest=${rest} method=${method}`);
    }

    // /windows：列出能选的窗口（设置页「窗口」模式的下拉用，哥哥 11-16 m21257）
    if (rest === 'windows') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const list = await listWindows(4_000);
      const picked = list
        .filter((entry) => entry.rect.w >= 240 && entry.rect.h >= 180 && entry.title.trim() !== '')
        .slice(0, 60)
        .map((entry) => ({
          hwnd: entry.hwnd,
          title: entry.title.slice(0, 120),
          exe: entry.exe,
          rect: entry.rect,
        }));
      return { kind: 'json', status: 200, obj: { ok: true, windows: picked }, headers: { 'cache-control': 'no-cache, no-store' } };
    }

    // 成品配置：/dsh-pet-7340/config（GET 读取合并成品 / PUT 保存用户层 / POST 同步内置默认）
    // /watch-stats：最近 N 张图的分数 / 识图耗时 / 有没有说话（设置页的反馈面板用，哥哥 11-10 m18312）
    if (rest === 'watch-stats') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const now = new Date();
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const file = join(layout.watchNotes, `${day}.jsonl`);
      try {
        // 只读尾部 20 行：陪伴开一整天，当天的 jsonl 可以很长，没必要整份进内存。
        const lines = await readTailLines(file, 20);
        const rows = lines.map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        }).filter((row): row is Record<string, unknown> => row !== null);
        // 【汐儿 · 11-16 m21257】日志是「旧在前」追加写的，页面要「新的在上」→ 反过来
        rows.reverse();
        return {
          kind: 'json',
          status: 200,
          obj: { ok: true, day, file, entries: rows },
          headers: { 'cache-control': 'no-cache, no-store' },
        };
      } catch {
        return { kind: 'json', status: 200, obj: { ok: true, day, entries: [] }, headers: { 'cache-control': 'no-cache, no-store' } };
      }
    }
    if (rest === 'config') {
      if (method === 'GET') {
        // 唯一配置入口：readAllConfig 返回绝对正确的完成品聚合（{ main:{...}, test1:{...} }），
        // 浏览器/桌面/设置页直接消费，无需任何校验/兜底
        try {
          // 动态配置必须杀缓存（与 /state 同口径）：消费端会「发现配置版本变化 → 重拉 /config」，
          // 这一次 GET 若命中缓存就会拿回旧配置，那套机制直接失效。
          return {
            kind: 'json',
            status: 200,
            obj: readAllConfig(configPaths),
            headers: { 'cache-control': 'no-cache, no-store' },
          };
        } catch (e) {
          return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
        }
      }
      if (method === 'PUT') {
        try {
          const parsed = JSON.parse(body ?? '');
          // 透传保留：读当前磁盘上的用户文件原对象，把非白名单顶层字段（physics/whisperPrompt/
          // chatMemoryRounds/...）带回给 saveUserConfig——设置页保存不再抹掉用户手改的精调配置。
          // **必须走 JSONC 容忍解析器**（readUserConfig）：用户层可能是「同步」写入的带 // 注释
          // 的 config.jsonc 原文，用严格 JSON.parse 会在这里抛错并被吞掉 → existing 变 undefined
          // → 白名单重建 → 用户的高级字段全丢（老 bug 的复发路径，已由守卫测试钉住）。
          const existing = readUserConfig(configPaths);
          const clean = saveUserConfig(parsed, existing);
          if (!clean) {
            return {
              kind: 'json',
              status: 400,
              obj: {
                error:
                  'invalid pet config: expected { pets:[{name?,id,size,balanceEnabled,display,position:{corner,marginX,marginY}}] }（display 为 web/desktop/both/none 之一；可选顶层 notificationsEnabled / whisperImageEnabled / chatImageEnabled 布尔；可选宠物布尔 whisperEnabled / workStatusEnabled / fixedEnabled）',
              },
            };
          }
          // 损坏预检：用户层存在但连 JSONC 都解析不了（真损坏）→ **先不写盘**。
          // 保存是白名单重建，existing 读不出来就等于把文件里剩下的内容整份丢掉，而且静默——
          // 所以回 409 让设置页弹窗（取消 = 不动文件；确认 = 带 ?force=1 强行重建）。
          if (url.searchParams.get('force') !== '1' && userConfigUnparsable(configPaths)) {
            return {
              kind: 'json',
              status: 409,
              obj: { error: 'user config is unparsable', needConfirm: true, userFile: userConfigPath },
            };
          }
          await mkdir(userRoot, { recursive: true });
          await writeFile(userConfigPath, JSON.stringify(clean, null, 2), 'utf8');
          void syncDesktop(); // display/size 等可能变化：重解析桌面宠物并重启 Helper（异步，不阻塞保存响应）
          // 响应体 = 保存后的**成品聚合**（与 GET /config 同一份，字段已填满）：
          // 设置页把它直接交给容器的 flattenConfigPets 拍平渲染——客户端的条目级字段
          // （动画池/权重/物理参数/工作状态文案）只有这一处填充，不再有第二份补吹实现。
          return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
        } catch {
          return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
        }
      }
      if (method === 'POST') {
        // 同步：把内置默认配置（assets/config.jsonc 原文，含注释）整份写入用户配置——
        // 既是「恢复默认」（合并结果 = 内置默认），又给用户留下一份可直接编辑的完整配置，
        // 不必再自己从包内复制一份（见 config.ts 的 syncUserConfigFromDefault）。
        try {
          syncUserConfigFromDefault(configPaths);
        } catch (e) {
          // 默认文件缺失 / 用户目录不可写：显式 500，绝不静默留下半个配置文件
          return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
        }
        void syncDesktop(); // 配置变了：重解析桌面宠物并重启 Helper（异步，不阻塞响应）
        return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
      }
      return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    }

    // 【本鱼改造 · 模型网关】设置页的三张卡：状态（读）与「测一下」（试）。
    // 为什么不塞进 /config：/config 是"整份配置"，这里是"能不能用 + 试一下"，
    // 后者要真发一次请求，绝不能混进一个会被高频轮询的 GET 里。
    if (rest === 'model') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const petId = String(url.searchParams.get('pet') ?? 'main');
      const found = findPetInstance(readAllConfig(configPaths), petId);
      // 状态卡要报"实际能不能用"：补全后的配置才算数（11-20）
      const config = fillCloudBackend(parseModelConfig(found?.conf.model));
      const gateway = createModelGateway({ readConfig: () => config, session: sessionChat , extraHeaders: backendHeaders });
      return {
        kind: 'json',
        status: 200,
        obj: { pet: petId, config: toConfigSection(config), status: gateway.status() },
        headers: { 'cache-control': 'no-cache, no-store' },
      };
    }

    // ===================== 双模式连接：DSH 后开也能接上独立桌宠 =====================
    // 哥哥 m00722 第 3 条：桌宠独立跑着，再开 DSH，用「检测连接」把会话接上。
    // 这里只**读文件 + 探一次**，绝不因此起/杀进程（谁拥有壳谁跑 core，见接口设计 §4）。
    if (rest === 'connection') {
      if (rest === 'connection' && method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const file = join(userRoot, 'standalone-runtime.json');
      let info: ReturnType<typeof parseStandaloneRuntime> = null;
      try {
        info = parseStandaloneRuntime(JSON.parse(readFileSync(file, 'utf8')) as unknown);
      } catch {
        // 没文件 / 半截 JSON 都当"没在跑"：这条路由只用来显示状态，不该报错
        info = null;
      }
      const probe = info ? await probeStandalone(info) : { ok: false, message: '桌宠没在独立运行（没找到运行时文件）' };
      return {
        kind: 'json',
        status: 200,
        // 不外泄 token：设置页只需要知道"在不在、端口多少、通不通"
        obj: {
          ok: probe.ok,
          message: probe.message,
          found: info !== null,
          ...(info ? { port: info.port, pid: info.pid, settingsUrl: info.settingsUrl } : {}),
        },
        headers: { 'cache-control': 'no-cache, no-store' },
      };
    }

    // ===================== 对外服务：气泡 / 嘴 / 眼 =====================
    // 哥哥 m00766 定的三条：DSH（或别家程序）要能「让桌宠冒一句话」「让她念出声」「借她的眼睛看图」。
    // 同一份实现住在 core/create-pet-services：进程内走 ctx.get('petApi7340').services，
    // 跨进程走这里 —— 两条入口一份语义，连失败原因都是同一句中文（不各写一套）。
    // 【汐儿 · 11-20 0.6 第 1 步】听.py 问：「这一句要不要走常驻的耳朵？」
    // 常驻 = 用户自己开的（ear.resident）或者陪伴正开着（跟陪伴同开同关，哥哥 m31061）。
    if (rest === 'services/asr') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const petId = String(url.searchParams.get('pet') ?? 'main');
      // 读不到配置（源码形态 / 安装损坏）就当「没开」，别把听.py 卡在 500 上：
      // 这条路由是内部小问询，退化成老路（每句重起）也不会出错。
      let manual = false;
      try {
        const found = findPetInstance(readAllConfig(configPaths), petId);
        const earConf = found ? ((found.conf as Record<string, unknown>).ear as Record<string, unknown> | undefined) : undefined;
        manual = earConf?.resident === true;
      } catch {
        manual = false;
      }
      const watch = watchRunning();
      return {
        kind: 'json',
        status: 200,
        obj: { ok: true, resident: manual || watch, manual, watch },
        headers: { 'cache-control': 'no-cache, no-store' },
      };
    }

    if (rest === 'services/snapshot' || rest === 'services/bubble' || rest === 'services/voice' || rest === 'services/eyes') {
      const petId = String(url.searchParams.get('pet') ?? 'main');
      const found = findPetInstance(readAllConfig(configPaths), petId);
      if (!found) return { kind: 'json', status: 404, obj: { error: `unknown pet: ${petId}` } };
      const conf = found.conf as Record<string, unknown>;
      // 每次请求按当前配置造网关：设置页改完立刻生效，不用重启
      // 11-20：留空跟随 AI 设置 → 这里也要补，否则「试一下」说没配好、主聊天却好好的
      const modelConfig = fillCloudBackend(parseModelConfig(conf.model));
      const services = createPetServices({
        core,
        gateway: createModelGateway({ readConfig: () => modelConfig, session: sessionChat , extraHeaders: backendHeaders }),
        ttsKind: () => (modelConfig.tts.backend.kind === 'local' ? 'local' : 'remote'),
      });

      if (rest === 'services/snapshot') {
        if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        return {
          kind: 'json',
          status: 200,
          obj: { ok: true, state: services.snapshot() },
          headers: { 'cache-control': 'no-cache, no-store' },
        };
      }
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body ?? '') as Record<string, unknown>;
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const failed = (error: unknown): RouteResult => {
        const code = error instanceof ServiceError ? error.code : 'failed';
        const message = error instanceof Error ? error.message : String(error);
        const status = code === 'bad-request' ? 400 : code === 'busy' ? 409 : code === 'not-configured' ? 400 : 500;
        return { kind: 'json', status, obj: { ok: false, reason: code, error: message } };
      };

      if (rest === 'services/bubble') {
        try {
          // 【11-18 待办第 10 条】原来直调 services.bubble.say，绕开了「主气泡只有嘴能写」，
          // 在听的时候也能抢。现在统一走 writeSayBubble（受「在听」闸），叶子还是同一片。
          const said = typeof parsed.text === 'string' ? parsed.text : '';
          writeSayBubble(petId, 'chat', {
            text: said,
            ...(typeof parsed.image === 'string' ? { image: parsed.image } : {}),
            ...(parsed.duration === undefined ? {} : { duration: Number(parsed.duration) }),
            ...(parsed.sticky === true ? { sticky: true } : {}),
            ...(typeof parsed.anim === 'string' ? { anim: parsed.anim } : {}),
          });
          return { kind: 'json', status: 200, obj: { ok: true, id: `say-${Date.now()}` } };
        } catch (error) {
          return failed(error);
        }
      }

      if (rest === 'services/voice') {
        try {
          const result = await services.voice.speak({
            text: typeof parsed.text === 'string' ? parsed.text : '',
            voice: typeof parsed.voice === 'string' ? parsed.voice : undefined,
          });
          // 路由只回文件路径（音频不过管道，与素材同一约定）；落在用户目录下的 voice 缓存里
          const dir = join(userRoot, 'voice');
          mkdirSync(dir, { recursive: true });
          // 扩展名跟真实格式走：GPT-SoVITS 回 wav，写 .mp3 会让播放器按错格式解
          const ext = result.mime === 'audio/wav' ? '.wav' : '.mp3';
          const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
          writeFileSync(file, result.audio);
          return { kind: 'file', file, contentType: result.mime };
        } catch (error) {
          return failed(error);
        }
      }

      // services/eyes
      try {
        const result = await services.eyes.look({
          image: typeof parsed.image === 'string' ? parsed.image : new Uint8Array(),
          prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
        });
        return { kind: 'json', status: 200, obj: { ok: true, text: result.text, backend: result.backend } };
      } catch (error) {
        return failed(error);
      }
    }

    // ===================== 桥插件专用口径（0.3.9 起，给 dsh-pet-bridge 用） =====================
    // /look：借眼睛看一张**本地图片路径**（DSH 把会话里的图按附件仓库路径喂过来），
    //        与 services/eyes 同一份实现，只是入参从"字节/路径"统一成本地路径 + 文件名提示。
    if (rest === 'look') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsedLook: Record<string, unknown>;
      try {
        parsedLook = JSON.parse(body ?? '') as Record<string, unknown>;
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const petId = String(url.searchParams.get('pet') ?? 'main');
      const found = findPetInstance(readAllConfig(configPaths), petId);
      if (!found) return { kind: 'json', status: 404, obj: { error: `unknown pet: ${petId}` } };
      // servicesProvider 里已经做了 fillCloudBackend（云端留空 → 沿用 AI 设置那一份）
      const services = servicesProvider(petId);
      // 【11-18】手动看一眼 = 4 级：先把正在跑的屏幕想掐掉，免得一会儿两句一起冒
      noteCommand('hotkey', '看一眼');
      const file = typeof parsedLook.file === 'string' ? parsedLook.file.trim() : '';
      if (!file) return { kind: 'json', status: 400, obj: { ok: false, error: 'file 必填（本地图片的绝对路径）' } };
      if (!existsSync(file)) return { kind: 'json', status: 404, obj: { ok: false, error: `图片不存在：${file}` } };
      try {
        // 哥哥 11-01：识图要几秒，先冒状态；失败要说是哪里坏了（别静默）。
        // 【汐儿 · 11-15】看一眼不打断语音，这里不再 centerInterrupt。
        await statusBubble('本鱼正在偷看这张图…', 30_000);
        const result = await services.eyes.look({
          image: file,
          prompt:
            typeof parsedLook.prompt === 'string'
              ? parsedLook.prompt
              : typeof parsedLook.name === 'string' && parsedLook.name
                ? `这是一张图片（${parsedLook.name}）。${LOOK_DETAIL_PROMPT}`
                : LOOK_DETAIL_PROMPT,
        });
        return { kind: 'json', status: 200, obj: { ok: true, text: result.text, backend: result.backend } };
      } catch (error) {
        const code = error instanceof ServiceError ? error.code : 'failed';
        const message = error instanceof Error ? error.message : String(error);
        await statusBubble(`识图失败：${message}（请检查识图接口）`, 18_000);
        const status = code === 'bad-request' ? 400 : code === 'not-configured' ? 400 : 500;
        return { kind: 'json', status, obj: { ok: false, reason: code, error: message } };
      }
    }

    // /stop-loud：立刻闭嘴（哥哥 11-01 要「新输入打断语音」——听.py 开始录音、新的看一眼都会调它）
    if (rest === 'stop-loud') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      centerInterrupt('manual');
      return { kind: 'json', status: 200, obj: { ok: true } };
    }

    // /say-loud：念一句（念完就回；气泡由调用方自己用 /broadcast 写，避免两套节奏打架）
    if (rest === 'say-loud') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsedSay: Record<string, unknown>;
      try {
        parsedSay = JSON.parse(body ?? '') as Record<string, unknown>;
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const text = typeof parsedSay.text === 'string' ? parsedSay.text.trim() : '';
      if (!text) return { kind: 'json', status: 400, obj: { ok: false, error: 'text 必填' } };
      // 只念「短句子」：超过 150 字就在句末标点处截断（哥哥 11-01："原版输出不要直接发给语音"）
      // 150 是给「两句、每句 ≤60」的口播摘要留的余量，120 会正好把第二句尾巴切掉。
      const clipped = clipForVoice(text, 150);
      const petId = String(url.searchParams.get('pet') ?? 'main');
      const found = findPetInstance(readAllConfig(configPaths), petId);
      if (!found) return { kind: 'json', status: 404, obj: { error: `unknown pet: ${petId}` } };
      touchUser();
      // 【11-18】第 4 级：桥/听.py 让他「说一句」，屏幕想先让路
      noteCommand('bridge', clipped.slice(0, 20));
      // 【汐儿 · 11-16 晚 m24524】这里**不再**按「在听/在想」让路。
      // 让路本意是挡「外面的声音」，可 听.py 的回话走的正是 /say-loud：
      // 它 emit reply 与这条请求几乎同刻，ear.js 的 idle 消息常晚一拍 →
      // 她的回话被自己刚设的状态挡掉，表现就是「说了但没声音」。
      // 真正插嘴的第三方走 /broadcast，那条继续在「正在录音」时让路。
      logSayLoud(`收到 ${text.length} 字 → 念 ${clipped.length} 字：${clipped.slice(0, 40)}`);
      // servicesProvider 里已经做了 fillCloudBackend（云端留空 → 沿用 AI 设置那一份）
      const services = servicesProvider(petId);
      // 合成期间（系统语音/SoVITS 要一两秒）如果哥哥已经按了听键/看了图，这句就别再冒出来了。
      const t0 = Date.now();
      try {
        const result = await services.voice.speak({
          text: clipped,
          voice: typeof parsedSay.voice === 'string' ? parsedSay.voice : undefined,
        });
        logSayLoud(`timing synth=${Date.now() - t0}ms chars=${clipped.length}`);
        const duration = Math.max(3000, audioDurationMs(result.audio) + VOICE_TAIL_MS);
        let bubbleShown = false;
        const showBubble = (): void => {
          if (bubbleShown) return;
          bubbleShown = true;
          logSayLoud(`timing first=${Date.now() - t0}ms`);
          void services.bubble.say({ petId, text: clipped, duration, source: 'dsh' }).catch(() => {
            /* 气泡失败不影响出声 */
          });
        };
        // 【汐儿 · 11-15】走仲裁：urgent = 先掐掉正在念的那句，再念这条（同一时刻只有一张嘴）。
        const outcome = await centerPlayClip({
          audio: result.audio,
          mime: result.mime,
          text: clipped,
          priority: 'urgent',
          petId,
          onStart: showBubble,
        });
        logSayLoud(`timing done=${Date.now() - t0}ms interrupted=${outcome.interrupted === true}`);
        if (outcome.interrupted === true) return { kind: 'json', status: 200, obj: { ok: true, skipped: true } };
        if (!bubbleShown) showBubble();
        // 说完挑一张表情包收尾；一秒之内被打断就别再冒。
        const myEpoch = epoch;
        const meme = pickMemeImage(petId);
        logSayLoud(`meme=${meme ?? 'NONE'}`);
        if (meme) {
          const memeName = meme.split(/[\\/]/).pop()?.replace(/\.[a-z0-9]+$/i, '') ?? '';
          if (memeName !== '') {
            setTimeout(() => {
              if (myEpoch !== epoch) return;
              writeSayNow(petId, { text: clipped, image: memeName, phase: 'image' });
              logSayLoud(`meme bubble: ${memeName}`);
            }, MEME_TAIL_DELAY_MS);
          }
        }
        return { kind: 'json', status: 200, obj: { ok: true, text: clipped } };
      } catch (error) {
        const code = error instanceof ServiceError ? error.code : 'failed';
        const message = error instanceof Error ? error.message : String(error);
        const status = code === 'bad-request' ? 400 : code === 'not-configured' ? 400 : 500;
        return { kind: 'json', status, obj: { ok: false, reason: code, error: message } };
      }
    }

    // /summarize：把一段话压成「最多两句、每句 ≤60 字」（桥插件在回合结束时调，
    // 气泡和朗读都吃这一份；压不出来就让调用方自己截断，不在这里硬凑）
    if (rest === 'summarize') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsedSum: Record<string, unknown>;
      try {
        parsedSum = JSON.parse(body ?? '') as Record<string, unknown>;
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const source = typeof parsedSum.text === 'string' ? parsedSum.text.trim() : '';
      if (!source) return { kind: 'json', status: 400, obj: { ok: false, error: 'text 必填' } };
      // 【本鱼 · 11-01】摘要调试：哥哥报「只总结前半段」，先把送进来的原文长度和首尾记下来，
      // 好分清是上游把文本截了、还是模型自己只看了开头。
      noteLog(
        'mind.log',
        'summarize',
        `chars=${source.length} head=${source.slice(0, 120).replace(/\s+/g, ' ')} | tail=${source.slice(-120).replace(/\s+/g, ' ')}`,
      );
      const maxChars = Math.min(120, Math.max(20, Number(parsedSum.maxChars) || 60));
      // 【汐儿 · 11-03】提速一：短文本不值得走一次模型往返（实测 0.6~2.8s），按句切一下就能用，
      // 也更忠于原文（模型面对一两句常会改写语气）。阈值取 maxChars*2：这正是摘要的目标长度。
      const directCut = splitSummary(source, maxChars);
      if (source.length <= maxChars * 2 && directCut.length > 0) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: true, sentences: directCut, text: directCut.join(''), source: 'short' },
        };
      }
      // 【汐儿 · 11-03】提速二：同一条回复会被重复摘（重连、重试、桥插件重放），10 分钟内直接复用。
      const cacheKey = `${maxChars}:${createHash('sha1').update(source).digest('hex')}`;
      const cached = summaryCacheRead(cacheKey);
      if (cached !== undefined) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: true, sentences: cached, text: cached.join(''), source: 'cache' },
        };
      }
      const petId = String(url.searchParams.get('pet') ?? 'main');
      const found = findPetInstance(readAllConfig(configPaths), petId);
      if (!found) return { kind: 'json', status: 404, obj: { error: `unknown pet: ${petId}` } };
      // 对话后端可能选了「会话」——摘要不能走会话（那会把 DSH 又叫一遍、无递归尽头），
      // 所以这里只认自己的远端/本地模型；云端地址与 key 照旧从 AI 设置补。
      // 11-20：地址、模型名、密钥交给同一个补全口（原来只补前两个，模型名空着就报
      // 「还没填模型名」）。chat 选了「会话」时它原样返回 —— 摘要不能走会话（会把 DSH 又叫一遍）。
      const summarizeConfig = fillRemoteBackends(parseModelConfig(found.conf.model), standaloneConn());
      // 【汐儿 · 11-03】哥哥说摘要「有点笨」：旧提示词还是书面语，模型会照抄
      // 「2807ms」「/say-loud」「src/host/...」这类念不出来也听不懂的东西，
      // 还常把最亮的数字丢掉（实测 381 字那条，「2807ms → 37ms」整段没被选上）。
      // 改成「说给耳朵听」的口径：先通读、第一句给最要紧的结论、第二句给最有用的
      // 对比数字或待办；明令禁掉路径/函数名/命令/网址/下划线/斜杠，数字念顺口。
      const system = [
        '你是「说给耳朵听」的转述器：把一段回复改成两句能直接念出来的家常话，不是说给人看的报告。',
        `长度：最多两句；每句不超过 ${maxChars} 字；两句合起来 ${maxChars}–${maxChars * 2 - 20} 字，别只留个零头。`,
        '先通读全文再动笔。多数回复的重头在中间或结尾（结论、前后对比的数字、风险、下一步），别照着开头抄。',
        '第一句说「最要紧的那件事」（修好了什么 / 结论是什么 / 有什么变化）；第二句补一个最有用的细节：前后对比的数字、要哥哥拿主意的事、下一步。',
        '口播忌讳：不要出现文件路径、函数名、命令、网址、下划线、斜杠、括号编号；变量名和布尔值换成中文说法。数字念得顺口（「从快三秒变成几十毫秒」比「2807ms 降成 37ms」好听）。',
        '语气自然，像妹妹跟哥哥说事：不要开头问候（气泡自己带语气），不要「已完成相关操作」「一切正常」这种空话，也不要编原文没有的数字。',
        '只输出这两句本身，不要引号、编号、解释。原文本来只有一两句就照原样说。',
      ].join('');
      try {
        const gateway = createModelGateway({ readConfig: () => summarizeConfig, session: null , extraHeaders: backendHeaders });
        const result = await generateChatViaGateway(gateway, system, [], source, [], 20_000);
        if (!result.ok) {
          return { kind: 'json', status: 200, obj: { ok: false, reason: result.reason, error: result.message ?? '摘要失败' } };
        }
        const sentences = splitSummary(result.text, maxChars);
        if (sentences.length === 0) {
          return { kind: 'json', status: 200, obj: { ok: false, reason: 'empty', error: '模型没吐出东西' } };
        }
        summaryCacheWrite(cacheKey, sentences);
        return { kind: 'json', status: 200, obj: { ok: true, sentences, text: sentences.join(''), source: 'model' } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: 'json', status: 500, obj: { ok: false, reason: 'failed', error: message } };
      }
    }

    // 热键「说一句」的直路：菜单项按哥哥要求删掉了（他说"看一眼就能顺带试说话"），
    // 但 Alt+S/Alt+C 还留着——走菜单点不到项会回 delivered:false，所以给热键一条直路。
    if (rest === 'say') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      touchUser();
      const said2 = await speakOnce();
      return { kind: 'json', status: said2.ok ? 200 : 500, obj: said2 };
    }

    // 托盘「退出」：独立版专用。桌面壳点这一项时经 bridge 打到这儿，真正把**整个桌宠**收掉
    // （不是只关掉桌面小窗——那正是以前"点了退出鱼还在"的来源）。
    // 插件模式（没有 ctx.standalonePetTray）如实回 unsupported：那边退出由 DSH 决定，不归我们管。
    if (rest === 'quit') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const tray = ctx.standalonePetTray as { quit?: () => void } | undefined;
      if (!tray?.quit) {
        return { kind: 'json', status: 200, obj: { ok: false, reason: 'unsupported', message: '只有独立版支持从这里退出' } };
      }
      // 先回响应再退出：反过来的话连接会被掐断，壳那边只会看到"请求失败"，
      // 明明退了却报错，哥哥会以为没退成功。
      setTimeout(() => tray.quit?.(), 50).unref?.();
      return { kind: 'json', status: 200, obj: { ok: true, stopping: true } };
    }

    // 单只宠物的显示位置（桌面端右键「关闭桌面显示」→ POST /pet-display）。
    // 高频操作，故只收 id + display 两个参数，不要求调用方回传整段 pets（那是 PUT /config 的形态：
    // 客户端做读-改-写既容易误伤同层其它宠物，也拿不准该写哪一层）。
    // 层归属由服务端反查：id 在合并后被 mergePet 保证**全局唯一**（重复实例会被跳过、不进聚合），
    // 所以 findPetInstance 的结果没有歧义；反过来让客户端传 entry 只会多出"参数与真实归属不符"的
    // 新失败面（还平白把 entry 暴露成拼文件路径的输入）。
    // 写入语义与 PUT /config 完全一致：saveUserConfig 白名单重建 + existing 透传——用户手改的
    // whisperPrompt / memes 等非白名单字段不许被抹掉（见 ./config 里那段老 bug 的注释）。
    if (rest === 'pet-display') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      // 失败一律 **HTTP 200 + `{ok:false, reason, message}`**（与其他动作端点同一口径）：
      // 缺 id / display 非法 / 宠物不存在 / 写盘失败全是**业务错误**，不是"资源未找到"或"请求非法"，
      // 用 400/404 会让调用方把业务结论当成传输层故障。200 不代表改动生效——必须看 body 的 ok。
      // 只有 405（方法错）与 400（JSON 坏了）仍是协议层错误码，全插件只有这两处不是 200。
      const fail = (reason: string, message: string): RouteResult => ({
        kind: 'json',
        status: 200,
        obj: { ok: false, reason, message },
      });
      let payload: { id?: unknown; display?: unknown };
      try {
        payload = JSON.parse(body ?? '') as { id?: unknown; display?: unknown };
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const petId = typeof payload.id === 'string' ? payload.id.trim() : '';
      const nextDisplay = String(payload.display ?? '');
      // id **必填**（与 9 条 `?pet=` 路由同一对词汇：没给 → pet-required；不存在 → unknown-pet）
      if (!petId) return fail('pet-required', 'pet 必填：要指定操作哪只桌宠');
      if (!PET_DISPLAY_SET.has(nextDisplay)) {
        return fail('bad-request', `display 必须是 web / desktop / both / none：${nextDisplay}`);
      }
      let merged: Record<string, Record<string, unknown>>;
      try {
        merged = readAllConfig(configPaths);
      } catch (e) {
        return fail('generate-error', e instanceof Error ? e.message : String(e));
      }
      // 命中不到有两种可能：id 根本不存在，或该实例在合并时**因 id 与其它条目重复被跳过**（于是不在
      // 聚合里）。两种都只能按"没有这只桌宠"报——绝不能凭 id 去猜它"应该"属于哪个文件。
      const hit = findPetInstance(merged, petId);
      if (!hit) return fail('unknown-pet', `没有这只桌宠：${petId}`);
      // 目标层：main → 用户主配置；其余 → 文件宠物自己的配置（.json 或 .jsonc，定位统一走 ./config）
      let layerPath: string;
      let layerDir: string;
      let existing: Record<string, unknown> | undefined;
      if (hit.entry === 'main') {
        layerPath = userConfigPath;
        layerDir = userRoot;
        existing = readUserConfig(configPaths);
      } else {
        const file = readPetConfigEntry(configPaths, hit.entry);
        if (!file) {
          return fail('generate-error', `宠物条目配置文件找不到：${hit.entry}`);
        }
        layerPath = file.path;
        layerDir = petConfigDir;
        existing = file.raw;
      }
      // 整段替换语义：saveUserConfig 重建的是整个 pets 数组，必须带上**该层全部**宠物，只把目标
      // 那只的 display 换掉（漏掉别的 = 把它们从配置里删掉）。
      const layerPets = Array.isArray(hit.conf.pets) ? (hit.conf.pets as Record<string, unknown>[]) : [];
      const pets = layerPets.map((p) => (String(p.id) === petId ? { ...p, display: nextDisplay } : p));
      const clean = saveUserConfig({ pets }, existing);
      if (!clean) return fail('bad-request', '宠物配置非法');
      try {
        await mkdir(layerDir, { recursive: true });
        await writeFile(layerPath, JSON.stringify(clean, null, 2), 'utf8');
      } catch (e) {
        return fail('generate-error', e instanceof Error ? e.message : String(e));
      }
      // 配置变更信号（**只在写盘成功之后**：失败时不该动版本号，否则浏览器白重拉一次 /config）。
      // 这是全插件**唯一**写 sections.config 的地方：保存 / 同步配置的调用方自己就拿到了成品聚合
      // （响应体），桌面端由下面的 syncDesktop() 重启，都不需要这个信号；
      // 而桌面端右键改 display 时浏览器页面**不是发起方**，只能靠它发现「配置被别处改过」。
      state.writeSection('config', {});
      // 占用锁：改成 `none`（桌面端右键「关闭桌面显示」）＝ 用户主动隐藏/关闭，属于**抢占**——
      // 撤销本轮占用（cause: preempted）。不做的话宠物会被锁到 TTL 到点，而用户明明已经把它藏了
      // （issue #122：「用户主动停止、隐藏或关闭时，也应能取消联动，避免宠物被永久锁住」）。
      // 只认 `none`：web/desktop/both 是换显示位置，不是"用户接管"。
      if (nextDisplay === 'none') lock.release({ petId, force: true });
      // 不 await：发起者很可能就是**即将被这次重载换掉的**桌面 Helper（与 /reload 同一处境）。
      // 写盘已经落定，重启结果不需要回给调用方。
      void syncDesktop();
      // 响应体 = 改动后的**成品聚合**（与 PUT / POST /config 同形）：调用方（浏览器端右键菜单）
      // 直接把它交给 petBridge.reload，不必再发一次 GET /config —— 与设置页保存走的是同一条路，
      // 也就不会拿到可能陈旧的配置（现场表现：不返回聚合时浏览器端要刷新才生效）。
      return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
    }

    // 桌面端「重载配置」（右键菜单 → POST /reload）：重启桌面 Helper，全部桌面宠物窗口按最新配置重建。
    // 与保存走**同一条**重启路径（syncDesktop：串行队列 + 等旧进程真正退出再起新的），
    // 所以宠物数量 / display / size 的变化同样生效——渲染端就地重拉配置做不到这几项
    // （每只宠物一个窗口，是宿主启动时按 DSH_PET_PETS 建的）。
    // 注意：发起者就是**即将被重启的那个 helper**，本响应不保证送达，因此不 await 重启、立刻回 200。
    if (rest === 'reload') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      // 热键先落盘再重开小窗：设置页刚改的那几个键要赶在壳启动前写进 hotkeys.json
      writeHotkeysFile();
      void syncDesktop();
      return { kind: 'json', status: 200, obj: { reloading: true } };
    }

    // 配置文件路径 + 存储位置清单（设置页「高级配置」与「卸载与存储」展示用）
    if (rest === 'config/meta') {
      return {
        kind: 'json',
        status: 200,
        obj: {
          user: userConfigPath,
          default: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
          animations: thumbUserRoot,
          memes: memesUserRoot,
          // 全部落盘位置（本包用户数据 / Electron 运行时 / 桌面端缓存 / 下载缓存 / 插件本体）：
          // 前两条直接传真实写入方的路径，不在这里重拼目录名
          storage: storageEntries({
            userDataRoot: userRoot,
            electronDir: electronLandingDir(),
            home: homedir(),
            packageRoot: PACKAGE_ROOT,
          }),
          // profile 名（拼卸载命令 dsh plugin --profile <名> remove dsh-pet；反推不出时为空串）
          profile: profileNameFrom(PACKAGE_ROOT) ?? '',
        },
      };
    }

    // 第三方右键菜单（供别的插件注册自己的菜单项）。四个方法：
    //   POST   /menu/item    注册（该 owner 的菜单项**整体覆盖**）
    //   DELETE /menu/item    清除该 owner 的全部菜单项（幂等）
    //   GET    /menu/events  查询触发（读取即消费；?wait= 长轮询）
    //   POST   /menu/click   渲染端点击上报（内部通道，第三方不调）
    // 业务失败一律 200 + { ok:false, reason, message }（与 /anim、/lock 等同口径）；
    // 400 只留给「JSON 坏了」，405 只留给方法错。
    // 注册表在进程内存（./menu），快照写进 S 的 sections.menu：两端右键菜单据此拼「更多」，
    // 因此注册后**不用重启桌面 Helper**，下一拍 /state 就到了（长轮询下几乎是立即）。
    if (rest === 'menu/item') {
      if (method === 'DELETE') {
        const result = menuRegistry.clear(url.searchParams.get('owner') ?? '');
        if (!result.ok) {
          return { kind: 'json', status: 200, obj: { ok: false, reason: result.reason, message: result.message } };
        }
        state.writeSection('menu', { items: menuRegistry.snapshot() });
        return { kind: 'json', status: 200, obj: { ok: true, removed: result.removed } };
      }
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? '');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const result = menuRegistry.register(parsed);
      if (!result.ok) {
        return { kind: 'json', status: 200, obj: { ok: false, reason: result.reason, message: result.message } };
      }
      // 写入会唤醒所有挂起的长轮询；两端拿到新 counter 就重拼菜单（下一次右键即生效）
      state.writeSection('menu', { items: menuRegistry.snapshot() });
      return { kind: 'json', status: 200, obj: { ok: true } };
    }

    if (rest === 'menu/events') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const owner = url.searchParams.get('owner') ?? '';
      const rawWait = Number(url.searchParams.get('wait') ?? '0');
      const waitMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(rawWait, MENU_WAIT_MAX_MS) : 0;
      // 挂起等待期间调用方断开：不额外处理（最多白挂 MENU_WAIT_MAX_MS，无状态残留）
      const events = await menuRegistry.poll(owner, waitMs);
      // owner 不存在（没注册过 / 被清除了 / 宿主重启过）：业务失败，仍是 200
      if (events === null) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'unknown-owner', message: '这个 owner 没有注册，重新注册即可' },
        };
      }
      return { kind: 'json', status: 200, obj: { ok: true, events } };
    }

    if (rest === 'menu/click') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? '');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      // delivered=false（项已不在）= 正常竞态：渲染端拿的是上一拍快照，仍回 200
      return { kind: 'json', status: 200, obj: menuRegistry.click(parsed) };
    }

    // 可选模型清单（设置页「AI 模型」两个下拉框的数据源）：与 DSH 自己的模型选择器**同源**——
    // 都来自宿主 llm 服务：listProviders = 已注册的实时服务商路由，listModels(provider) = 该路由下的模型。
    // 只读、无副作用；某个服务商列模型失败（适配器不支持 / 网络）只让它空着，不拖垮整张清单。
    // 服务商路由一个都没注册时回落到 listConfigurableProviders（适配器声明可配置的路由），
    // 免得下拉框空着——那种路由调用失败会由生成侧的回落兜住。
    if (rest === 'models') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const llm = ctx.llm as
          | {
              listProviders?: () => Array<{ id?: unknown; name?: unknown }>;
              listConfigurableProviders?: () => Array<{ provider?: unknown; displayName?: unknown }>;
              listModels?: (provider: string) => Promise<Array<{ id?: unknown; name?: unknown }>>;
            }
          | undefined;
        const named = (id: unknown, name: unknown): { id: string; name: string } => {
          const pid = String(id ?? '');
          return { id: pid, name: String(name ?? '') || pid };
        };
        let providers = (typeof llm?.listProviders === 'function' ? llm.listProviders() : []).map((p) =>
          named(p?.id, p?.name),
        );
        if (providers.length === 0 && typeof llm?.listConfigurableProviders === 'function') {
          providers = llm.listConfigurableProviders().map((p) => named(p?.provider, p?.displayName));
        }
        providers = providers.filter((p) => p.id);
        const catalog = await Promise.all(
          providers.map(async (p) => {
            let models: Array<{ id: string; name: string }> = [];
            try {
              const list = await llm?.listModels?.(p.id);
              models = (Array.isArray(list) ? list : []).map((m) => named(m?.id, m?.name)).filter((m) => m.id);
            } catch {
              /* 单个服务商列不出模型：留空即可（下拉框里该服务商只有「跟随当前对话」可选） */
            }
            return { ...p, models };
          }),
        );
        return { kind: 'json', status: 200, obj: { providers: catalog } };
      } catch (e) {
        return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
      }
    }

    // 轮询统一状态（S）：/dsh-pet-7340/state（GET，no-cache）——前端轮询的**唯一**数据源
    // （余额 / 工作状态 / 通知 / 配置变更信号 / 宠物说话，形状见 ./state）。
    // 只读、纯内存、**零副作用**：绝不在这里触发外部调用或模型生成——那会把所有人的轮询拖死；
    // 也**不在这里碰磁盘**（早先这里现算配置文件的 mtime 指纹，等于每拍读一次盘，
    // 桌面端一窗一宠各自轮询 → N 倍；配置变更信号已改走 sections.config 叶子）。
    //
    // **长轮询**：带 `?since=&timeout=`（成对必填）时，若调用方手里的版本与当前相同就**挂起**，
    // 直到任意叶子被写过（立刻返回）或超时。不带这两个参数 = 立刻返回全量（改造前的语义）。
    // 等待语义与 GET /playback/{id} 的 wait 是同一套：上限同值、断线走同一个 signal 收尸、
    // 卸载走 cancelAll()。区别只有一个——那边的唤醒条件是"某条记录进入某个状态"，
    // 这边是"任意叶子被写过"，所以等待者是全局集合，一次写入唤醒所有人。
    if (rest === 'state') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const headers = { 'cache-control': 'no-cache, no-store' };
      const parsed = parseStateWaitQuery(url.searchParams.get('since'), url.searchParams.get('timeout'));
      if (parsed.kind === 'error') return { kind: 'json', status: 400, obj: { error: parsed.error } };
      const current = state.read();
      // 两者都没传 → 立刻返回；已经有新东西 → 也立刻返回（别白等一整个 timeout）。
      // timeout=0 走挂起分支，下一拍就醒，等价"立刻返回"，这里不特判。
      if (parsed.kind === 'none' || current.counter !== parsed.since) {
        return { kind: 'json', status: 200, obj: current, headers };
      }
      const since = parsed.since;
      return await new Promise<RouteResult>((resolveWait) => {
        let settled = false;
        /** 收尾：只认第一次（唤醒 / 超时 / 取消 / 调用方断开 都可能先后到达） */
        const settle = (result: RouteResult): void => {
          if (settled) return;
          settled = true;
          resolveWait(result);
        };
        // 唤醒时**才** read()：store 保证"叶子已写定"之后才叫醒，所以这里拿到的一定是新状态
        const cancel = state.wait({
          since,
          timeoutMs: parsed.timeoutMs,
          onWake: () => settle({ kind: 'json', status: 200, obj: state.read(), headers }),
        });
        // 调用方断开：取消等待者（清掉它的超时定时器），以"无需应答"收尾。
        const onAbort = (): void => {
          cancel();
          settle({ kind: 'none' });
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    // 外部写入工作状态：/dsh-pet-7340/work-status
    //   POST   = 设置固定外部槽 `api` 的档位（可选任务文案）；任务文案省略 = 保留原值，null = 清空
    //   DELETE = 清空外部槽回空闲（幂等）
    // 只解决"外部程序把状态告诉桌宠"，不做多写者仲裁/租约/会话管理；
    // 外部槽与 DSH 会话一起参与现有优先级（waiting > error > working > thinking > result > success）。
    if (rest === 'work-status') {
      if (method === 'DELETE') {
        if (workStatus.clear(EXTERNAL_WORK_SESSION)) publishWorkStatus();
        return { kind: 'text', status: 204, body: '' };
      }
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      if (Buffer.byteLength(body ?? '', 'utf8') > 8 * 1024)
        return { kind: 'json', status: 413, obj: { error: 'body too large' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? '');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      const payload = parsed as { state?: unknown; task?: unknown };
      const state = payload.state;
      if (typeof state !== 'string' || !(HOST_WORK_STATUS_STATES as readonly string[]).includes(state))
        return { kind: 'json', status: 400, obj: { error: 'invalid state' } };
      let task: string | null | undefined;
      if (Object.prototype.hasOwnProperty.call(payload, 'task')) {
        if (payload.task === null) {
          task = null;
        } else if (typeof payload.task === 'string') {
          const trimmed = payload.task.trim();
          if (trimmed === '') {
            task = null;
          } else if (Array.from(trimmed).length > TASK_TEXT_MAX) {
            return {
              kind: 'json',
              status: 400,
              obj: { error: `task too long (max ${TASK_TEXT_MAX} code points)` },
            };
          } else {
            task = trimmed;
          }
        } else {
          return { kind: 'json', status: 400, obj: { error: 'invalid task' } };
        }
      }
      externalWorkSeq += 1;
      workStatus.setState(EXTERNAL_WORK_SESSION, state as HostWorkStatusState, externalWorkSeq);
      if (task !== undefined) workStatus.setTask(EXTERNAL_WORK_SESSION, task);
      publishWorkStatus();
      return {
        kind: 'json',
        status: 200,
        obj: {
          state: workStatus.stateOf(EXTERNAL_WORK_SESSION) ?? state,
          task: workStatus.taskOf(EXTERNAL_WORK_SESSION),
        },
      };
    }

    // 余额：/dsh-pet-7340/balance（POST = 立即刷新一次并写入 S，返回 {ok}）
    // 动作端点，**不返回余额数据**——数据只有一个出口（/state），这里只负责"让它刷新"。
    // 改造前这里是 GET（直接查余额）+ /balance/trigger（1s 计数轮询）两个端点，都已删除：
    // 前端不再各自定时查余额（host 定时器统一查，两端共享一份），也不再需要计数轮询中转。
    if (rest === 'balance') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      await refreshBalance(true); // manual：用户主动要的，余额不可用时前端必弹文字说明
      // ok 只表示"这次刷新动作完成了"；余额本身是否可用在 S 的 data 里（ok:false 会弹文字说明气泡）
      return { kind: 'json', status: 200, obj: { ok: true } };
    }

    // 占用锁：/dsh-pet-7340/lock?pet=<id>          （POST = 取锁 / 续期，二合一）
    //         /dsh-pet-7340/lock/release?pet=<id>  （POST = 释放）
    //
    // issue #122 第 4 项「独立动作/气泡占用」。一把锁、**全有全无**：拿锁 → 回 lockId；占用期间
    // 除持锁者外全静音（5 个动作端点要带 `?lock=`，内部自动来源各自让路）；释放 → 一切复原。
    //
    // 与 /playback 的分工：那个是"这一次点播播完没有"的**回执**，这个是"这段时间归谁控制"的**租约**。
    // 锁自己占一个叶子（`pets.<id>.lock`）：渲染端必须能读到它才能冻结自己——宿主停不掉一段
    // 正在播的视频，"完全静止"最终是渲染端执行的。
    //
    // 取锁 / 续期**二合一**（`lockId` 给了 = 续期）：续期是持锁者每隔几秒就要做一次的**心跳**，
    // 而这一次调用同时就是"我的锁还在吗"的探测器——丢了会回 lock-lost + cause，所以不需要
    // 单独的"查锁"端点。真值表与墓碑语义见 ./lock 的 acquire。
    //
    // 失败一律 HTTP 200 + ok:false（与其他动作端点口径一致）；只有 405 / 400 不是 200。
    if (rest === 'lock' || rest === 'lock/release') {
      const isRelease = rest === 'lock/release';
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      try {
        // pet **必填**且必须真实存在（与 /anim、/broadcast 同一口径，见 requirePet）
        // surface 只对**取锁**这一支校验：`/lock/release` 必须永远能成功（否则宠物中途被隐藏就撤不掉锁）
        const who = requirePet(url.searchParams, () => readAllConfig(configPaths), { surface: !isRelease });
        if (!who.ok) return who.res;
        const petId = who.petId;
        if (isRelease) {
          const d = lock.release({ petId, lockId: o.lockId, force: o.force });
          if (!d.ok) {
            const obj: Record<string, unknown> = { ok: false, reason: d.reason, message: d.message };
            if (d.reason === 'lock-lost') obj.cause = d.cause;
            return { kind: 'json', status: 200, obj };
          }
          // 幂等：当前没有锁同样回 ok（"让锁消失"这个意图在空状态下已经成立）
          return { kind: 'json', status: 200, obj: { ok: true } };
        }
        const d = lock.acquire({ petId, lockId: o.lockId, ttl: o.ttl });
        if (!d.ok) {
          const obj: Record<string, unknown> = { ok: false, reason: d.reason, message: d.message };
          if (d.reason === 'locked') obj.expiresAt = d.expiresAt; // 让对方知道何时能重试
          if (d.reason === 'lock-lost') obj.cause = d.cause;
          return { kind: 'json', status: 200, obj };
        }
        return {
          kind: 'json',
          status: 200,
          obj: { ok: true, lockId: d.lockId, petId: d.petId, expiresAt: d.expiresAt },
        };
      } catch (e) {
        // 配置读取失败等（安装损坏）→ 显式失败，不静默（与其他动作端点同一口径）
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 碎碎念：/dsh-pet-7340/whisper?pet=<id>（POST = 立即让桌宠新说一句，返回 {ok,text,image?}）
    // 文本**照旧**写进 S 的 pets.<id>.say（碎碎念/命令气泡/对话回复同一个叶子），同时随响应带回——
    // 两条出口给的是同一份文本；其它消费端（网页/桌面/第三方监听）仍从 /state 读。
    // 手动语义不受 whisperEnabled 门控：那个字段只关自动周期（与改造前一致）。
    if (rest === 'whisper') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        // pet **必填**且必须真实存在：收紧前这里是 `?? ''`——空串会让人设/配图按 main 条目取、
        // 生成结果写进没人消费的 `pets[""].say`，还回 ok:true（钱花了、话丢了、调用方以为成功）。
        const who = requirePet(url.searchParams, () => readAllConfig(configPaths), { surface: true });
        if (!who.ok) return who.res;
        const r = await publishWhisper(who.petId);
        if (r.ok) {
          return {
            kind: 'json',
            status: 200,
            obj: { ok: true, text: r.text, ...(r.image ? { image: r.image } : {}) },
          };
        }
        // 真实 reason 原样透出（独立模式是 `provider-missing`，见 ./whisper 的联合体）——
        // 不再把一切失败糊成 generate-error，调用方据此能分清"没配模型"与"生成炸了"。
        const obj: Record<string, unknown> = { ok: false, reason: r.reason };
        if (r.message) obj.message = r.message;
        return { kind: 'json', status: 200, obj };
      } catch (e) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 第三方投喂：/dsh-pet-7340/broadcast?pet=<id>（POST = 把一段**外部给定的**文本写进桌宠气泡）
    // 与 /whisper 的区别：这个**不生成**，调用方自己给文本——宿主侧其他插件（女仆巡检等）
    // 想说自己的话时用它，桌宠就成了那套人格的"实体"（见 issue #76）。
    // 写入 S 的 pets.<id>.say —— 与碎碎念/对话回复**同一个叶子**，两端 1s 内自动显示，前端零改动。
    // 动作端点，只回 {ok}；文本本身从 /state 读。
    // 校验（不通过一律 HTTP 200 + ok:false，与 /chat 的失败口径一致）：
    //   text 必填、trim 后非空（**不设长度限制，也不限频**：内容与频率由调用方自己负责）；
    //   pet **必填**（空串 → pet-required），且须真实存在（否则 unknown-pet）；
    //   image / url **配图的两种形态，二选一**（两个都给 = bad-request）：
    //     image 只认**该条目表情包池内的名称**（池内命中即用其规范名）；
    //     url 是第三方自带的完整地址，不查池（issue #122 第 1 条：素材由第三方自己托管），
    //     scheme 由宿主卡在 http/https。**宿主不做代理**：跨域由浏览器强制，插件绕不过去。
    //   duration 可选，气泡显示时长（ms）；缺省 10s，`0` = 字面意思「不显示」，负数/非有限数拒绝；
    //   anim 可选，是否联动 events.whisper 动画；只有严格 false 才关闭（宽松口径）。
    // 听的口型：/dsh-pet-7340/ear（POST {phase:'listen'|'think'|'idle'}）。
    // 听.py 只管录音和出字，壳（ear.js）把「在录 / 出字了 / 有回复了」翻译成这三种状态。
    if (rest === 'ear') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      const phase = o.phase === 'listen' ? 'listen' : o.phase === 'think' ? 'think' : 'idle';
      setEarPhase(phase);
      // 【11-18】按 Alt+T 开录 = 4 级手动：屏幕想让路，别在她听你说话时插嘴
      if (phase === 'listen') noteCommand('hotkey', '听一句');
      // 【11-18】听不清 / 没录到东西：让她在屏上说一句，别只写日志
      const note = typeof o.note === 'string' ? o.note.trim().slice(0, 60) : '';
      if (note !== '') pushHint('status', note, 'event', 2_000);
      return { kind: 'json', status: 200, obj: { ok: true, phase: earPhaseNow() } };
    }

    if (rest === 'broadcast') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      // 【11-18】在听 / 嘴忙都不许从外面插进来（文档 9.10：嘴忙就丢）
      if (earPhaseNow() === 'listen' || speakBusy()) {
        return { kind: 'json', status: 200, obj: { ok: false, reason: 'ear-busy', skipped: true } };
      }
      // 判定 + 门禁 + 写叶子全在 core（唯一实现）；这里只负责把请求翻成 SayInput、回状态码。
      return {
        kind: 'json',
        status: 200,
        obj: core.say(
          {
            petId: String(url.searchParams.get('pet') ?? ''),
            text: o.text,
            image: o.image,
            url: o.url,
            duration: o.duration,
            anim: o.anim,
            surface: String(url.searchParams.get('surface') ?? ''),
          },
          url.searchParams,
        ),
      };
    }

    // 歌词气泡：/dsh-pet-7340/lyric?pet=<id>&surface=<desktop|browser>（POST）
    // body `{ text, instrumental? }`：text 是**当前该显示的那一句**（整句替换，不是增量）；
    // 空串 = 立即隐藏（幂等）。instrumental=true 时前端只把它当"器乐段提示"排版。
    // 与 say 的关系：独立叶子 `pets.<id>.lyric`，**不抢说话气泡**、也不被说话气泡抢走；
    // 与锁的关系：**不做占用锁门禁**（谁在跟桌宠打字不该挡住歌词），只做显示端校验。
    if (rest === 'lyric') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      return {
        kind: 'json',
        status: 200,
        obj: core.lyric(
          {
            petId: String(url.searchParams.get('pet') ?? ''),
            text: o.text,
            instrumental: o.instrumental,
            surface: String(url.searchParams.get('surface') ?? ''),
          },
          url.searchParams,
        ),
      };
    }

    // 清空气泡：/dsh-pet-7340/bubble/clear?pet=<id>（POST = 收起该宠物**当前正显示的说话气泡**）
    // 与 /broadcast 的关系：投喂写气泡，这个收气泡；两者共用同一个叶子（pets.<id>.say）。
    // 清空靠叶子里的 `{ clear: true }` 标记——**空文本表达不了这个动作**：消费端的 readSay
    // 会把空文本判成非法、整拍跳过，所以必须有一个独立的形态（见 src/shared/state.ts 的 SayCue）。
    // 只收说话气泡：余额气泡、工作状态气泡、以及 anim/position/throw 三个叶子**都不动**
    // （气泡与动作是两把锁，分别释放——issue #122 第 5 条）。
    // 幂等：当前没有气泡也回 { ok: true }（"让气泡消失"这个意图在空状态下已经成立）。
    // 无请求体；动作端点，只回 {ok}。
    if (rest === 'bubble/clear') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const cfg = readAllConfig(configPaths);
        const d = decideBubbleClear({
          cfg,
          requested: String(url.searchParams.get('pet') ?? ''),
        });
        if (!d.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
        if (noSurface) return noSurface;
        const blocked = lockBlocked(d.petId, url.searchParams);
        if (blocked) return blocked;
        // 收气泡也走唯一入口（契约测试要求写 say 叶子只许三个函数）
        clearSayBubble(d.petId, 'chat');
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (e) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 点播动画：/dsh-pet-7340/anim?pet=<id>（POST = 让桌宠播一段动画）
    // 两种形态**二选一**（issue #122 第 1 条）：
    //   name = 池内的动画名。效果与右键菜单点「动作」树**完全一致**——两端都复用同一个菜单动作
    //     处理函数（浏览器 handleMenuAction / 桌面 sprite.onMenuAction），宿主只负责把名字送到。
    //     写入 S 的 pets.<id>.anim，前端发现 counter 变化后换源播放（**名字即文件名**）。
    //   url = 第三方自带的素材完整地址。**不查动画池**（素材在别人手里，池里当然没有这个名字），
    //     前端拿到后**直接换源播一次，不走菜单语义**——裸地址没有"文字类要镜像修正 /
    //     移动类走真实位移"这些属性。scheme 由宿主卡在 http/https。
    // 动作端点，只回 {ok}（成功时另带回执编号 playbackId）。
    // 校验（不通过一律 HTTP 200 + ok:false，与其他动作端点口径一致）：
    //   name / url 必须**恰好给一个**：两个都给或都不给 = 意图不明 → bad-request；
    //   name 必须在该宠物 animations 配置能点到的集合内
    //   （播放端对不存在的动画没有兜底：名字即文件名 → 404 → 加载失败 → 表现为"点了没反应"，
    //    所以必须在这里拦住，而不是写进 S 让前端白跑一趟）；
    //   url 必须是 http/https 的完整地址（`file:` 会让桌面端渲染进程能读本地任意文件）；
    //   pet **必填**（空串 → pet-required），且须真实存在（否则 unknown-pet）；
    //   facing **可选**（left / right）：给了就必须合法（非法 → bad-request），**没给就不动朝向**
    //     ——叶子里连字段都不写，渲染端保持宠物当前朝向（不是"回落 left"）。显式值优先于渲染端
    //     "文字类动画点播前强制朝左"那条镜像修正（调用方明确要哪个朝向就给哪个）。
    if (rest === 'anim') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      try {
        const cfg = readAllConfig(configPaths);
        const d = decideAnim({
          cfg,
          requested: String(url.searchParams.get('pet') ?? ''),
          name: o.name,
          url: o.url,
          facing: o.facing,
        });
        if (!d.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        // 显示端对齐：不满足 → pet-not-displayed（+ 实际 display），早于锁门禁
        const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
        if (noSurface) return noSurface;
        // 占用门禁：持锁者自己的点播照放行（那是它的演出），别人一律拒
        const blocked = lockBlocked(d.petId, url.searchParams);
        if (blocked) return blocked;
        // 播放回执：受理时建记录（accepted），并把编号随叶子一起下发——渲染端据此上报。
        // 记录里的标识：name 形态是动画名，url 形态就是那个地址（纯记录，不参与任何判定）。
        // 叶子形状：name 与 url **恰好一个**（判定层保证），消费端按字段名决定走不走菜单语义
        // ——url 是裸地址，没有"文字类要镜像修正 / 移动类走真实位移"这些属性。
        // `facing` 只在调用方**显式给了**时才进叶子：没给 = 不动朝向，叶子里连字段都没有
        //（消费端据此区分"没要求"和"要求 left"，不会把缺省当成 left）。
        const record = playback.create(d.petId, d.url ?? d.name ?? '');
        state.writePet(d.petId, 'anim', {
          ...(d.url !== undefined ? { url: d.url } : { name: d.name }),
          playbackId: record.playbackId,
          ...(d.facing === undefined ? {} : { facing: d.facing }),
        });
        return { kind: 'json', status: 200, obj: { ok: true, playbackId: record.playbackId } };
      } catch (e) {
        // 配置读取失败等（安装损坏）→ 显式失败，不静默
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 位置与抛掷：/dsh-pet-7340/position 与 /dsh-pet-7340/throw（POST）——两条**运动指令**。
    //
    // 与 /anim 同族：受理后写进 S 的宠物叶子（pets.<id>.position / pets.<id>.throw），由渲染端消费。
    // 位置**不引入任何新运动学**：`mode` 三选一（instant 一帧到位 / spring 拖拽那套过阻尼弹簧 /
    // line 按 duration 毫秒直线走到），三条路都是渲染端已经有的；抛掷复用已有的 startThrow
    // （角度/力度换算成初速度），下游的重力/反弹/摩擦/落地 Q 弹/宠物间碰撞一概照旧。
    // 所以这里只做校验与夹取（纯逻辑在 ./motion-cue，可离线单测）。
    //
    // 位置：x/y 是宠物**中心**的归一化坐标（0~1），越界**夹取**并把实际生效值回给调用方。
    // 抛掷：angle 单位度（0 = 正右，逆时针为正）；power 是力度倍率（1.0 = 1200 px/s 软钳速前）。
    //
    // 与用户拖拽撞车时**静默丢弃**：渲染端发现手指正按在宠物身上就丢掉这一拍，但仍然回 ok:true
    // （动作端点只表示"受理了"，不表示"生效了"，与 /anim 同一契约）。宿主判不了拖拽状态——
    // 那只有渲染端知道（见两端的 active 标志），所以这里不做拒绝。
    if (rest === 'position' || rest === 'throw') {
      const isPosition = rest === 'position';
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      try {
        const cfg = readAllConfig(configPaths);
        const requested = String(url.searchParams.get('pet') ?? '');
        if (isPosition) {
          const d = decidePosition({
            cfg,
            requested,
            x: o.x,
            y: o.y,
            mode: o.mode,
            duration: o.duration,
          });
          if (!d.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
          const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
          if (noSurface) return noSurface;
          const blocked = lockBlocked(d.petId, url.searchParams);
          if (blocked) return blocked;
          // 叶子按模式收敛成最小形状：非 line 模式不带 duration（见 positionLeafData）
          state.writePet(d.petId, 'position', positionLeafData(d));
          // 回**夹取后**的实际生效值：调用方不必自己算边界，也不会误以为越界值被照单全收
          return { kind: 'json', status: 200, obj: { ok: true, x: d.x, y: d.y } };
        }
        const d = decideThrow({ cfg, requested, angle: o.angle, power: o.power });
        if (!d.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
        if (noSurface) return noSurface;
        const blocked = lockBlocked(d.petId, url.searchParams);
        if (blocked) return blocked;
        state.writePet(d.petId, 'throw', { angle: d.angle, power: d.power });
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (e) {
        // 配置读取失败等（安装损坏）→ 显式失败，不静默（与 /anim 同一口径）
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 实况：/dsh-pet-7340/pose?pet=<id>        （GET  = 第三方读**桌面端**的实况快照）
    //       /dsh-pet-7340/pose/report?pet=<id> （POST = **桌面渲染端**上报，内部通道）
    //
    // 为什么只有桌面端走这条路：桌面宠物**一窗一只**，位置全局唯一一份 → 宿主快照语义干净；
    // 而网页端的位置**天生每个页面一份**（开两个标签页时两边本来就不同），塞进宿主快照必然是
    // 错的（后写者覆盖先写者）。所以网页端走**页面内**的 Cordis 只读服务 `petApi7340`
    // （src/client/pose.ts）——两边**字段名与坐标口径完全一致**（中心点归一化 0~1，与 /position
    // 同源），只是"取"的方式不同。
    //
    // 上报是**变化时推 + 节流**（拖拽 / 走位 / 抛掷 / position 指令 / turn 转身），不是轮询。
    //
    // 本端点**不要求 `surface`**：它是**读**端点（`GET /chat`、`GET /playback` 同样不带），而且它
    // 的定义域本身只有一个面。宠物配置上就不在桌面显示时用 `pet-not-displayed` 明说。
    if (rest === 'pose' || rest === 'pose/report') {
      const isReport = rest === 'pose/report';
      if (isReport && method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      if (!isReport && method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      // 协议层错误（非法 JSON）先报：与 /anim 同一顺序
      let parsedPose: unknown;
      if (isReport) {
        try {
          parsedPose = JSON.parse(body ?? 'null');
        } catch {
          return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
        }
      }
      try {
        const who = requirePet(url.searchParams, () => readAllConfig(configPaths));
        if (!who.ok) return who.res;
        if (isReport) {
          const p = normalizePoseInput(parsedPose);
          if (!p.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: p.reason, message: p.message } };
          pose.set(who.petId, p.pose);
          return { kind: 'json', status: 200, obj: { ok: true } };
        }
        // 桌面端实况只对"显示在桌面"的宠物有意义：配置上就不在桌面 → 明确不可用（附实际 display）
        const display = String(who.pet.display ?? '');
        if (!displayCovers('desktop', display)) {
          return {
            kind: 'json',
            status: 200,
            obj: {
              ok: false,
              reason: 'pet-not-displayed',
              message: who.petId + ' 的显示模式是 ' + display + '；桌面端实况只对 display 含 desktop 的宠物有',
              display,
            },
          };
        }
        const snap = pose.get(who.petId);
        if (snap === undefined) {
          return {
            kind: 'json',
            status: 200,
            obj: {
              ok: false,
              reason: 'pose-unavailable',
              message: '还没收到过这只宠物的桌面端实况（桌面端没起来，或刚重启还没来得及上报）',
            },
          };
        }
        return { kind: 'json', status: 200, obj: { ok: true, petId: who.petId, ...snap } };
      } catch (e) {
        // 配置读取失败等（安装损坏）→ 显式失败，不静默（与其他端点同一口径）
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 播放回执：/dsh-pet-7340/playback/<id>        （GET 查询，可挂起等待）
    //           /dsh-pet-7340/playback/<id>/report （POST，**渲染端上报**）
    //
    // 记录由**渲染端上报驱动**（见 ./playback）：host 只知道"受理了"，不知道播没播完——
    // 所以没有 /report 就没有真实回执，查询永远停在 accepted。
    // 与 S 无关：播放记录是 per-caller 资源（只有发起那次点播的调用方关心、有生命周期、
    // 数量随第三方调用方增长），放进 1s 全局广播会让每个窗口为每个功能付流量。
    // 前缀守卫写成**字面量比较**：一是把正则尝试限定在 playback 段（更快、边界更明确），
    // 二是让 scripts/check-openapi.mjs 的「文档 ↔ 路由实现」对齐检查能认出这条路由
    //（它靠 rest 与单引号段名的字面量比较从实现里提取路由，纯正则形式的匹配它看不见；
    //  注意注释里别把那个比较原样写出来，会被同一条正则当成一条真实路由）。
    const playbackPath = rest === 'playback' || rest.startsWith('playback/') ? parsePlaybackPath(rest) : undefined;
    if (playbackPath) {
      const playbackId = playbackPath.playbackId;
      // ---- 上报（渲染端 → host）：开始播 / 播完 / 失败 / 被打断时各来一次 ----
      if (playbackPath.isReport) {
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        let reported: unknown;
        try {
          reported = JSON.parse(body ?? 'null');
        } catch {
          return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
        }
        const o = reported && typeof reported === 'object' ? (reported as Record<string, unknown>) : {};
        const outcome = playback.report(playbackId, o.status, o.reason);
        if (outcome === 'unknown') return { kind: 'json', status: 404, obj: { error: 'unknown playback' } };
        if (outcome === 'invalid') return { kind: 'json', status: 400, obj: { error: 'invalid status' } };
        // ok / ignored 都回 200：上报是幂等的，"已经这样了"对上报方就是成功
        // （迟到的 ended 不许覆盖 cancelled——终态保护在 ./playback 里）
        return { kind: 'json', status: 200, obj: { ok: true } };
      }
      // ---- 查询（第三方调用方）----
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const record = playback.get(playbackId);
      if (!record) return { kind: 'json', status: 404, obj: { error: 'unknown playback' } };
      const parsed = parseWaitQuery(url.searchParams.get('wait'), url.searchParams.get('timeout'));
      if (parsed.kind === 'error') return { kind: 'json', status: 400, obj: { error: parsed.error } };
      // 两者都没传 = 立刻返回（兜底 / 调试 / 只想知道当下状态的调用方）
      if (parsed.kind === 'none') {
        return { kind: 'json', status: 200, obj: { ...record, matched: false } };
      }
      const { wait: waitList, timeoutMs } = parsed;
      // 已经是等的状态之一 → 立刻返回，别白等一整个 timeout
      if (waitList.includes(record.status)) {
        return { kind: 'json', status: 200, obj: { ...record, matched: true } };
      }
      // 挂起等待：状态进入 wait 集合立刻唤醒（matched:true）；到点回当时的记录（matched:false）。
      // timeout=0 时 playback.wait 下一拍就唤醒，等价"立刻返回"，这里不特判。
      return await new Promise<RouteResult>((resolveWait) => {
        let settled = false;
        /** 收尾：只认第一次（唤醒 / 超时 / 取消 / 调用方断开 都可能先后到达） */
        const settle = (result: RouteResult): void => {
          if (settled) return;
          settled = true;
          resolveWait(result);
        };
        const cancel = playback.wait({
          playbackId,
          wait: waitList,
          timeoutMs,
          // 唤醒时**不需要**再取消：store 在回调前已把等待者摘掉（超时定时器也清了）
          onWake: (r, matched) => settle({ kind: 'json', status: 200, obj: { ...r, matched } }),
        });
        // get 之后记录被清理（极端竞态）→ 立刻 404，不挂
        if (cancel === undefined) {
          settle({ kind: 'json', status: 404, obj: { error: 'unknown playback' } });
          return;
        }
        // 调用方断开：取消等待者（清掉它的超时定时器），以"无需应答"收尾。
        // 监听不摘也无妨：signal 只被这次请求持有，请求结束后整条引用链一起回收。
        const onAbort = (): void => {
          cancel();
          settle({ kind: 'none' });
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    // 对话：/dsh-pet-7340/chat?pet=<id>
    //   GET  —— 最近记忆窗口（截尾 chatMemoryRounds 轮），弹窗打开时展示（一次性读，不是轮询）
    //   POST —— 携带历史生成回复并写入记忆；回 {ok,text,image?}，回复同样写 S 的 pets.<id>.say
    // 记忆唯一读写方 = host（memory.json；浏览器/桌面两端都只是客户端）→
    // 同一实例的浏览器与桌面天然共享同一份记忆；文件全存不删，
    // 请求只截尾部 chatMemoryRounds 轮（1 轮 = 1 问 1 答；合并器已按条目填默认）。
    if (rest === 'chat') {
      if (method !== 'GET' && method !== 'POST') {
        return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      }
      try {
        // `?rounds=`：GET 专属的查看参数——只决定这次读多少轮（不写记忆，也不改变后续对话
        // 往上下文里带多少，所以 POST 不认它）。与 surface 同一处境：参数级校验放在读盘之前。
        const roundsRaw = method === 'GET' ? url.searchParams.get('rounds') : null;
        let roundsOverride: number | null = null;
        if (roundsRaw !== null && roundsRaw.trim() !== '') {
          const n = Number(roundsRaw);
          if (!Number.isInteger(n) || n < 0 || n > 200) {
            return {
              kind: 'json',
              status: 200,
              obj: { ok: false, reason: 'bad-request', message: 'rounds 必须是 0–200 的整数（不传则用配置）' },
            };
          }
          roundsOverride = n;
        }
        // pet **必填**且必须真实存在：收紧前这里是 `?? ''`——人设/配图按 main 条目取，记忆会以那个
        // （不存在的）id 新建一个分桶，回复写进没人消费的 `pets[""].say`，还回 ok:true。
        // 惰性 + 记忆化：pet 空串时完全不读配置；GET 分支复用同一次读取。
        let cfgCache: Record<string, Record<string, unknown>> | undefined;
        const cfg = (): Record<string, Record<string, unknown>> => (cfgCache ??= readAllConfig(configPaths));
        // surface 只对 POST 校验：GET 是读记忆，跟宠物显示在哪一端无关
        const who = requirePet(url.searchParams, cfg, { surface: method === 'POST' });
        if (!who.ok) return who.res;
        const petId = who.petId;
        if (method === 'GET') {
          // 传了 ?rounds= 就用传的（含 0 = 空历史），没传才回落到配置。
          // 历史只来自**今天**的回声（跨天即清零），与 chatWithPet 同一份来源。
          const rounds = roundsOverride ?? memoryRounds(who.conf);
          const messages = await recentMessages('chat', rounds);
          return { kind: 'json', status: 200, obj: { ok: true, messages, rounds } };
        }
        if (method === 'POST') {
          const parsed = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
          const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
          if (!text) {
            return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: '消息为空' } };
          }
          if (text.length > 2000) {
            return {
              kind: 'json',
              status: 200,
              obj: { ok: false, reason: 'bad-request', message: '消息过长（限 2000 字）' },
            };
          }
          const result = await chatWithPet(petId, text);
          return { kind: 'json', status: 200, obj: result };
        }
      } catch (e) {
        // 配置已由 readAllConfig 保证正确（不再有 config-error 分支）；其余（IO/LLM）→ generate-error
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 动画文件：/dsh-pet-7340/thumb/<素材根>/<file>，扩展名 webm（默认）/ mov（macOS 定制）。
    // 素材归属按「是否存在该宠物的独立素材目录 `pet/<petId>-animation/`」判定：
    //   - 存在（pet pack 宠物）：只查自己的目录，查不到即 404 显式报错——绝不混用
    //   - 不存在（**所有主配置宠物**，main 与用户添加的任意多只）：主素材链
    //     main-animation/<webm|mov> 优先 → 包内 assets/<webm|mov>（与宠物数量无关，多只共用）
    // mov（HEVC-with-Alpha）为 macOS Safari/WKWebView 定制格式：默认不随包发布，
    // 用户从 GitHub Release（assets-mov）下载后放 main-animation/mov/，并把客户端播放
    // 扩展名常量（src/shared/constants.ts 的 ANIMATION_EXT / 产物 lib/client.js）改为 .mov。
    // 注意：font / pic 是扁平的 /<scope>/<file>，只有 thumb 是 /<scope>/<petId>/<file>——
    // 这里先拆 scope，再按 scope 各自拆剩余段，避免 font/pic 被误当作 petId 吞掉文件段。
    const [scope, ...restParts] = rest.split('/');
    if (scope === 'font') {
      const fontRoot = join(PACKAGE_ROOT, 'assets', 'fonts');
      const fontFile = resolveExisting(fontRoot, restParts.join('/'));
      if (fontFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: font not found' };
      const ext = fontFile.slice(fontFile.lastIndexOf('.')).toLowerCase();
      return { kind: 'file', file: fontFile, contentType: MIME[ext] ?? 'application/octet-stream' };
    }

    // 通知图标：/dsh-pet-7340/pic/<file> → 包内 assets/pic（方形 png，系统通知 icon 用）
    // 表情包：/dsh-pet-7340/pic/memes/<素材根>/<名称>.png → 按素材根走 memeDirsFor 的目录链
    // （种类独占目录 → 用户目录 → 包内），与 /thumb 同一套素材归属语义；名称含中文，URL 段已在上方解码。
    // 旧的两段形式 /pic/memes/<名称>.png 保留：等价于素材根 main 的目录链（未升级的客户端照常取到包内图）。
    if (scope === 'pic') {
      if (restParts[0] === 'memes') {
        const segs = restParts.slice(1);
        // 段数 ≥ 2 = <素材根>/<名称…>；恰好 1 段 = 旧扁平形式。表情包名称即文件名（不含子目录），
        // 所以两种形式不歧义；素材根与 /thumb 的 petId 同规矩：含分隔符 / 保留字符即显式 400。
        const scoped = segs.length >= 2;
        const assetRoot = scoped ? segs[0] : 'main';
        if (scoped && (assetRoot.length > 64 || ID_FORBIDDEN.test(assetRoot))) {
          return { kind: 'text', status: 400, body: 'dsh-pet: invalid asset root' };
        }
        const rel = (scoped ? segs.slice(1) : segs).join('/');
        let picFile: string | undefined;
        for (const dir of memeDirsFor(assetRoot)) {
          picFile = resolveExisting(dir, rel);
          if (picFile !== undefined) break;
        }
        if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: pic not found' };
        const ext = picFile.slice(picFile.lastIndexOf('.')).toLowerCase();
        return { kind: 'file', file: picFile, contentType: MIME[ext] ?? 'application/octet-stream' };
      }
      const picRoot = join(PACKAGE_ROOT, 'assets', 'pic');
      const picFile = resolveExisting(picRoot, restParts.join('/'));
      if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: pic not found' };
      const ext = picFile.slice(picFile.lastIndexOf('.')).toLowerCase();
      return { kind: 'file', file: picFile, contentType: MIME[ext] ?? 'application/octet-stream' };
    }

    if (scope !== 'thumb') {
      return { kind: 'text', status: 400, body: 'dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>' };
    }
    // thumb 是三段式：/<scope>/<petId>/<file>——从这里再拆宠物 id 与文件名
    const [petId, ...nameParts] = restParts;
    if (!petId || nameParts.length === 0) {
      return { kind: 'text', status: 400, body: 'dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>' };
    }
    // petId 是**标识符**（= pet/<名>-animation/ 的 <名>，来源是 pet/ 下的文件名前缀），不是路径片段：
    // 含分隔符/保留字符即显式 400，早于任何路径拼接判定。合法名（含中文）照常——
    // 用非法字符类而不是 ASCII 白名单。非法输入不再静默回落到主素材池（攻击尝试与"没有独立素材"可区分），
    // 也给下面的 resolveAsset 之外再留一道结构性防线。
    if (ID_FORBIDDEN.test(petId)) {
      return { kind: 'text', status: 400, body: 'dsh-pet: invalid pet id' };
    }
    const fileName = nameParts.join('/');
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    if (ext !== '.webm' && ext !== '.mov') {
      return { kind: 'text', status: 400, body: 'dsh-pet: unsupported animation format (expected .webm or .mov)' };
    }
    // 素材归属（按是否存在该宠物的独立素材目录判定，绝不静默混用）：
    //   - 存在 `pet/<petId>-animation/`（pet pack 宠物，URL 段 = 素材根 assetRoot）：
    //     只查自己的目录，查不到即 404 显式报错——绝不回落**别的素材**
    //     （唯一例外：同名的 webm/mov 互换，即下方 mov 缺失时退回 webm）
    //   - 不存在（**所有主配置宠物**：main 及用户添加的任意多只，共用全局动画池）：
    //     主素材链——用户 main-animation/<ext 子目录> 优先，其次包内 assets/<ext 子目录>
    // extraAnimDir 必须先过 resolveAsset：petId 是解码后的 URL 段，Windows 上 %5C 解出的
    // 反斜杠不会被 rest.split('/') 切开，直接 join 会让 `..\..\x` 逃出用户根读盘。
    const extraAnimDir = resolveAsset(petConfigDir, petId + '-animation');
    /** 按扩展名查同名素材（专属目录优先；否则用户根 → 包内根） */
    const findAnim = (e: string): string | undefined => {
      const name = fileName.replace(/\.(webm|mov)$/i, '') + e;
      return extraAnimDir !== undefined && existsSync(extraAnimDir)
        ? resolveExisting(extraAnimDir, name)
        : (resolveExisting(userRootFor(e), name) ?? resolveExisting(assetRootFor(e), name));
    };
    let file = findAnim(ext);
    let servedExt = ext;
    // mov（HEVC-with-Alpha，macOS 定制）不随包发布：缺失时退回同名 webm。
    // 宿主是唯一知道素材在不在的一方——宁可让 Safari 播黑底（webm 的 alpha 被丢弃），
    // 也不能让整段动画 404（表现就是宠物完全不显示）。
    if (file === undefined && ext === '.mov') {
      const fb = findAnim('.webm');
      if (fb !== undefined) {
        file = fb;
        servedExt = '.webm';
      }
    }
    if (file === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: asset not found' };
    return { kind: 'file', file, contentType: MIME[servedExt] ?? 'application/octet-stream' };
  };

  /**
   * 【汐儿 · 11-17 第 5 批】同一个 handler 挂两个前缀：内部 `/dsh-pet-7340`，对外 `/v1`。
   * 两条走的是同一份逻辑，差别只在门口那道鉴权（`/v1` 不在免令牌名单里，必须带 token）。
   */
  /* 【汐儿 · 11-17 第 5 批补】`/v1` 对外门面：统一信封 `{ ok, data }` / `{ ok, error }`。
   * 不是新的一套业务——全部落到同一份 handlePetRoute 上，只是形状和入口对外固定下来。
   * 认不出的 /v1/* 仍然按别名落到内部路由，旧调用一律不断。 */
  const v1Envelope = (result: RouteResult): RouteResult => {
    if (result.kind !== 'json') return result;
    const status = result.status ?? 200;
    const ok = status < 400;
    return {
      kind: 'json',
      status,
      headers: result.headers,
      obj: ok ? { ok: true, data: result.obj } : { ok: false, error: result.obj },
    };
  };
  // 内部路由里有几条把 pet 放在**查询串**（/broadcast?pet=main），/v1 的调用方习惯写在 body 里。
  // 这里统一搬一次，免得 /v1/show 被回「pet 必填」——11-19 全量测试逮到。
  const V1_PET_QUERY = new Set(['broadcast', 'say', 'look', 'anim', 'throw', 'lock', 'position', 'lyric']);
  const V1_SURFACE_QUERY = new Set(['broadcast', 'lyric']);
  const surfaceOfBody = (body?: string): string | undefined => {
    if (body === undefined || body === '') return undefined;
    try {
      const parsed = JSON.parse(body) as { surface?: unknown };
      return typeof parsed.surface === 'string' && parsed.surface.trim() !== '' ? parsed.surface.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const petOfBody = (body?: string): string => {
    if (body === undefined || body === '') return '';
    try {
      const parsed = JSON.parse(body) as { pet?: unknown };
      return typeof parsed.pet === 'string' ? parsed.pet.trim() : '';
    } catch {
      return '';
    }
  };
  const v1Forward = async (target: string, method: string, body?: string): Promise<RouteResult> => {
    const pet = V1_PET_QUERY.has(target) ? petOfBody(body) : '';
    // /broadcast、/lyric 还要 surface（web / desktop / both / any）；对外门面默认 any（两头都写）
    const query: string[] = [];
    if (pet !== '') query.push(`pet=${encodeURIComponent(pet)}`);
    if (V1_SURFACE_QUERY.has(target)) query.push(`surface=${encodeURIComponent(surfaceOfBody(body) ?? 'any')}`);
    const suffix = query.length === 0 ? '' : `?${query.join('&')}`;
    return v1Envelope(await handlePetRoute(`${ROUTE_PREFIX}/${target}${suffix}`, method, body));
  };
  const V1_DO_ROUTES: Readonly<Record<string, string>> = {
    anim: 'anim',
    throw: 'throw',
    lock: 'lock',
    position: 'position',
    lyric: 'lyric',
  };
  /** `/v1/events` 是流，只由 HTTP 侧 petRouteHandler 接；这里返回 undefined 表示「不认识」。 */
  const handleV1Rest = async (
    rest: string,
    method: string,
    body?: string,
  ): Promise<RouteResult | undefined> => {
    // describe：接线表自述（有哪些输入 / 想 / 输出），给排查与外部工具看
    if (rest === 'describe') {
      return method === 'GET'
        ? { kind: 'json', status: 200, obj: { ok: true, data: registry.describe() } }
        : { kind: 'json', status: 405, obj: { ok: false, error: 'method not allowed' } };
    }
    if (rest === 'state') return method === 'GET' ? v1Forward('state', 'GET') : { kind: 'json', status: 405, obj: { ok: false, error: 'method not allowed' } };
    if (rest === 'config') return method === 'GET' || method === 'POST' ? v1Forward('config', method, body) : { kind: 'json', status: 405, obj: { ok: false, error: 'method not allowed' } };
    if (rest === 'say') return method === 'POST' ? v1Forward('say', 'POST', body) : { kind: 'json', status: 405, obj: { ok: false, error: 'method not allowed' } };
    if (rest === 'look') return method === 'POST' ? v1Forward('look', 'POST', body) : { kind: 'json', status: 405, obj: { ok: false, error: 'method not allowed' } };
    // show：只冒泡，不出声（对应内部 /broadcast 的语义）
    if (rest === 'show') return method === 'POST' ? v1Forward('broadcast', 'POST', body) : { kind: 'json', status: 405, obj: { ok: false, error: 'method not allowed' } };
    if (rest === 'do') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { ok: false, error: 'method not allowed' } };
      let kind = '';
      try {
        const parsed = JSON.parse(body ?? '{}') as { kind?: unknown };
        kind = typeof parsed.kind === 'string' ? parsed.kind : '';
      } catch {
        kind = '';
      }
      const target = V1_DO_ROUTES[kind];
      if (target === undefined) {
        return { kind: 'json', status: 400, obj: { ok: false, error: 'do.kind 只收 anim / throw / lock / position / lyric' } };
      }
      return v1Forward(target, 'POST', body);
    }
    if (rest.startsWith('media/')) {
      return method === 'GET' ? v1Forward(`thumb/${rest.slice('media/'.length)}`, 'GET') : { kind: 'json', status: 405, obj: { ok: false, error: 'method not allowed' } };
    }
    return undefined;
  };

  const petRouteHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
          // 挂起等待（/playback?wait=）期间调用方可能提前断开：据此中止等待，
          // 否则那个等待者要一直留到超时才回收。'close' 在正常应答后也会触发，但那时监听已摘掉。
          const abort = new AbortController();
          const onClose = (): void => abort.abort();
          res.on('close', onClose);
          try {
            // SSE 事件流（每 1 秒推一次变化的 state，15 秒一个心跳注释行）。
            // 【11-19】桌面壳也改吃这条：`/dsh-pet-7340/events` 与 `/state` 暴露面完全一样
            // （都是公开读），所以不用令牌；`/v1/events` 仍是要令牌的对外门面。
            const ssePath = (req.url ?? '').split('?')[0];
            if (ssePath === '/v1/events' || ssePath === `${ROUTE_PREFIX}/events`) {
              res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-store',
                connection: 'keep-alive',
                'x-accel-buffering': 'no',
              });
              let last = '';
              const lastSay = new Map<string, string>();
              const lastHint = new Map<string, string>();
              const emit = (name: string, payload: string): void => {
                if (!res.writableEnded) res.write(`event: ${name}\ndata: ${payload}\n\n`);
              };
              const push = async (): Promise<void> => {
                const state = await handlePetRoute(`${ROUTE_PREFIX}/state`, 'GET');
                if (state.kind !== 'json') return;
                const obj = state.obj as { pets?: Record<string, unknown> };
                // 明细事件：谁在说、说了什么；副气泡有哪些行。state 只推「有变化」的那一份摘要。
                const pets = obj.pets ?? {};
                // 【11-20 m31853】状态叶子是 `{counter, data}` 信封：明细要读 `data`，
                // 直接读 `pet.say.text` 永远是 undefined（say 事件永远是空文本、hint 永远是空数组）。
                const leafData = (leaf: unknown): Record<string, unknown> => {
                  if (leaf === null || typeof leaf !== 'object') return {};
                  const box = leaf as { data?: unknown };
                  const inner = box.data;
                  if (inner !== null && typeof inner === 'object') return inner as Record<string, unknown>;
                  return leaf as Record<string, unknown>;
                };
                for (const [petId, rawPet] of Object.entries(pets)) {
                  if (rawPet === null || typeof rawPet !== 'object') continue;
                  const pet = rawPet as { say?: unknown; hint?: unknown };
                  const said = leafData(pet.say);
                  const sayKey = JSON.stringify([said.text ?? '', said.image ?? '', said.duration ?? 0]);
                  if (lastSay.get(petId) !== sayKey) {
                    lastSay.set(petId, sayKey);
                    emit('say', JSON.stringify({ pet: petId, text: said.text ?? '', image: said.image, duration: said.duration }));
                  }
                  const hintItems = leafData(pet.hint).items ?? [];
                  const hintKey = JSON.stringify(hintItems);
                  if (lastHint.get(petId) !== hintKey) {
                    lastHint.set(petId, hintKey);
                    emit('hint', JSON.stringify({ pet: petId, items: hintItems }));
                  }
                }
                const text = JSON.stringify(state.obj);
                if (text === last) return;
                last = text;
                emit('state', text);
              };
              const safePush = (why: string): void => {
                void push().catch((error: unknown) => {
                  noteBubble(
                    `sse-push-fail why=${why} ${error instanceof Error ? error.message : String(error)}`,
                  );
                });
              };
              safePush('open');
              const tick = setInterval(() => {
                safePush('tick');
              }, 1_000);
              tick.unref?.();
              const beat = setInterval(() => {
                if (!res.writableEnded) res.write(': ping\n\n');
              }, 15_000);
              beat.unref?.();
              const stop = (): void => {
                clearInterval(tick);
                clearInterval(beat);
              };
              req.on('close', stop);
              res.on('close', stop);
              res.off('close', onClose);
              return;
            }
            const body = req.method === 'PUT' || req.method === 'POST' ? await readBody(req) : undefined;
            const result = await handlePetRoute(req.url ?? '/', req.method ?? 'GET', body, abort.signal);
            res.off('close', onClose);
            if (result.kind === 'json') sendJson(res, result.status, result.obj, result.headers);
            else if (result.kind === 'text') sendText(res, result.status, result.body);
            else if (result.kind === 'none') {
              /* 调用方已断开：不再写（写了会抛） */
            } else sendFile(res, result.file, result.contentType); // 非 async：流在 open 后自己 pipe，错误内部收口
          } catch (e) {
            res.off('close', onClose);
            // 连接已断（挂起等待被中止后也可能撞上）→ 不再写，避免二次抛错
            if (!res.destroyed && !res.writableEnded) {
              sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
            }
          }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: petRouteHandler }),
    'dsh-pet: /dsh-pet-7340 asset route',
  );
  // 对外门面：`/v1/say`、`/v1/state`、`/v1/look` 这些（别名，旧路由全部保留）
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/v1', handler: petRouteHandler }),
    'dsh-pet: /v1 public route',
  );

  // 工作状态联动：监听 DSH 会话事件 → 聚合"当前活动状态"（WorkStatusStore → 展示快照）。
  // 消费的事件：turn/start、user/message（goal 续跑轮判定）、tool/call（update_goal 收尾判定）、
  // tool/result、approval/asked、turn/end、todo/write（只更新任务详情文案，不切档位）。
  // 纯监听不调用模型；有宠物启用 workStatusEnabled 时才被浏览器侧消费（host 侧恒轻量监听）。
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session: unknown, event: unknown) => {
      const type = (event as { type?: string } | null)?.type;
      if (!type) return;
      const sessionId = String(
        (session as { id?: unknown; header?: { id?: unknown } } | null)?.header?.id ??
          (session as { id?: unknown } | null)?.id ??
          'unknown',
      );
      if (type === 'todo/write') {
        // 任务详情文案：只写**该会话**的条目（state/task 同源，不再有全局字段，也就不可能串会话）。
        // 会话没有活动条目（已空闲/已清理）→ 不动：它不会被展示，写进去只会成为一条"幽灵文案"。
        // 清单里再无 in_progress/pending 时 currentTaskFromTodo 返回 null，等于把旧文案清掉、
        // 气泡回落到档位文案（issue #59 缺陷 3：档位文案不该被一条历史记录永久屏蔽）。
        if (workStatus.has(sessionId)) {
          workStatus.setTask(
            sessionId,
            currentTaskFromTodo(event as { data?: { todos?: Array<{ status?: string; content?: string }> } }),
          );
          publishWorkStatus(); // 任务文案变化也要写 S（气泡内容靠它更新）
        }
        return;
      }
      if (type === 'user/message') {
        // 目标续跑轮判定：自动轮的消息带 source.kind==='goal'（round>0），该轮属自动续跑，
        // 其 turn/end completed 只是"本轮完成"，不是整个任务完成
        const source = (event as { data?: { source?: { kind?: string } } })?.data?.source;
        if (source?.kind === 'goal') {
          const flags = turnFlags.get(sessionId) ?? { goalRound: false, closing: null };
          flags.goalRound = true;
          turnFlags.set(sessionId, flags);
        }
        return; // user/message 不驱动档位动画
      }
      if (type === 'turn/start') {
        turnFlags.set(sessionId, { goalRound: false, closing: null }); // 新一轮：清 turn 级标志
        // 新一轮也开始新的任务上下文：清掉上一轮留下的任务详情文案（issue #59），否则它会一直挂着。
        // 代价：goal 续跑这类多轮任务，每轮开头会回落一瞬档位文案，直到本轮（通常在开头几步内）
        // 再写一次 todo 清单。
        workStatus.setTask(sessionId, null);
        publishWorkStatus(); // 清掉上一轮任务文案也要写 S
      }
      if (
        type === 'tool/call' &&
        String((event as { data?: { name?: unknown } })?.data?.name ?? '') === GOAL_UPDATE_TOOL
      ) {
        // update_goal complete/blocked = 本轮是该目标的收尾轮，其 completed 才是真完成
        const action = goalUpdateAction(String((event as { data?: { arguments?: unknown } })?.data?.arguments ?? ''));
        if (action) {
          const flags = turnFlags.get(sessionId) ?? { goalRound: false, closing: null };
          flags.closing = action;
          turnFlags.set(sessionId, flags);
        }
      }
      const next = reduceWorkStatus(
        event as { type?: string; data?: Record<string, unknown> & { reason?: { kind?: string } } },
        turnFlags.get(sessionId),
      );
      if (!next) {
        // turn/end 的 null（aborted / 未知 kind）＝该会话回合已结束：清掉会话状态，让展示回到空闲或
        // 落到其他活跃会话，防止回合被打断后永久卡在上一档；其他事件的 null 是"不关心"，忽略。
        if (type === 'turn/end') {
          turnFlags.delete(sessionId);
          cancelTerminalCleanup(sessionId); // 条目都要清了，别留一个到点后无事可做的定时器
          workStatus.clear(sessionId); // 条目连同任务详情文案一起消失（clear 内部会重算展示）
          publishWorkStatus(); // 回合被打断 → 回到空闲：前端据此收起常驻气泡
        }
        return;
      }
      const seq = Number((event as { seq?: unknown }).seq ?? 0);
      // 同会话同状态不重复更新（防刷屏）；不同状态才改写并重算展示
      if (!workStatus.setState(sessionId, next, seq)) return;
      publishWorkStatus(); // 档位变了 → 写 S（前端据此切动画 + 气泡）
      // 终态只展示短暂窗口后自动清理：陈旧完成态不再浮上来（Bug 3 的一环，顺带缓解 Bug 2 残留）。
      // 回到非终态则取消那次待执行的清理——否则它到点时会话已非终态，既不清也不重排，
      // 条目（连同旧任务文案）就永久留下了。
      if (next === 'success' || next === 'error') scheduleTerminalCleanup(sessionId);
      else cancelTerminalCleanup(sessionId);
    });
    return () => {
      dispose();
      for (const t of terminalTimers.values()) clearTimeout(t);
      terminalTimers.clear();
    };
  }, 'dsh-pet: work-status session events');

  // 系统通知：监听 DSH 宿主事件 → 生成通知帧入队（浏览器轮询 /state 读到后弹 toast）。
  // 与 work-status 同一 session/event 源，但职责各自独立（通知帧 = 事件 → toast 的一对一映射，
  // 不做状态聚合）。帧契约与 shared/notify.ts 完全一致，浏览器侧映射零改动。
  //   事件源：turn/end（完成/失败/截断）、approval/asked（权限申请）、
  //          tool/call（ask_user_question：用户选择）、agent/error（无回合位置失败，0.1.5 新增）。
  //   两道门：会话门 #82（shouldNotifySession：子代理/委派不发）+ 活动门 #114（只拦「对话完成」，
  //          延迟确认这条会话确实没活了再弹，见上方 scheduleCompletionNotify）。
  // 纯监听不调用模型；通知是浏览器网页端能力，桌面模式不消费本队列（不影响任何宠物行为）。
  ctx.effect(() => {
    const sessionDispose = ctx.on(
      'session/event',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (session: any, event: any) => {
        // 会话门（issue #82）：子代理 / 委派会话不发通知——你等的是父对话，不是某一路子代理跑完。
        // 判据用 header.origin（不是 parentSession，那会把普通 fork 的主对话一起静音），
        // 判据不可用时放行，绝不把通知整体打哑。详见 notify-events.ts 的 shouldNotifySession。
        if (!shouldNotifySession(session)) return;
        // 活动门（issue #114）：「对话完成」延迟确认这条会话确实没活了再弹——团队会话里 Lead 的
        // 这一轮结束 ≠ 团队收工，成员还在跑时弹「对话完成」是误报。生成失败/输出截断、权限申请、
        // 用户选择不过这道门，直接放行（理由见 notify-events.ts 的 isCompletionTurnEnd）。
        if (isCompletionTurnEnd(event)) {
          scheduleCompletionNotify(sessionIdOf(session), event);
          return;
        }
        const frame = reduceNotifyFrame(event as Parameters<typeof reduceNotifyFrame>[0]);
        // 帧带上"这条通知是哪条会话发出的"：点击时网页据此跳到那条会话（见 withSessionId）
        if (frame) pushNotifyFrame(withSessionId(frame, sessionIdOf(session)));
      },
    );
    // agent/error（agent-loop dispatch.emit）：无回合位置的生成失败；0.1.5 新增，
    // 旧版无此事件 = 少一条通知（turn/end error 分支已覆盖大部分失败场景），不报错。
    // **两道门都管不到它**：载荷只有 { turn, step, error }，不带会话标识，无从判定来源。
    const errorDispose = ctx.on(
      'agent/error',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload: any) => {
        pushNotifyFrame(agentErrorFrame(payload?.error));
      },
    );
    return () => {
      // 卸载时清掉待查的定时器：否则插件已卸载，到点还去写一次 S
      for (const t of notifyActivityTimers.values()) clearTimeout(t);
      notifyActivityTimers.clear();
      sessionDispose();
      errorDispose();
    };
  }, 'dsh-pet: notify frames');

  // /balance 斜杠命令：触发一次余额刷新（写 S → 前端 1s 轮询看到后弹气泡）。
  // fire-and-forget：回执不等外部 API（查询可能要几秒），立刻回；结果一律从 S 看
  // （成功播档位动画 + 余额气泡；服务商不支持 / 缺凭证 / 抓取失败则弹文字说明气泡，绝不静默）。
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'balance',
        description: '手动触发桌宠余额显示（立即弹出余额气泡）',
        handler: () => {
          void refreshBalance(true); // manual：命令是用户主动敲的
          return { kind: 'success', text: '已触发桌宠余额显示' };
        },
      }),
    'dsh-pet: /balance command',
  );

  // 余额周期刷新：host 侧唯一定时器（前端不再有任何余额定时器）。
  // 周期**每次重新读配置** eventsRefreshSec.balance → 改了配置下一拍自然跟上。
  // 没有任何启用余额的宠物时跳过查询：尊重配置，不白花外部 API 调用。
  ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function arm(sec: number): void {
      if (disposed) return;
      timer = setTimeout(() => void tick(), Math.max(1000, sec * 1000));
    }
    async function tick(): Promise<void> {
      let sec: number;
      try {
        const cfg = readAllConfig(configPaths);
        sec = balancePeriodSec(cfg);
        // 没有任何启用余额的宠物 → 不查（省外部调用）；配置改了下一拍自然跟上
        if (flattenPetList(cfg).some((p) => p.balanceEnabled === true)) await refreshBalance();
      } catch {
        // 读配置抛错 = 安装损坏（readAllConfig 只在**内置默认**缺失/损坏时抛，用户层写坏只会告警回退）：
        // 不再重排——每 30 分钟重试一次没有意义，而且会白占一个常驻定时器。修好安装后重启 DSH 即可。
        return;
      }
      arm(sec);
    }
    void tick(); // 启动即拉一次（与改造前客户端"先拉一次再定时"一致）
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, 'dsh-pet: balance poll');

  // 碎碎念周期：host 侧调度（前端不再有任何碎碎念定时器）。
  // 一拍 = 读一次配置 + 给"到点"的宠物各生成一句；下一拍按**最短周期**排（多数部署只有一个
  // 周期值，那它就是那个值）。用"读一次配置 + 逐宠物比对 lastWhisperAt"而不是每宠一个定时器：
  // 宠物随配置增删、周期随条目改，固定拍天然跟上，不用维护一堆定时器的生命周期。
  ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function arm(sec: number): void {
      if (disposed) return;
      timer = setTimeout(() => void tick(), Math.max(1000, sec * 1000));
    }
    function tick(): void {
      let next = 300;
      try {
        const cfg = readAllConfig(configPaths);
        const now = Date.now();
        let min = Infinity;
        for (const pet of flattenPetList(cfg)) {
          const petId = String(pet.id ?? '');
          if (!petId) continue;
          // petId 就是从**同一份 cfg** 拍平出来的，所以必然命中（findPetInstance 与 flattenPetList
          // 搜索同一集合）；查不到只可能是两者口径漂移——跳过这一拍，**不猜也不兜底 main**。
          const found = findPetInstance(cfg, petId);
          if (!found) continue;
          // 池里有货 → 只抽卡，不需要模型就绪（见 ./whisper-policy 的注释）。
          // 每读一次有 mtime 缓存，循环里调不心疼。
          const hasLocalPool = readWhisperPool(whisperPoolFile, whisperPoolCache).length > 0;
          const schedule = automaticWhisperSchedule(
            ctx.standaloneAi,
            pet.whisperEnabled === true,
            whisperPeriodSec(found.conf),
            { hasLocalPool },
          );
          if (!schedule.enabled) continue;
          const sec = schedule.periodSec;
          min = Math.min(min, sec);
          if (now - (lastWhisperAt.get(petId) ?? 0) < sec * 1000) continue;
          // 占用锁：这只宠物被占用时**跳过这一拍**——不生成也不补（碎碎念是瞬时事件，过期即弃）。
          // 而且**不推进 lastWhisperAt**：锁一放开，下一拍就该照常说。
          // 宿主侧只挡这一处 **per-pet** 来源；两个**全局段**（balance / workStatus）不在这里挡——
          // 它们所有宠物共用一份，宿主"跳过写入"会连带静音别的宠物；那两处由渲染端按宠物忽略
          // （见 src/client/pet.ts 的冻结判定），代价是叶子照常推进、渲染端自己不看。
          if (lock.locked(petId)) continue;
          lastWhisperAt.set(petId, now);
          // 不 await：生成要几秒，别把调度拍拖住（每只宠物独立生成，互不阻塞）
          void publishWhisper(petId).catch(() => {});
        }
        if (Number.isFinite(min)) next = min;
      } catch {
        // 读配置抛错 = 安装损坏（同余额定时器）：不再重排，别白占常驻句柄
        return;
      }
      arm(next);
    }
    void tick(); // 启动即生成一次（与改造前客户端首拉就生成一致）
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, 'dsh-pet: whisper poll');

  // /pet 斜杠命令：选择「当前桌宠」（/chat 对话的目标）。浏览器端另有 commandUi 装饰的选择框
  // （裸输 /pet 回车或菜单点选时弹出，选中后提交 /pet <id> 走同一 handler）；手输参数认 id 或名字
  // （name 可重复：唯一命中才认，重名报错列出候选 id）。
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'pet',
        description: '选择桌宠（/chat 对话的目标；支持选择框或手输 id/名字）',
        input: { hint: '[宠物 id 或名字]（留空查看当前）' },
        handler: ({ rawInput }: { rawInput: string }) => {
          const arg = rawInput.trim();
          let eff: Record<string, unknown>[];
          try {
            eff = effectivePetList();
          } catch {
            eff = [];
          }
          if (!arg) {
            const cur = resolveActivePetId();
            const found = eff.find((p) => String(p.id) === cur);
            return {
              kind: 'success',
              text: '当前桌宠：' + (found ? petDisplayName(found) : cur || '（无可交互桌宠）'),
            };
          }
          const byId = eff.find((p) => String(p.id) === arg);
          if (byId) {
            activePetId = String(byId.id);
            return { kind: 'success', text: '已选择桌宠：' + petDisplayName(byId) };
          }
          const byName = eff.filter((p) => petDisplayName(p) === arg);
          if (byName.length === 1) {
            activePetId = String(byName[0].id);
            return { kind: 'success', text: '已选择桌宠：' + petDisplayName(byName[0]) };
          }
          if (byName.length > 1) {
            return {
              kind: 'error',
              text:
                '「' +
                arg +
                '」有 ' +
                byName.length +
                ' 只桌宠（id：' +
                byName.map((p) => String(p.id)).join('、') +
                '），请用 id 指定',
            };
          }
          return { kind: 'error', text: '找不到桌宠「' + arg + '」（id 或名字都行；/pet 回车可打开选择框）' };
        },
      }),
    'dsh-pet: /pet command',
  );

  // /chat 斜杠命令：与当前桌宠对话。无参数 = 碎碎念一句（手动语义：不受 whisperEnabled 门控，
  // 那个字段只关自动周期）；有参数 = 正常对话（走 chatWithPet 同一条路径：记忆 + 人设 + 写盘）。
  // 两个分支都是 **fire-and-forget**：回执不等模型（生成要几秒），文本一律写进 S 的
  // pets.<id>.say，前端 1s 轮询 /state 后弹气泡——与 /balance 命令同一套语义（回执不带数据）。
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'chat',
        description: '与桌宠对话：留空 = 碎碎念一句；输入消息 = 正常对话',
        input: { hint: '[消息]（留空 = 碎碎念）' },
        handler: ({ rawInput }: { rawInput: string }) => {
          const petId = resolveActivePetId();
          if (!petId) return { kind: 'error', text: '没有可交互的桌宠' };
          const text = rawInput.trim();
          if (!text) {
            void publishWhisper(petId).catch((e: unknown) =>
              console.warn('[dsh-pet] 碎碎念异常：' + (e instanceof Error ? e.message : String(e))),
            );
            return { kind: 'success', text: '已让桌宠碎碎念一句' };
          }
          if (text.length > 2000) return { kind: 'error', text: '消息过长（限 2000 字）' };
          void chatWithPet(petId, text).then((r) => {
            if (!r.ok) {
              console.warn('[dsh-pet] 对话失败 reason=' + r.reason + (r.message ? ' ' + r.message : ''));
            }
          });
          return { kind: 'success', text: '已发送，桌宠马上回应' };
        },
      }),
    'dsh-pet: /chat command',
  );

  // 系统通知的宿主监听已在上方注册（notify frames effect）：host 监听 session/event +
  // agent/error 生成通知帧入队，浏览器轮询 /notify 拉取弹 toast（DSH 0.1.5 删除了浏览器侧
  // api.events.mux/host 事件流，通知与宠物一样改走 host 通道，两端行为一致）。

  // 随插件生命周期清理：桌面 Helper 回收（异步下载完成后不再拉起）+ **结束所有挂起的等待**
  // （回执的与 /state 长轮询的都不结束的话，插件重载会留下一批悬挂的响应，各自要等到超时才收尾）
  ctx.effect(() => () => {
    disposed = true;
    // 工作状态的补写定时器：卸载后它到点已经没有意义（叶子连同长轮询一起收尾），清掉免得挂着
    if (workFlushTimer !== null) {
      clearTimeout(workFlushTimer);
      workFlushTimer = null;
    }
    // 占用锁：卸载时把锁全撤掉并写一次叶子——不写的话渲染端要等 TTL 到点才解除静止
    // （写叶子必须在 state.cancelAll() **之前**：那之后挂起的等待者已经收尾了）。
    lock.releaseAll();
    playback.cancelAll();
    state.cancelAll();
    stopHelper('dsh-host-stop');
  });

  // 路由就绪后拉起桌面 Helper（Electron 缺失时仅告警，不影响 DSH 与浏览器 overlay）
  // 先写热键文件：壳启动时 ear.js 就会去读，晚一步就只能用默认键。
  writeHotkeysFile();
  // 再落一份碎碎念池：装完第一次启动就有句子可抽，不用等用户点「打开池子」才生成。
  seedWhisperPool();
  startHelper();
}

/**
 * 把模型吐出来的摘要切成「最多两句、每句 ≤ maxChars」。
 * 先按句末标点切；单句超长就在逗号处断（断不动才硬切），保证气泡不会被撑爆。
 */
// ---- 摘要缓存：10 分钟内同一段原文直接复用（最多 64 条，超出淘汰最久未用的）
const SUMMARY_CACHE_TTL_MS = 10 * 60_000;
const SUMMARY_CACHE_MAX = 64;
const summaryCache = new Map<string, { at: number; sentences: string[] }>();

function summaryCacheRead(key: string): string[] | undefined {
  const hit = summaryCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > SUMMARY_CACHE_TTL_MS) {
    summaryCache.delete(key);
    return undefined;
  }
  // 命中即刷新位置：Map 的迭代顺序就是最近使用顺序，删了重插就挪到队尾。
  summaryCache.delete(key);
  summaryCache.set(key, hit);
  return hit.sentences;
}

function summaryCacheWrite(key: string, sentences: string[]): void {
  summaryCache.delete(key);
  summaryCache.set(key, { at: Date.now(), sentences });
  while (summaryCache.size > SUMMARY_CACHE_MAX) {
    const oldest = summaryCache.keys().next();
    if (oldest.done) break;
    summaryCache.delete(oldest.value);
  }
}

function splitSummary(raw: string, maxChars: number): string[] {
  const cleaned = String(raw ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, '')
    .trim();
  if (cleaned === '') return [];
  const queue = cleaned
    .split(/(?<=[。！？!?；;])/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const out: string[] = [];
  for (const seg of queue) {
    if (out.length >= 2) break;
    let rest = seg.replace(/[。！？!?；;]+$/u, '').trim();
    while (rest.length > maxChars && out.length < 2) {
      const comma = Math.max(rest.lastIndexOf('，'), rest.lastIndexOf('、'), rest.lastIndexOf(','));
      const at = comma >= Math.max(8, Math.floor(maxChars * 0.4)) ? comma : maxChars;
      const head = rest.slice(0, at).trim();
      if (head !== '') out.push(head);
      rest = rest.slice(at + 1).trim();
    }
    if (rest !== '' && out.length < 2) out.push(rest);
  }
  // 哥哥 11-01：「没有正常压缩」——原来每句都剥掉句末标点，join('') 之后是「A句B句」连成一片。
  // 摘要器本来就该是一句一句的，这里补回句号（最后一句也补），念出来才有停顿。
  return out
    .slice(0, 2)
    .map((s) => (/[。！？!?…]$/u.test(s) ? s : `${s}。`));
}

/**
 * 念之前的「剪句子」：超过 maxChars 就在**句末标点**处断，实在没有标点才硬切。
 * /say-loud 用——哥哥 11-01：「原版输出不要直接发给语音」，语音只吃短句。
 */
function clipForVoice(raw: string, maxChars: number): string {
  const text = String(raw ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const cut = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('；'),
    head.lastIndexOf('，'),
  );
  if (cut >= Math.floor(maxChars * 0.4)) return head.slice(0, cut + 1).trim();
  return head.trim() + '…';
}
