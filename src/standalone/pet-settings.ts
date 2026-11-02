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
import { parseModelConfig, toConfigSection } from '../host/core/model-config';

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

/**
 * 快捷键形状：`Mod+Key`（修饰键可多个），或单个 F1~F24 / 字母数字。
 * 只做"看起来像快捷键"的把关——真能不能注册由 Electron 说了算，注册不上 ear.js 会打日志。
 */
const HOTKEY_PATTERN = /^(?:[A-Za-z0-9]+\+)*[A-Za-z0-9]+$/;

/** 数字用整数：像素、px 字号、百分比样子的物理参数都不需要小数，省得 UI 与文件互相抖动 */
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
    whisperIntervalSec: z.number().int().min(60).max(86_400).optional(),
    // 【本鱼 · 11-02】陪伴间隔（分钟）：右键「陪伴：自定义…」的小窗用
    companionIntervalMin: z.number().int().min(1).max(1440).optional(),
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
    visionEndpoint: z.string().trim().max(512).optional(),
    visionModel: z.string().trim().max(200).optional(),
    voiceMode: z.enum(BACKENDS).optional(),
    voiceEndpoint: z.string().trim().max(512).optional(),
    voiceModel: z.string().trim().max(200).optional(),
    // 发声协议：openai = 标准 /audio/speech；sovits = GPT-SoVITS 的 GET /tts。
    // 参考音是 GSV 的命门（音色全靠这几秒），prompt_text 必须与参考音逐字一致。
    voiceProtocol: z.enum(VOICE_PROTOCOLS).optional(),
    voiceRefAudio: z.string().trim().max(512).optional(),
    voicePromptText: z.string().trim().max(500).optional(),
    // 【11-01 哥哥第 3 条】识图/声音选「云端」时，接口地址与密钥**可以单独填**，
    // 不再只能沿用对话模型那份。语义：留空 = 沿用已有值；再空 = 宿主运行期从 AI 设置补
    // （fillCloudBackend 只补空位，所以这里填了就优先）。密钥不回显，只回 has 标记。
    visionBaseUrl: z.string().trim().max(2048).optional(),
    visionApiKey: z.string().trim().max(8192).optional(),
    clearVisionApiKey: z.boolean().optional(),
    voiceBaseUrl: z.string().trim().max(2048).optional(),
    voiceApiKey: z.string().trim().max(8192).optional(),
    clearVoiceApiKey: z.boolean().optional(),
  })
  .strict();

export type PetSettingsPatch = z.infer<typeof patchSchema>;

export interface PetSettingsService {
  /** 当前值（扁平，直接给页面填表；缺省值已按宿主默认补齐） */
  getSettings(): Record<string, unknown>;
  /** 只写白名单字段；返回保存后的当前值 */
  saveSettings(input: unknown): Promise<Record<string, unknown>>;
}

const MESSAGE =
  '桌宠设置无效：请检查大小（80–1200）、边距（0–4000）、字号（4–200）、物理参数范围，以及人格文字是否过长';

export function validatePetSettings(input: unknown): PetSettingsPatch {
  const result = patchSchema.safeParse(input);
  if (!result.success) throw new Error(MESSAGE);
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
      Math.round(asInt(asDict(root.eventsRefreshSec)?.whisper, 60, 60, 86_400) / 60),
    ),
    // 秒级入口（右键菜单的小窗用）：同一个字段的原始秒数
    whisperIntervalSec: asInt(asDict(root.eventsRefreshSec)?.whisper, 60, 60, 86_400),
    // 陪伴间隔（分钟）：配置里是 companion.intervalMs（毫秒），没有就按默认 1 分钟回显
    companionIntervalMin: Math.max(1, Math.round(asInt(asDict(root.companion)?.intervalMs, 60_000, 10_000, 86_400_000) / 60_000)),
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
    voicePromptText: speakOf(modelSection.tts).promptText ?? '',
    // 云端后端自己的接口地址与密钥：地址回显（改起来方便），密钥只报"有没有"（不回显）
    visionBaseUrl: modelSection.vision.backend.kind === 'remote' ? modelSection.vision.backend.baseUrl : '',
    hasVisionKey: modelSection.vision.backend.kind === 'remote' ? Boolean(modelSection.vision.backend.apiKey) : false,
    voiceBaseUrl: modelSection.tts.backend.kind === 'remote' ? modelSection.tts.backend.baseUrl : '',
    hasVoiceKey: modelSection.tts.backend.kind === 'remote' ? Boolean(modelSection.tts.backend.apiKey) : false,
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
  // 陪伴间隔（分钟）→ companion.intervalMs（毫秒）：和右键菜单档位同一个字段
  if (patch.companionIntervalMin !== undefined) {
    const companion: Dict = { ...(asDict(next.companion) ?? {}) };
    companion.intervalMs = patch.companionIntervalMin * 60_000;
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
    const build = (
      base: (typeof current)['vision'],
      mode: (typeof BACKENDS)[number] | undefined,
      endpoint: string | undefined,
      model: string | undefined,
      baseUrl: string | undefined,
      apiKey: string | undefined,
      clearKey: boolean | undefined,
    ): (typeof current)['vision'] => {
      const nextMode = mode ?? (base.enabled ? (base.backend.kind === 'local' ? 'local' : 'remote') : 'off');
      if (nextMode === 'off') return { enabled: false, backend: { kind: 'local', endpoint: '' } };
      const backend = base.backend;
      if (nextMode === 'local') {
        const point = endpoint !== undefined ? endpoint : backend.kind === 'local' ? backend.endpoint : '';
        const name = model !== undefined ? model : backend.kind === 'session' ? '' : (backend.model ?? '');
        return { enabled: true, backend: { kind: 'local', endpoint: point, ...(name ? { model: name } : {}) } };
      }
      // 云端：地址/密钥可以单独填（哥哥 11-01 要求）；没填就沿用配置里已有的值，
      // 再没有才由宿主运行期从 AI 设置补全（见 host/index.ts 的 fillCloudBackend）。
      // 显式传空串 = 清掉（清掉后同样回落到 AI 设置那份）。
      const previous = backend.kind === 'remote' ? backend : undefined;
      const name = model !== undefined ? model : backend.kind === 'session' ? '' : (backend.model ?? '');
      const nextBaseUrl = baseUrl !== undefined ? baseUrl : (previous?.baseUrl ?? '');
      const nextApiKey =
        clearKey === true ? '' : apiKey !== undefined && apiKey !== '' ? apiKey : (previous?.apiKey ?? '');
      return {
        enabled: true,
        backend: { kind: 'remote', baseUrl: nextBaseUrl, model: name, ...(nextApiKey ? { apiKey: nextApiKey } : {}) },
      };
    };
    const vision = build(
      current.vision,
      patch.visionMode,
      patch.visionEndpoint,
      patch.visionModel,
      patch.visionBaseUrl,
      patch.visionApiKey,
      patch.clearVisionApiKey,
    );
    let tts = build(
      current.tts,
      patch.voiceMode,
      patch.voiceEndpoint,
      patch.voiceModel,
      patch.voiceBaseUrl,
      patch.voiceApiKey,
      patch.clearVoiceApiKey,
    );
    // 发声协议只挂在 tts 上；切回 openai 时把 sovits 专有字段一并丢掉（配置文件别留幽灵字段）
    const speaksTouched =
      patch.voiceProtocol !== undefined || patch.voiceRefAudio !== undefined || patch.voicePromptText !== undefined;
    if (speaksTouched && tts.backend.kind !== 'session') {
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
  };
}
