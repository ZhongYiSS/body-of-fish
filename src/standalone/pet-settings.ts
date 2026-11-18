/**
 * 独立模式的「桌宠外观与行为」设置：直接读写用户配置文件（main-config.jsonc），
 * 让不开 DSH 的用户也有网页设置页可用（浏览器端的插件设置页只在 DSH 里存在）。
 *
 * 边界：
 *   - 只改**白名单字段**（名字/大小/固定/显示位置/角落边距/锁屏/字体/物理），
 *     其余键（pets 的顺序、whisperPrompt、模型段……）原样保留；
 *   - 改的是**第一只宠物**（独立模式按约定只有一只，浏览器端也只是置灰）；
 *   - 写文件走 `writePrivateJson`（临时文件 + rename、目录允许 junction、文件不许是链接）；
 *   - 数值/枚举一律按 `src/host/config.ts` 的读取侧口径校验，避免"存得进去、读不出来"。
 */
import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

import { writePrivateJson } from './ai-storage';
import {
  VOICE_PICKS,
  applyVoicePick,
  pickOf,
  pickByProtocol as pickByProtocolOf,
  presetOf as voicePresetOf,
  ttsFromPreset,
  voiceFieldsOf,
  type VoicePick,
  type VoicePreset,
} from '../host/core/voice-presets.ts';
import { parseModelConfig, toConfigSection } from '../host/core/model-config';
import { DEFAULT_DETAIL_PROMPT, DEFAULT_WATCH_PROMPT } from '../host/game-talk';
import { DEFAULT_TUNING, normalizeTuning } from '../host/watch-mode';

/** 与 host/config.ts 的 CORNERS 同一份清单 */
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
/** 与 host/config.ts 的 PET_DISPLAYS 同一份清单 */
const DISPLAYS = ['web', 'desktop', 'both', 'none'] as const;
/** 与 host/config.ts 的 FONT_FAMILY_SET 同一份清单（src/shared/fonts.ts 的预设 id） */
const FAMILIES = ['candy', 'yahei', 'youyuan', 'kaiti', 'simsun', 'comic', 'system'] as const;

/** 与 host/core/model-config.ts 的后端种类同一份清单（session 不给选：识图/发声没有会话后端） */
const BACKENDS = ['off', 'local', 'remote'] as const;
/** 发声协议：OpenAI 兼容 / GPT-SoVITS 的 /tts / Windows 自带离线语音 / Edge 在线朗读 */
const VOICE_PROTOCOLS = ['openai', 'sovits', 'system', 'edge'] as const;
const voicePresetSchema = z
  .object({
    endpoint: z.string().trim().max(512).optional(),
    model: z.string().trim().max(200).optional(),
    baseUrl: z.string().trim().max(512).optional(),
    apiKey: z.string().trim().max(8192).optional(),
    refAudioPath: z.string().trim().max(512).optional(),
    promptText: z.string().trim().max(500).optional(),
    protocol: z.enum(VOICE_PROTOCOLS).optional(),
  })
  .strict();

/**
 * 快捷键形状：`Mod+Key`（修饰键可多个），或单个 F1~F24 / 字母数字。
 * 只做"看起来像快捷键"的把关——真能不能注册由 Electron 说了算，注册不上 ear.js 会打日志。
 */
const HOTKEY_PATTERN = /^(?:[A-Za-z0-9]+\+)*[A-Za-z0-9]+$/;

/** 数字用整数：像素、px 字号、百分比样子的物理参数都不需要小数，省得 UI 与文件互相抖动 */
/** 地址字段：空串（= 不填/沿用）或 http(s):// 开头；写错当场报错点名，不静默丢（11-19 全量测试发现过） */
const urlField = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => value === '' || /^https?:\/\/[^\s/]+/u.test(value), {
      message: '地址要写 http(s):// 开头，或者留空',
    });

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(24).optional(),
    size: z.number().int().min(80).max(1200).optional(),
    fixedEnabled: z.boolean().optional(),
    display: z.enum(DISPLAYS).optional(),
    // 【10-30 哥哥第 7 条】「显示位置」对用户来说只剩一个问题：桌面上显示 / 不显示。
    // 所以页面给一个开关（desktopVisible），写盘时换算成 display：
    // 开 = 桌面（网页原本开着就 both），关 = 网页（网页原本没开就 none）——
    // 这样网页那边的开关不会被桌面开关顺手改掉。
    desktopVisible: z.boolean().optional(),
    corner: z.enum(CORNERS).optional(),
    marginX: z.number().int().min(0).max(4000).optional(),
    marginY: z.number().int().min(0).max(4000).optional(),
    confineToScreen: z.boolean().optional(),
    fontFamily: z.enum(FAMILIES).optional(),
    fontSize: z.number().int().min(4).max(200).optional(),
    followPet: z.boolean().optional(),
    gravity: z.number().int().min(0).max(8000).optional(),
    restitution: z.number().min(0).max(1).optional(),
    groundFriction: z.number().min(0).max(50).optional(),
    ceilingBounce: z.boolean().optional(),
    throwPower: z.number().min(0.05).max(5).optional(),
    // 碎碎念总开关（实例级，跟 host/config.ts 的 pets[].whisperEnabled 同一个字段）：
    // 独立版现在碎碎念只抽本地池，但"要不要说"仍然是这只宠物自己的开关。
    whisperEnabled: z.boolean().optional(),
    // 碎碎念间隔（分钟）：写顶层 eventsRefreshSec.whisper（秒）。右键菜单与这一页改的是
    // **同一个值**——之前独立版还有一份 AI 设置里的 whisperIntervalSec，两处各说各话，
    // 改了菜单不生效（哥哥 11-01 第 4 条「有重复项」的根子就在这），现在统一到这里。
    whisperIntervalMin: z.number().int().min(1).max(1440).optional(),
    // 秒级间隔：右键菜单「碎碎念 → 自定义间隔…」走的小窗口用这个（哥哥要「能手动输入秒数」）。
    // 与上面的分钟字段写的是**同一个** eventsRefreshSec.whisper，两个入口不会打架。
    whisperIntervalSec: z.number().int().min(30).max(86_400).optional(),
    // 【本鱼 · 11-02 / 汐儿 · 11-16】看一眼间隔（秒）：右键「一眼看：自定义时间…」的小窗用。
    // 哥哥 11-16 报「写着 30–86400 秒、实际只能填分钟，最小 1 分钟」→ 统一改成秒、范围 20–600。
    companionIntervalSec: z.number().int().min(20).max(600).optional(),
    // 全局快捷键（Electron accelerator 写法）。空串 = 用默认 Alt+T / Alt+G / Alt+S。
    // 只允许 "修饰键+主键" 这种形状，别让用户把随便一串字符写进配置（写坏了热键就整组注册失败）。
    earHotkey: z.union([z.literal(''), z.string().trim().max(32).regex(HOTKEY_PATTERN, '快捷键要写成 Alt+T 这样')]).optional(),
    peekHotkey: z.union([z.literal(''), z.string().trim().max(32).regex(HOTKEY_PATTERN, '快捷键要写成 Alt+G 这样')]).optional(),
    sayHotkey: z.union([z.literal(''), z.string().trim().max(32).regex(HOTKEY_PATTERN, '快捷键要写成 Alt+S 这样')]).optional(),
    // 人格（人设提示词）：就是配置顶层/条目级的 whisperPrompt，碎碎念与对话共用同一份
    // （host 侧由 ./persona 的 composeSystemPrompt 拼装）。空串 = 清掉覆盖、回落包内默认人设。
    persona: z.string().max(4000).optional(),
    // 看图 / 声音的后端：关、本地、云端。写进配置的 model.vision / model.tts 段
    // （host/core/model-config.ts 的 parseModelConfig 读同一份）。
    // 云端 = 复用 AI 设置里的地址与密钥（host 侧运行期补全），这里只填模型名。
    visionMode: z.enum(BACKENDS).optional(),
    visionEndpoint: urlField(512).optional(),
    visionModel: z.string().trim().max(200).optional(),
    voiceMode: z.enum(BACKENDS).optional(),
    voiceEndpoint: urlField(512).optional(),
    voiceModel: z.string().trim().max(200).optional(),
    // 发声协议：openai = 标准 /audio/speech；sovits = GPT-SoVITS 的 GET /tts。
    // 参考音是 GSV 的命门（音色全靠这几秒），prompt_text 必须与参考音逐字一致。
    voiceProtocol: z.enum(VOICE_PROTOCOLS).optional(),
    voiceRefAudio: z.string().trim().max(512).optional(),
    voicePromptText: z.string().trim().max(500).optional(),
    // 【汐儿 · 11-16 m21257】取景三档 + 手动模式选的窗口
    watchMode: z.enum(['full', 'auto', 'window']).optional(),
    watchWindowHwnd: z.number().int().min(0).max(99_999_999).optional(),
    // 【汐儿 · 11-15】播放音量 0~100（只影响播放，不改合成）
    voicePick: z.enum(VOICE_PICKS).optional(),
    voicePresets: z
      .object({
        model: voicePresetSchema.optional(),
        tts: voicePresetSchema.optional(),
        windows: voicePresetSchema.optional(),
        edge: voicePresetSchema.optional(),
      })
      .strict()
      .optional(),
    voiceVolume: z.number().int().min(0).max(100).optional(),
  // 11-18（文档 9.13）：换卷字数 / 卡片注入条数 / 嘴边队列长度
  contextRollChars: z.number().int().min(800).max(20000).optional(),
  contextCardInject: z.number().int().min(1).max(20).optional(),
  mouthQueueMax: z.number().int().min(1).max(10).optional(),
    // 【汐儿 · 11-16 m21833】提示气泡：位置偏移 + 字号
    // 【汐儿 · 11-16 m22720】不要 .int()：拖气泡预览算出来的是小数（如 12.4），
    // 一个 0.4 像素的小数会把整份设置判成无效。取整由 applyPatch 做。
    /** 看图 / 声音各自的请求头（每行 Key: Value）；哥哥 11-17 m26607 */
    visionHeaders: z.string().max(4000).optional(),
    ttsHeaders: z.string().max(4000).optional(),
    hintX: z.number().finite().min(-400).max(400).optional(),
    hintY: z.number().finite().min(-400).max(400).optional(),
    hintSize: z.number().finite().min(10).max(22).optional(),
    voiceStaleSec: z.number().int().min(1).max(600).optional(),
    voiceGapMs: z.number().int().min(0).max(5000).optional(),
    // 【11-01 哥哥第 3 条】识图/声音选「云端」时，接口地址与密钥**可以单独填**，
    // 不再只能沿用对话模型那份。语义：留空 = 沿用已有值；再空 = 宿主运行期从 AI 设置补
    // （fillCloudBackend 只补空位，所以这里填了就优先）。密钥不回显，只回 has 标记。
    visionBaseUrl: urlField(2048).optional(),
    visionApiKey: z.string().trim().max(8192).optional(),
    clearVisionApiKey: z.boolean().optional(),
    voiceBaseUrl: urlField(2048).optional(),
    voiceApiKey: z.string().trim().max(8192).optional(),
    clearVoiceApiKey: z.boolean().optional(),
    // 【汐儿 · 11-10 m18312】游戏陪伴：提示词全文可改 + 突变评分/尺寸/开口闸可调。
    // 空串 = 用内置默认（页面上的「恢复默认」就是写空串以外的默认全文，两者都认）。
    watchPrompt: z.string().max(16000).optional(),
    watchDetailPrompt: z.string().max(4000).optional(),
    // 【汐儿 · 11-11 m19834】B站登录信息：看视频抓字幕用，只有这一处能填。
    subtitleSessData: z.string().trim().max(4096).optional(),
    watchCutAbs: z.number().min(1).max(255).optional(),
    watchCutSpike: z.number().min(1).max(20).optional(),
    watchCutGapSec: z.number().min(0).max(60).optional(),
    watchIntegralLight: z.number().min(0.5).max(100).optional(),
    watchStillWidth: z.number().int().min(320).max(4096).optional(),
    watchStillHeight: z.number().int().min(200).max(2560).optional(),
    watchTalkGapSec: z.number().int().min(2).max(3600).optional(),
    watchFallbackSec: z.number().int().min(10).max(36_000).optional(),
    watchCalmMinGapSec: z.number().min(1).max(3600).optional(),
    watchCalmIntegralSec: z.number().min(0.2).max(3600).optional(),
    watchCalmFloorSec: z.number().min(5).max(36_000).optional(),
    watchNormalMinGapSec: z.number().min(1).max(3600).optional(),
    watchNormalIntegralSec: z.number().min(0.2).max(3600).optional(),
    watchNormalFloorSec: z.number().min(5).max(36_000).optional(),
    watchDenseMinGapSec: z.number().min(1).max(3600).optional(),
    watchDenseIntegralSec: z.number().min(0.2).max(3600).optional(),
    watchDenseFloorSec: z.number().min(5).max(36_000).optional(),
  })
  .strict();

export type PetSettingsPatch = z.infer<typeof patchSchema>;

export interface PetSettingsService {
  /** 当前值（扁平，直接给页面填表；缺省值已按宿主默认补齐） */
  getSettings(): Record<string, unknown>;
  /** 只写白名单字段；返回保存后的当前值 */
  saveSettings(input: unknown): Promise<Record<string, unknown>>;
  /**
   * 配置里的 `model` 段原文（看图 / 声音 / 对话那张描述），仅供「模型方案」快照用。
   * 不是给页面看的：页面要的那份在 getSettings() 里已经拍平了。
   */
  readModelSection(): Record<string, unknown>;
  /** 整段写回 `model`（切方案用）；走同一套私有写盘 + 通知重开桌面小窗。 */
  applyModelSection(model: Record<string, unknown>): void;
}

const MESSAGE =
  '桌宠设置无效：请检查大小（80–1200）、边距（0–4000）、字号（4–200）、物理参数范围，以及人格文字是否过长';

export function validatePetSettings(input: unknown): PetSettingsPatch {
  const result = patchSchema.safeParse(input);
  if (!result.success) {
    // 【汐儿 · 11-16 m22720】以前只抛一句笼统话，哥哥看不出是哪个字段越界，本鱼也查了两小时。
    // 现在把出错的字段名列进提示（最多 6 个），下次一眼就能定位。
    const names = [
      ...new Set(
        result.error.issues.flatMap((issue) =>
          issue.code === 'unrecognized_keys' ? issue.keys : issue.path.map((part) => String(part)),
        ),
      ),
    ].slice(0, 6);
    const listed = names.length > 0 ? names.join('、') : '(根)';
    throw new Error(MESSAGE + '（出错的字段：' + listed + '）');
  }
  return result.data;
}

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : undefined;
}

/** 字符串取值：不是字符串就当空串（页面上显示"没填"，保存时也不会把怪东西写回去） */
function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 数字取值：不是有限数、或**越出该字段允许的范围**，都回落到默认。
 *
 * 为什么要管范围：设置页的输入框是 `<input type="number">`，浏览器只拦打字，
 * 存档文件是手写的，过去存过 999 字号也不该让页面显示一个存不回去的值
 * （页面显示的必须能原样提交，否则用户一按保存就被 zod 拒）。
 */
function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

/**
 * 整数取值：在 `asNumber` 的基础上取整。
 *
 * 为什么要取整：像素/字号/重力这些字段 zod 要求整数，手写配置里出现 580.5 时
 * 页面若显示 580.5，用户一保存就被"必须是整数"拒掉——显示值必须能原样提交。
 */
function asInt(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(asNumber(value, fallback, min, max));
}

function asBool(value: unknown, fallback: boolean): boolean {  return typeof value === 'boolean' ? value : fallback;
}

/** 页面要显示的缺省值（读不到用户文件/字段缺失时用它，与宿主默认配置一致） */
const FALLBACK = {
  name: '蓝色大肥鱼',
  size: 580,
  fixedEnabled: false,
  display: 'both',
  corner: 'top-right',
  marginX: 24,
  marginY: 100,
  confineToScreen: false,
  fontFamily: 'system',
  fontSize: 21,
  followPet: true,
  gravity: 1400,
  restitution: 0.78,
  groundFriction: 2.5,
  ceilingBounce: true,
  throwPower: 1,
  whisperEnabled: true,
} as const;

function firstPet(config: Dict | undefined): Dict | undefined {
  const pets = config?.pets;
  if (!Array.isArray(pets)) return undefined;
  return asDict(pets[0]);
}

/** 小气泡默认位置（与宿主 HINT_DEFAULT_X/Y 同一档：哥哥 11-17 定的「脑袋右边一点点」） */
const HINT_DEFAULT_X = -79;
const HINT_DEFAULT_Y = -7;

/** 把某个能力的请求头对象搓成页面多行框里的文本（`Key: Value`，一行一个） */
function headerLines(capability: { backend: { kind: string; extraHeaders?: Record<string, string> } }): string {
  const headers = capability.backend.extraHeaders;
  if (headers === undefined) return '';
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

/** 把配置文件搓成页面用的扁平视图（未知/非法值一律回落到默认，页面永远能渲染） */
export function viewOf(config: unknown): Record<string, unknown> {
  const root = asDict(config) ?? {};
  const pet = firstPet(root);
  const position = asDict(pet?.position);
  const font = asDict(root.font);
  const physics = asDict(root.physics);
  const corner = String(position?.corner ?? FALLBACK.corner);
  const display = String(pet?.display ?? FALLBACK.display);
  const family = String(font?.family ?? FALLBACK.fontFamily);
  const modelSection = parseModelConfig(root.model);
  // 游戏陪伴：调参走 normalizeTuning（唯一一份默认值在 watch-mode.ts），模板空串 = 用默认
  const watchSectionRaw = asDict(root.watch) ?? {};
  const watchTuning = normalizeTuning(watchSectionRaw.tuning as Parameters<typeof normalizeTuning>[0]);
  const watchPromptText = typeof watchSectionRaw.prompt === 'string' ? watchSectionRaw.prompt : '';
  const watchDetailText = typeof watchSectionRaw.detailPrompt === 'string' ? watchSectionRaw.detailPrompt : '';
  const modeOf = (capability: (typeof modelSection)['vision']): (typeof BACKENDS)[number] =>
    capability.enabled ? (capability.backend.kind === 'local' ? 'local' : 'remote') : 'off';
  const endpointOf = (capability: (typeof modelSection)['vision']): string =>
    capability.backend.kind === 'local' ? capability.backend.endpoint : '';
  const modelNameOf = (capability: (typeof modelSection)['vision']): string =>
    capability.backend.kind === 'session' ? '' : (capability.backend.model ?? '');
  /** 发声协议那几个字段（protocol / refAudioPath / promptText），非 tts 或会话后端时为空 */
  const speakOf = (capability: (typeof modelSection)['vision']) => {
    const backend = capability.backend;
    if (backend.kind === 'session') return {} as { protocol?: string; refAudioPath?: string; promptText?: string };
    return backend;
  };  return {
    name: typeof pet?.name === 'string' && pet.name.trim() !== '' ? pet.name : FALLBACK.name,
    size: asInt(pet?.size, FALLBACK.size, 80, 1200),
    fixedEnabled: asBool(pet?.fixedEnabled, FALLBACK.fixedEnabled),
    display: (DISPLAYS as readonly string[]).includes(display) ? display : FALLBACK.display,
    // 开关口径：桌面上现在有没有这只鱼（web/both 的网页端不受影响）
    desktopVisible: display === 'desktop' || display === 'both',
    corner: (CORNERS as readonly string[]).includes(corner) ? corner : FALLBACK.corner,
    marginX: asInt(position?.marginX, FALLBACK.marginX, 0, 4000),
    marginY: asInt(position?.marginY, FALLBACK.marginY, 0, 4000),
    confineToScreen: asBool(root.confineToScreen, FALLBACK.confineToScreen),
    fontFamily: (FAMILIES as readonly string[]).includes(family) ? family : FALLBACK.fontFamily,
    fontSize: asInt(font?.size, FALLBACK.fontSize, 4, 200),
    followPet: asBool(font?.followPet, FALLBACK.followPet),
    gravity: asInt(physics?.gravity, FALLBACK.gravity, 0, 8000),
    restitution: asNumber(physics?.restitution, FALLBACK.restitution, 0, 1),
    groundFriction: asNumber(physics?.groundFriction, FALLBACK.groundFriction, 0, 50),
    ceilingBounce: asBool(physics?.ceilingBounce, FALLBACK.ceilingBounce),
    throwPower: asNumber(physics?.throwPower, FALLBACK.throwPower, 0.05, 5),
    whisperEnabled: asBool(pet?.whisperEnabled, FALLBACK.whisperEnabled),
    // 间隔只认配置里的 eventsRefreshSec.whisper（秒）→ 换成分钟显示（页面用分钟更直观）
    whisperIntervalMin: Math.max(
      1,
      Math.round(asInt(asDict(root.eventsRefreshSec)?.whisper, 60, 30, 86_400) / 60),
    ),
    // 秒级入口（右键菜单的小窗用）：同一个字段的原始秒数
    whisperIntervalSec: asInt(asDict(root.eventsRefreshSec)?.whisper, 60, 30, 86_400),
    // 陪伴间隔（秒）：配置里是 companion.intervalMs（毫秒），没有就按默认 60 秒回显。
    // 【汐儿 · 11-16】老配置存过分钟级的大数（比如一小时 = 3_600_000），asInt 越界会直接回退成默认值、
    // 界面就显示 1 分钟；这里改成「读出来再夹进 20–600」，让界面和真实值差得别太离谱。
    companionIntervalSec: (() => {
      const rawMs = asDict(root.companion)?.intervalMs;
      const ms = typeof rawMs === 'number' && Number.isFinite(rawMs) && rawMs > 0 ? rawMs : 60_000;
      return Math.max(20, Math.min(600, Math.round(ms / 1000)));
    })(),
    // 快捷键：读不到就是空串（= 用默认），页面上显示成空让哥哥知道"没改过"
    earHotkey: asText(asDict(root.hotkeys)?.earHotkey),
    peekHotkey: asText(asDict(root.hotkeys)?.peekHotkey),
    sayHotkey: asText(asDict(root.hotkeys)?.sayHotkey),
    // 看图 / 声音：显示真实生效的后端（关 / 本地 / 云端），与状态气泡同一口径
    visionMode: modeOf(modelSection.vision),
    visionEndpoint: endpointOf(modelSection.vision),
    visionModel: modelNameOf(modelSection.vision),
    voiceMode: modeOf(modelSection.tts),
    voiceEndpoint: endpointOf(modelSection.tts),
    voiceModel: modelNameOf(modelSection.tts),
    // 发声协议 / 参考音：协议原样回显（system/edge 也要显示对，否则页面会把它们写成 openai）
    voiceProtocol: ((): string => {
      const protocol = speakOf(modelSection.tts).protocol;
      return protocol === 'sovits' || protocol === 'system' || protocol === 'edge' ? protocol : 'openai';
    })(),
    voiceRefAudio: speakOf(modelSection.tts).refAudioPath ?? '',
    voiceVolume: asInt(asDict(root.voice)?.volume, 100, 0, 100),
    contextRollChars: asInt(asDict(root.context)?.rollChars, 5000, 800, 20000),
    contextCardInject: asInt(asDict(root.context)?.cardInject, 5, 1, 20),
    mouthQueueMax: asInt(asDict(root.mouth)?.queueMax, 3, 1, 10),
    // 【11-17】嗓子四块：当前用哪块 + 四块各自的字段（切页签时页面不用再问服务器）
    voicePick: pickOf(root, modelSection.tts),
    voicePresets: (() => {
      const stored = asDict(asDict(root.voice)?.presets);
      const current = voicePresetOf(modelSection.tts);
      const pick = pickOf(root, modelSection.tts);
      const out: Record<string, VoicePreset> = {};
      for (const key of VOICE_PICKS) {
        const saved = asDict(stored?.[key]) as VoicePreset | undefined;
        out[key] = key === pick ? { ...(saved ?? {}), ...current } : (saved ?? {});
      }
      return out;
    })(),
    visionHeaders: headerLines(modelSection.vision),
    ttsHeaders: headerLines(modelSection.tts),
    hintX: asInt(asDict(root.hint)?.x, HINT_DEFAULT_X, -400, 400),
    hintY: asInt(asDict(root.hint)?.y, HINT_DEFAULT_Y, -400, 400),
    hintSize: asInt(asDict(root.hint)?.size, 15, 10, 22),
    voiceStaleSec: asInt(asDict(root.voice)?.staleSec, 15, 1, 600),
    voiceGapMs: asInt(asDict(root.voice)?.gapMs, 500, 0, 5000),
    voicePromptText: speakOf(modelSection.tts).promptText ?? '',
    // 云端后端自己的接口地址与密钥：地址回显（改起来方便），密钥只报"有没有"（不回显）
    visionBaseUrl: modelSection.vision.backend.kind === 'remote' ? modelSection.vision.backend.baseUrl : '',
    hasVisionKey: modelSection.vision.backend.kind === 'remote' ? Boolean(modelSection.vision.backend.apiKey) : false,
    voiceBaseUrl: modelSection.tts.backend.kind === 'remote' ? modelSection.tts.backend.baseUrl : '',
    hasVoiceKey: modelSection.tts.backend.kind === 'remote' ? Boolean(modelSection.tts.backend.apiKey) : false,
    // 游戏陪伴（哥哥 m18312）：提示词 + 突变评分 + 开口闸回显；默认值一起送，页面「恢复默认」不用另请求
    watchPrompt: watchPromptText,
    watchDetailPrompt: watchDetailText,
    // 取景三档 + 手动模式选的窗口（11-16 m21257）
    watchMode: ((): string => {
      const value = watchSectionRaw.mode;
      return value === 'full' || value === 'window' ? value : 'auto';
    })(),
    watchWindowHwnd: asInt(watchSectionRaw.windowHwnd, 0, 0, 99_999_999),
    // 识图与说话合成一次（默认开，11-16 m21452）：放在 model 段顶层，不属于任何一项能力
    // B站 SESSDATA：回显（本地配置，不往外发），没填就是空串
    subtitleSessData: (() => {
      const section = asDict(root.subtitle);
      const value = section?.sessData;
      return typeof value === 'string' ? value : '';
    })(),
    watchPromptDefault: DEFAULT_WATCH_PROMPT,
    watchDetailPromptDefault: DEFAULT_DETAIL_PROMPT,
    watchTuningDefault: DEFAULT_TUNING,
    watchCutAbs: watchTuning.cutAbs,
    watchCutSpike: watchTuning.cutSpike,
    watchCutGapSec: watchTuning.cutMinGapSec,
    watchIntegralLight: watchTuning.integralLight,
    watchStillWidth: watchTuning.stillWidth,
    watchStillHeight: watchTuning.stillHeight,
    watchTalkGapSec: asInt(watchSectionRaw.talkGapSec, 45, 2, 3600),
    watchFallbackSec: asInt(watchSectionRaw.fallbackSec, 180, 10, 36_000),
    watchCalmMinGapSec: watchTuning.paces.calm.minGapSec,
    watchCalmIntegralSec: watchTuning.paces.calm.integralSec,
    watchCalmFloorSec: watchTuning.paces.calm.floorSec,
    watchNormalMinGapSec: watchTuning.paces.normal.minGapSec,
    watchNormalIntegralSec: watchTuning.paces.normal.integralSec,
    watchNormalFloorSec: watchTuning.paces.normal.floorSec,
    watchDenseMinGapSec: watchTuning.paces.dense.minGapSec,
    watchDenseIntegralSec: watchTuning.paces.dense.integralSec,
    watchDenseFloorSec: watchTuning.paces.dense.floorSec,
    // 人格：实例级覆盖优先，没写就用条目（顶层）那份 —— 与 host 侧 ./persona 的 petPersona 同口径
    persona:
      typeof pet?.whisperPrompt === 'string' && pet.whisperPrompt.trim() !== ''
        ? pet.whisperPrompt
        : typeof root.whisperPrompt === 'string'
          ? root.whisperPrompt
          : '',
  };
}

/** 只改白名单字段，其余原样保留（含 pets 里其他条目、注释型键、未识别的第三方键） */
export function applyPatch(config: Dict, patch: PetSettingsPatch): Dict {
  const next: Dict = { ...config };
  // 改补丁之前的「当前嗓子块」：后面要把 live 存回它自己那一块（11-19：原来用重建后的值反推，
  // 页面上一改字段就被存进了隔壁块）
  const pickBefore = pickOf(next, asDict(next.model)?.tts);
  // 改补丁之前那份真值：纯换块时要把它存回旧块（重建后的 model.tts 已经是新块的值了）
  const liveBefore = voicePresetOf(asDict(next.model)?.tts);
  // 看图 / 声音各自的请求头（哥哥 11-17 m26607）：只对那个能力生效，写进 model.<能力>.extraHeaders
  const headerPatch = (raw: string | undefined): Record<string, string> | undefined => {
    if (raw === undefined) return undefined;
    const map: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/u)) {
      const at = line.indexOf(':');
      if (at <= 0) continue;
      const key = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      if (key === '' || value === '') continue;
      map[key] = value;
    }
    return map;
  };
  const visionHeaders = headerPatch(patch.visionHeaders);
  const ttsHeaders = headerPatch(patch.ttsHeaders);
  // 11-19 全量测试：请求头存在 model.<cap>.backend.extraHeaders（parseModelConfig 与页面回显都读这里），
  // 原来写到了能力顶层 → 存进去就消失。这里只算值，真正并进 backend 在下面 touchesModel 里做。
  const withHeaders = <T extends { backend: object }>(cap: T, headers: Record<string, string> | undefined): T =>
    headers === undefined ? cap : { ...cap, backend: { ...cap.backend, extraHeaders: headers } };
  const pets = Array.isArray(config.pets) ? [...(config.pets as unknown[])] : [];
  const pet: Dict = { ...(asDict(pets[0]) ?? {}) };
  pet.id = typeof pet.id === 'string' && pet.id !== '' ? pet.id : 'main';

  if (patch.name !== undefined) pet.name = patch.name;
  if (patch.size !== undefined) pet.size = patch.size;
  if (patch.fixedEnabled !== undefined) pet.fixedEnabled = patch.fixedEnabled;
  if (patch.display !== undefined) pet.display = patch.display;
  // 开关 → display：开 = 桌面（网页原本开着就 both），关 = 网页（网页原本没开就 none）
  if (patch.desktopVisible !== undefined) {
    const current = typeof pet.display === 'string' ? pet.display : FALLBACK.display;
    pet.display = patch.desktopVisible ? (current === 'web' || current === 'both' ? 'both' : 'desktop') : current === 'both' ? 'web' : 'none';
  }
  if (patch.whisperEnabled !== undefined) pet.whisperEnabled = patch.whisperEnabled;
  // 间隔写顶层 eventsRefreshSec.whisper（秒）：与右键菜单的「碎碎念：N 分钟」同一个字段
  if (patch.whisperIntervalMin !== undefined) {
    const events: Dict = { ...(asDict(next.eventsRefreshSec) ?? {}) };
    events.whisper = patch.whisperIntervalMin * 60;
    next.eventsRefreshSec = events;
  }
  // 秒级入口（右键菜单的自定义间隔小窗）：后写优先，和上面同一字段
  if (patch.whisperIntervalSec !== undefined) {
    const events: Dict = { ...(asDict(next.eventsRefreshSec) ?? {}) };
    events.whisper = patch.whisperIntervalSec;
    next.eventsRefreshSec = events;
  }
  // 陪伴间隔（秒）→ companion.intervalMs（毫秒）：和右键菜单档位同一个字段
  if (patch.companionIntervalSec !== undefined) {
    const companion: Dict = { ...(asDict(next.companion) ?? {}) };
    companion.intervalMs = patch.companionIntervalSec * 1000;
    next.companion = companion;
  }
  // 快捷键：写顶层 hotkeys 段。空串 = 删掉这个键，让 ear.js 用它的默认值
  // （默认值留在壳里而不是写进配置：以后换默认键时不会跟用户旧配置打架）。
  if (patch.earHotkey !== undefined || patch.peekHotkey !== undefined || patch.sayHotkey !== undefined) {
    const hotkeys: Dict = { ...(asDict(next.hotkeys) ?? {}) };
    for (const key of ['earHotkey', 'peekHotkey', 'sayHotkey'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value.trim() === '') delete hotkeys[key];
      else hotkeys[key] = value.trim();
    }
    next.hotkeys = hotkeys;
  }
  // 清空就删掉这个键 → 自动回落到条目级/包内默认人设，不用用户自己去改配置文件。
  if (patch.persona !== undefined) {
    const persona = patch.persona.trim();
    if (persona === '') delete pet.whisperPrompt;
    else pet.whisperPrompt = persona;
  }
  if (patch.corner !== undefined || patch.marginX !== undefined || patch.marginY !== undefined) {
    const position: Dict = { ...(asDict(pet.position) ?? {}) };
    if (patch.corner !== undefined) position.corner = patch.corner;
    if (patch.marginX !== undefined) position.marginX = patch.marginX;
    if (patch.marginY !== undefined) position.marginY = patch.marginY;
    pet.position = position;
  }
  pets[0] = pet;
  next.pets = pets;

  if (patch.confineToScreen !== undefined) next.confineToScreen = patch.confineToScreen;

  if (patch.fontFamily !== undefined || patch.fontSize !== undefined || patch.followPet !== undefined) {
    const font: Dict = { ...(asDict(config.font) ?? {}) };
    if (patch.fontFamily !== undefined) font.family = patch.fontFamily;
    if (patch.fontSize !== undefined) font.size = patch.fontSize;
    if (patch.followPet !== undefined) font.followPet = patch.followPet;
    next.font = font;
  }

  const physicsKeys = ['gravity', 'restitution', 'groundFriction', 'ceilingBounce', 'throwPower'] as const;
  if (physicsKeys.some((key) => patch[key] !== undefined)) {
    const physics: Dict = { ...(asDict(config.physics) ?? {}) };
    for (const key of physicsKeys) {
      const value = patch[key];
      if (value !== undefined) physics[key] = value;
    }
    next.physics = physics;
  }
  // 看图 / 声音：只改 model 段里对应的一项，chat 与另一项原样搬过去（toConfigSection 会写全三项，
  // 所以必须先解析出完整配置再改 —— 直接手拼 model 段会把 chat 的 key 冲掉）。
  const touchesModel = [
    // 11-19：只改会话头也要走这一段，否则整块被跳过
    'visionHeaders',
    'ttsHeaders',
    'visionMode',
    'visionEndpoint',
    'visionModel',
    'visionBaseUrl',
    'visionApiKey',
    'clearVisionApiKey',
    'voiceMode',
    'voiceEndpoint',
    'voiceModel',
    'voiceBaseUrl',
    'voiceApiKey',
    'clearVoiceApiKey',
    'voiceProtocol',
    'voiceRefAudio',
    'voicePromptText',
  ].some((key) => patch[key as keyof PetSettingsPatch] !== undefined);
  if (touchesModel) {
    const current = parseModelConfig(next.model);
    // 能力自带请求头存在 backend.extraHeaders（remote 才有）；这里安全取出来再带进重建后的 backend
    const keptHeaders = (backend: object): Record<string, string> | undefined => {
      const raw = (backend as { extraHeaders?: unknown }).extraHeaders;
      if (raw === null || typeof raw !== 'object') return undefined;
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    };
    const build = (
      base: (typeof current)['vision'],
      mode: (typeof BACKENDS)[number] | undefined,
      endpoint: string | undefined,
      model: string | undefined,
      baseUrl: string | undefined,
      apiKey: string | undefined,
      clearKey: boolean | undefined,
    ): (typeof current)['vision'] => {
      const kept = keptHeaders(base.backend);
      const nextMode = mode ?? (base.enabled ? (base.backend.kind === 'local' ? 'local' : 'remote') : 'off');
      if (nextMode === 'off') {
        // 关掉这一项也要留住会话头：设置页允许先填、以后打开直接用（11-19）
        return { enabled: false, backend: { kind: 'local', endpoint: '', ...(kept !== undefined ? { extraHeaders: kept } : {}) } };
      }
      const backend = base.backend;
      if (nextMode === 'local') {
        // 空串 = 没填，不是"清掉"：本地后端没有地址就是哑的（11-16 声音丢失事故）
        const fallbackPoint = backend.kind === 'local' ? backend.endpoint : '';
        const typed = endpoint !== undefined ? endpoint.trim() : undefined;
        const point = typed !== undefined && typed !== '' ? typed : fallbackPoint;
        const name = model !== undefined ? model : backend.kind === 'session' ? '' : (backend.model ?? '');
        return {
          enabled: true,
          backend: {
            kind: 'local',
            endpoint: point,
            ...(name ? { model: name } : {}),
            ...(kept !== undefined ? { extraHeaders: kept } : {}),
          },
        };
      }
      // 云端：地址/密钥可以单独填（哥哥 11-01 要求）；没填就沿用配置里已有的值，
      // 再没有才由宿主运行期从 AI 设置补全（见 host/index.ts 的 fillCloudBackend）。
      // 显式传空串 = 清掉（清掉后同样回落到 AI 设置那份）。
      const previous = backend.kind === 'remote' ? backend : undefined;
      // 11-18（文档 9.13）：**空串=没改**，与密钥同口径——切来切去不该把已经填好的地址冲掉；
      // 真要清空，走单独的「清掉密钥」那种显式动作，别靠提交空框。
      const typedModel = model !== undefined ? model.trim() : undefined;
      const name =
        typedModel !== undefined && typedModel !== ''
          ? typedModel
          : backend.kind === 'session'
            ? ''
            : (backend.model ?? '');
      const typedUrl = baseUrl !== undefined ? baseUrl.trim() : undefined;
      const nextBaseUrl = typedUrl !== undefined && typedUrl !== '' ? typedUrl : (previous?.baseUrl ?? '');
      const nextApiKey =
        clearKey === true ? '' : apiKey !== undefined && apiKey !== '' ? apiKey : (previous?.apiKey ?? '');
      return {
        enabled: true,
        backend: {
          kind: 'remote',
          baseUrl: nextBaseUrl,
          model: name,
          ...(nextApiKey ? { apiKey: nextApiKey } : {}),
          ...(kept !== undefined ? { extraHeaders: kept } : {}),
        },
      };
    };
    const vision = build(
      withHeaders(current.vision, visionHeaders),
      patch.visionMode,
      patch.visionEndpoint,
      patch.visionModel,
      patch.visionBaseUrl,
      patch.visionApiKey,
      patch.clearVisionApiKey,
    );
    let tts = build(
      withHeaders(current.tts, ttsHeaders),
      patch.voiceMode,
      patch.voiceEndpoint,
      patch.voiceModel,
      patch.voiceBaseUrl,
      patch.voiceApiKey,
      patch.clearVoiceApiKey,
    );
    // 发声协议只挂在 tts 上；切回 openai 时把 sovits 专有字段一并丢掉（配置文件别留幽灵字段）。
    // 不论这次有没有显式传协议，都要把旧协议带过来——否则一次普通保存就会把 protocol 抹掉，
    // 嗓子被判"没配好"而只出字不出声（11-16 声音丢失事故）。
    if (tts.backend.kind !== 'session') {
      const oldBackend = current.tts.backend.kind === 'session' ? undefined : current.tts.backend;
      const protocol = patch.voiceProtocol ?? oldBackend?.protocol;
      const keep = (value: string | undefined, fallback: string | undefined): string =>
        (value !== undefined ? value : fallback) ?? '';
      tts = {
        enabled: tts.enabled,
        backend: {
          ...tts.backend,
          ...(protocol === 'sovits' || protocol === 'system' || protocol === 'edge' ? { protocol } : {}),
          refAudioPath: keep(patch.voiceRefAudio, oldBackend?.refAudioPath),
          promptText: keep(patch.voicePromptText, oldBackend?.promptText),
          ...(oldBackend?.promptLang ? { promptLang: oldBackend.promptLang } : {}),
          ...(oldBackend?.textLang ? { textLang: oldBackend.textLang } : {}),
          ...(oldBackend?.speedFactor !== undefined ? { speedFactor: oldBackend.speedFactor } : {}),
        },
      };
    }
    next.model = toConfigSection({ chat: current.chat, vision, tts });
  }
  // 游戏陪伴（哥哥 m18312）：只写显式传进来的字段，其余原样保留
  // 字幕登录信息：单独一段，不跟 watch 混（m19834）
  if (patch.subtitleSessData !== undefined) {
    next.subtitle = { ...(asDict(next.subtitle) ?? {}), sessData: patch.subtitleSessData.trim() };
  }
  // 播放音量：单独一段 voice（与嗓子后端 model.tts 分开，m20700）
  if (patch.voiceVolume !== undefined || patch.voiceStaleSec !== undefined || patch.voiceGapMs !== undefined) {
    const merged = { ...(asDict(next.voice) ?? {}) };
    if (patch.voiceVolume !== undefined) merged.volume = Math.min(100, Math.max(0, Math.round(patch.voiceVolume)));
    if (patch.voiceStaleSec !== undefined) {
      merged.staleSec = Math.min(600, Math.max(1, Math.round(patch.voiceStaleSec)));
    }
    if (patch.voiceGapMs !== undefined) merged.gapMs = Math.min(5000, Math.max(0, Math.round(patch.voiceGapMs)));
    next.voice = merged;
  }
  // 换卷字数 / 卡片注入 / 嘴边队列（11-18，文档 9.13）
  if (patch.contextRollChars !== undefined || patch.contextCardInject !== undefined) {
    const merged = { ...(asDict(next.context) ?? {}) };
    if (patch.contextRollChars !== undefined) {
      merged.rollChars = Math.min(20000, Math.max(800, Math.round(patch.contextRollChars)));
    }
    if (patch.contextCardInject !== undefined) {
      merged.cardInject = Math.min(20, Math.max(1, Math.round(patch.contextCardInject)));
    }
    next.context = merged;
  }
  if (patch.mouthQueueMax !== undefined) {
    next.mouth = {
      ...(asDict(next.mouth) ?? {}),
      queueMax: Math.min(10, Math.max(1, Math.round(patch.mouthQueueMax))),
    };
  }
  // 提示气泡的位置与字号（单独一段 hint，m21833）
  if (patch.hintX !== undefined || patch.hintY !== undefined || patch.hintSize !== undefined) {
    const merged = { ...(asDict(next.hint) ?? {}) };
    if (patch.hintX !== undefined) merged.x = Math.min(400, Math.max(-400, Math.round(patch.hintX)));
    if (patch.hintY !== undefined) merged.y = Math.min(400, Math.max(-400, Math.round(patch.hintY)));
    if (patch.hintSize !== undefined) merged.size = Math.min(22, Math.max(10, Math.round(patch.hintSize)));
    next.hint = merged;
  }
  const watchPatchTouched = [
    // 11-19 全量测试：取景档位与窗口句柄原来不在名单里 → 校验通过却被静默丢掉（设置页改了不生效）
    patch.watchMode, patch.watchWindowHwnd,
    patch.watchPrompt, patch.watchDetailPrompt, patch.watchCutAbs, patch.watchCutSpike,
    patch.watchCutGapSec, patch.watchIntegralLight,
    patch.watchStillWidth, patch.watchStillHeight,
    patch.watchTalkGapSec, patch.watchFallbackSec,
    patch.watchCalmMinGapSec, patch.watchCalmIntegralSec, patch.watchCalmFloorSec,
    patch.watchNormalMinGapSec, patch.watchNormalIntegralSec, patch.watchNormalFloorSec,
    patch.watchDenseMinGapSec, patch.watchDenseIntegralSec, patch.watchDenseFloorSec,
  ].some((value) => value !== undefined);
  if (watchPatchTouched) {
    const watch: Dict = { ...(asDict(next.watch) ?? {}) };
    const tuning: Dict = { ...(asDict(watch.tuning) ?? {}) };
    const paces: Dict = {
      calm: { ...(asDict(asDict(tuning.paces)?.calm) ?? {}) },
      normal: { ...(asDict(asDict(tuning.paces)?.normal) ?? {}) },
      dense: { ...(asDict(asDict(tuning.paces)?.dense) ?? {}) },
    };
    const setNum = (key: string, value: number | undefined): void => {
      if (value !== undefined) tuning[key] = value;
    };
    setNum("cutAbs", patch.watchCutAbs);
    setNum("cutSpike", patch.watchCutSpike);
    setNum("cutMinGapSec", patch.watchCutGapSec);
    setNum("integralLight", patch.watchIntegralLight);
    setNum("stillWidth", patch.watchStillWidth);
    setNum("stillHeight", patch.watchStillHeight);
    const setPace = (which: "calm" | "normal" | "dense", key: string, value: number | undefined): void => {
      if (value === undefined) return;
      paces[which] = { ...(asDict(paces[which]) ?? {}), [key]: value };
    };
    setPace("calm", "minGapSec", patch.watchCalmMinGapSec);
    setPace("calm", "integralSec", patch.watchCalmIntegralSec);
    setPace("calm", "floorSec", patch.watchCalmFloorSec);
    setPace("normal", "minGapSec", patch.watchNormalMinGapSec);
    setPace("normal", "integralSec", patch.watchNormalIntegralSec);
    setPace("normal", "floorSec", patch.watchNormalFloorSec);
    setPace("dense", "minGapSec", patch.watchDenseMinGapSec);
    setPace("dense", "integralSec", patch.watchDenseIntegralSec);
    setPace("dense", "floorSec", patch.watchDenseFloorSec);
    if (Object.keys(paces.calm as Dict).length + Object.keys(paces.normal as Dict).length + Object.keys(paces.dense as Dict).length > 0) {
      tuning.paces = paces;
    }
    if (Object.keys(tuning).length > 0) watch.tuning = tuning;
    if (patch.watchPrompt !== undefined) watch.prompt = patch.watchPrompt;
    if (patch.watchDetailPrompt !== undefined) watch.detailPrompt = patch.watchDetailPrompt;
    if (patch.watchTalkGapSec !== undefined) watch.talkGapSec = patch.watchTalkGapSec;
    if (patch.watchFallbackSec !== undefined) watch.fallbackSec = patch.watchFallbackSec;
    if (patch.watchMode !== undefined) watch.mode = patch.watchMode;
    if (patch.watchWindowHwnd !== undefined) watch.windowHwnd = patch.watchWindowHwnd;
    next.watch = watch;
  }
  // 识图与说话合成一次：写在 model 段顶层（11-16 m21452）
  // 【汐儿 · 11-17 第 5 批（三）】嗓子四块：把四套字段存进 voice.presets，并把选中的那套套进 model.tts。
  //   放在最后，保证它压过上面按 voiceMode/voiceProtocol 重建出来的那份（老字段继续兼容）。
  if (patch.voicePick !== undefined || patch.voicePresets !== undefined) {
    const voice = { ...(asDict(next.voice) ?? {}) };
    const pick: VoicePick = patch.voicePick ?? pickOf(next, asDict(next.model)?.tts);
    const stored = asDict(voice.presets) ?? {};
    const merged: Record<string, VoicePreset> = {};
    for (const key of VOICE_PICKS) merged[key] = (asDict(stored[key]) ?? {}) as VoicePreset;
    const previous = pickBefore;
    const live = voicePresetOf(asDict(next.model)?.tts);
    // 这次补丁有没有直接改嗓子字段（地址/模型/参考音/提示词/协议）——有就说明 live 属于**新选中那块**
    const ttsEdited = [
      patch.voiceMode,
      patch.voiceEndpoint,
      patch.voiceModel,
      patch.voiceBaseUrl,
      patch.voiceApiKey,
      patch.clearVoiceApiKey,
      patch.voiceProtocol,
      patch.voiceRefAudio,
      patch.voicePromptText,
    ].some((value) => value !== undefined);
    // 优先级固定成：这次显式传的 presets > 刚按补丁重建的 live > 老存档。
    // 11-19 全量测试查出两处反了：①切走时旧存档压过 live（改完一切档位就弹回）
    // ②选中那一块用 live 压住 incoming（页面上填的新值存不进去）。
    if (patch.voicePresets !== undefined) {
      for (const key of VOICE_PICKS) {
        const incoming = patch.voicePresets[key];
        if (incoming !== undefined) merged[key] = { ...(merged[key] ?? {}), ...incoming } as VoicePreset;
      }
    }
    const incomingPick = patch.voicePresets?.[pick];
    if (previous !== pick && !ttsEdited) {
      // 纯换块：把当前这套（live）存进它自己那一块，新选中的那块用存档 + 这次显式传的字段。
      // live 只属于 previous，绝不能拿来覆盖新块（否则切回 tts 会带上 system 的字段）。
      merged[previous] = { ...(merged[previous] ?? {}), ...liveBefore };
      merged[pick] = { ...(merged[pick] ?? {}), ...(incomingPick ?? {}) };
    } else if (previous !== pick) {
      // 换块同时又改了字段：改动属于**新选中的那块**（页面上填的就是这一页）
      merged[pick] = { ...(merged[pick] ?? {}), ...live, ...(incomingPick ?? {}) };
    } else {
      merged[pick] = { ...(merged[pick] ?? {}), ...live, ...(incomingPick ?? {}) };
    }
    const modelSection = { ...(asDict(next.model) ?? {}) };
    modelSection.tts = ttsFromPreset(pick, merged[pick]);
    next.model = modelSection as typeof next.model;
    next.voice = { ...voice, pick, presets: merged };
  }
  return next;
}

function readConfig(file: string): Dict {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  const parsed: unknown = JSON.parse(text);
  return asDict(parsed) ?? {};
}

export function createPetSettingsService(file: string, onChange?: () => void): PetSettingsService {
  const read = (): Dict => {
    try {
      return readConfig(file);
    } catch {
      // 用户手改坏了：页面仍要能打开（显示默认值），保存时再整体覆盖成合法内容
      return {};
    }
  };
  return {
    getSettings() {
      return viewOf(read());
    },
    async saveSettings(input: unknown) {
      const patch = validatePetSettings(input);
      const next = applyPatch(read(), patch);
      writePrivateJson(file, next);
      onChange?.();
      return viewOf(next);
    },
    readModelSection() {
      // 读不出来（文件坏了）就给空对象，别让"存方案"这一步把页面卡死
      const model = asDict(read().model);
      return model ? { ...model } : {};
    },
    applyModelSection(model: Record<string, unknown>) {
      const next = read();
      next.model = { ...model };
      writePrivateJson(file, next);
      onChange?.();
    },
  };
}
