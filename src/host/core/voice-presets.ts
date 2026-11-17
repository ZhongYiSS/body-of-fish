/**
 * 【汐儿 · 11-17 第 5 批（三/四）】嗓子四块：纯逻辑，宿主和独立版设置页共用一份。
 *
 * 四块 = 模型直连 / 本地 TTS / Windows 系统 / Edge 在线。每块一套字段存在 `voice.presets`，
 * `voice.pick` 记现在用哪块；切块只换「当前生效」的那套（写进 `model.tts`），别块的字段一个不丢。
 *
 * 为什么单独抽一份：右键菜单的「状态：嗓子」也要按四块循环（哥哥 m26051：那个才是主要入口），
 * 两处口径必须是同一份实现，否则菜单点过去、设置页看到的是另一套。
 */

export const VOICE_PICKS = ['model', 'tts', 'windows', 'edge'] as const;
export type VoicePick = (typeof VOICE_PICKS)[number];

export interface VoicePreset {
  endpoint?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  refAudioPath?: string;
  promptText?: string;
  protocol?: string;
}

/** 四块在菜单 / 气泡里的叫法。 */
export function voicePickWord(pick: VoicePick): string {
  if (pick === 'tts') return '本地 TTS';
  if (pick === 'windows') return 'Windows';
  if (pick === 'edge') return 'Edge';
  return '模型直连';
}

/** 下一块：模型直连 → 本地 TTS → Windows → Edge → 模型直连。 */
export function nextVoicePick(pick: VoicePick): VoicePick {
  const index = VOICE_PICKS.indexOf(pick);
  return VOICE_PICKS[(index + 1) % VOICE_PICKS.length] ?? 'model';
}

function asDict(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 嗓子段有两种形态：配置文件里是**扁的**（`{enabled, kind, endpoint, model, protocol}`），
 * 解析后是**嵌套的**（`{enabled, backend:{kind, endpoint, ...}}`）。这里统一取一份扁的字段。
 */
export function voiceFieldsOf(tts: unknown): VoicePreset {
  const row = asDict(tts);
  if (row === undefined) return {};
  const backend = asDict(row.backend);
  const src = backend ?? row;
  const out: VoicePreset = {};
  const put = (key: keyof VoicePreset, value: unknown): void => {
    if (typeof value === 'string' && value !== '') out[key] = value;
  };
  put('endpoint', src.endpoint);
  put('model', src.model);
  put('baseUrl', src.baseUrl);
  put('apiKey', src.apiKey);
  put('refAudioPath', src.refAudioPath);
  put('promptText', src.promptText);
  put('protocol', src.protocol);
  return out;
}

/** 只看协议反推属于哪一块（不看 voice.pick，用来判断「切之前用的是哪块」）。 */
export function pickByProtocol(tts: unknown): VoicePick {
  const protocol = voiceFieldsOf(tts).protocol;
  if (protocol === 'system') return 'windows';
  if (protocol === 'edge') return 'edge';
  if (protocol === 'sovits') return 'tts';
  return 'model';
}

/** tts 当前值拆成一套 preset（回显用）。 */
export function presetOf(tts: unknown): VoicePreset {
  return voiceFieldsOf(tts);
}

/** 当前用哪块：优先读 `voice.pick`，没有就按协议反推。 */
export function pickOf(config: unknown, tts: unknown): VoicePick {
  const stored = asDict(asDict(config)?.voice)?.pick;
  if (typeof stored === 'string' && (VOICE_PICKS as readonly string[]).includes(stored)) {
    return stored as VoicePick;
  }
  return pickByProtocol(tts);
}

/**
 * 把一套 preset 变成**配置文件形态**的 `model.tts`（扁的，和 toConfigSection 写出去的一致）。
 * 空字段不写，别把别的块的字段带过来。
 */
export function ttsFromPreset(pick: VoicePick, preset: VoicePreset): Record<string, unknown> {
  const text = (key: keyof VoicePreset): string => (preset[key] ?? '').trim();
  if (pick === 'model') {
    return {
      enabled: true,
      kind: 'remote',
      baseUrl: text('baseUrl'),
      model: text('model'),
      apiKey: text('apiKey'),
    };
  }
  if (pick === 'tts') {
    return {
      enabled: true,
      kind: 'local',
      endpoint: text('endpoint'),
      model: text('model'),
      protocol: 'sovits',
      refAudioPath: text('refAudioPath'),
      promptText: text('promptText'),
    };
  }
  // windows / edge：本机合成，不需要地址；音色名放 model
  return {
    enabled: true,
    kind: 'local',
    endpoint: '',
    model: text('model'),
    protocol: pick === 'windows' ? 'system' : 'edge',
  };
}

/**
 * 把整份配置切到 `pick` 那一块（就地返回新对象，不改入参）。
 * 顺序：先把「现在的 tts」快照回它自己那块 → 再套用要切的那块。
 */
export function applyVoicePick(config: Record<string, unknown>, pick: VoicePick): Record<string, unknown> {
  const model = asDict(config.model) ?? {};
  const voice = asDict(config.voice) ?? {};
  const live = voiceFieldsOf(model.tts);
  const previous = pickByProtocol(model.tts);
  const stored = asDict(voice.presets) ?? {};
  const presets: Record<string, VoicePreset> = {};
  for (const key of VOICE_PICKS) {
    presets[key] = (asDict(stored[key]) ?? {}) as VoicePreset;
  }
  presets[previous] = { ...live, ...(presets[previous] ?? {}) };
  const chosen = presets[pick] ?? {};
  // 切到某块但那一块还空着（第一次用）→ 至少把协议摆对，别让它带着上一块的地址
  const next = Object.keys(chosen).length > 0 ? chosen : {};
  return {
    ...config,
    model: { ...model, tts: ttsFromPreset(pick, next) },
    voice: { ...voice, pick, presets },
  };
}
