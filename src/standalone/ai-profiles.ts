/**
 * 模型方案（哥哥 11-11 m19534：填模型那些要能像提示词那样一页签一套、点一下整套换）。
 *
 * 一套方案 = 两块快照，切的时候一起写回去：
 *   ① `ai`：AI 设置那一整份（对话模型的协议 / 地址 / 模型 / 密钥 / 自定义头 / 开关…）；
 *   ② `model`：宠物配置里的 `model` 段（看图与声音的后端、地址、模型、密钥、发声协议）。
 *
 * 为什么是"快照整段"而不是"按字段拼"：这两块本来就各自是一份完整配置，逐字段拼一定会漏
 * （11-09 已经踩过 zod `.partial()` 把 `extraHeaders` 补成 `{}` 的坑）。整段存、整段写，
 * 切回来就是当时那一套，不会因为中间改过别的东西而走样。
 *
 * 存储：与桌宠配置同目录的 `ai-profiles.json`（不走 JSONC：这是机器写的，不给人手改）。
 * 密钥跟着方案一起存 —— 和现在 `standalone-ai.json` / `main-config.jsonc` 里的存法一致
 * （都是本机私有文件 + 600/ACL 收紧，由写入方 writePrivateJson 负责），没有额外暴露面。
 *
 * 本模块只做"纯决策 + 一次落盘"，读写外部配置全靠注入，方便在 node:test 里直接跑。
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { writePrivateJson } from './ai-storage';

export interface ModelProfile {
  id: string;
  /** 给人看的名字（页签上那几个字） */
  name: string;
  /** AI 设置那一整份（含 apiKey / extraHeaders，仅本机文件） */
  ai: Record<string, unknown>;
  /** 宠物配置的 model 段（看图 + 声音 + 对话那张描述） */
  model: Record<string, unknown>;
  /** 最后一次写回的时间（ISO），页面上显示"这套是什么时候存的" */
  savedAt: string;
}

export interface ProfileStore {
  version: 1;
  activeId: string;
  profiles: ModelProfile[];
}

export interface ProfileSnapshot {
  ai: Record<string, unknown>;
  model: Record<string, unknown>;
}

export interface ProfileServiceDeps {
  /** 方案文件（与桌宠配置同目录的 ai-profiles.json） */
  file: string;
  /** 读当前生效的两块 */
  readSnapshot(): ProfileSnapshot;
  /** 把方案里的 AI 设置写回去（异步：写盘 + 内存） */
  applyAi(ai: Record<string, unknown>): Promise<void>;
  /** 把方案里的 model 段写回宠物配置 */
  applyModel(model: Record<string, unknown>): void;
  /** 现在的时间（测试注入） */
  now?: () => Date;
  /** 新方案的 id（测试注入） */
  newId?: () => string;
}

export interface ProfileList {
  activeId: string;
  profiles: Array<{ id: string; name: string; savedAt: string }>;
}

const MAX_PROFILES = 20;
const MAX_NAME = 24;

function asDict(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 名字只留一行、去掉控制字符，最长 24 字；空则给个默认名。 */
export function cleanProfileName(raw: unknown, fallback = ''): string {
  const text = typeof raw === 'string' ? raw : '';
  const oneLine = text.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const clipped = oneLine.slice(0, MAX_NAME);
  return clipped || fallback;
}

/** 读方案文件；坏了/没有就当没有（页面上会重新开一套，不会把配置弄丢）。 */
export function readProfileStore(file: string): ProfileStore | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = asDict(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed) return undefined;
    const profiles: ModelProfile[] = [];
    for (const raw of Array.isArray(parsed.profiles) ? parsed.profiles : []) {
      const item = asDict(raw);
      if (!item) continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const ai = asDict(item.ai);
      const model = asDict(item.model);
      if (!id || !ai || !model) continue;
      profiles.push({
        id,
        name: cleanProfileName(item.name, id),
        ai,
        model,
        savedAt: typeof item.savedAt === 'string' ? item.savedAt : '',
      });
    }
    if (profiles.length === 0) return undefined;
    const activeId = typeof parsed.activeId === 'string' && profiles.some((p) => p.id === parsed.activeId)
      ? parsed.activeId
      : profiles[0].id;
    return { version: 1, activeId, profiles };
  } catch {
    return undefined;
  }
}

export function writeProfileStore(file: string, store: ProfileStore): void {
  writePrivateJson(file, store);
}

export interface ProfileService {
  /** 保证至少有一套（没有就用当前配置现开一套），返回页签数据 */
  list(): ProfileList;
  /** 切到某一套：先写 AI 设置，再写宠物配置的 model 段 */
  switchTo(id: string): Promise<ProfileList>;
  /** 把当前生效的两块存回「正在用的那一套」 */
  snapshot(): ProfileList;
  /** 用当前配置再开一套（会切到新的那套） */
  create(name?: unknown): Promise<ProfileList>;
  rename(id: string, name: unknown): ProfileList;
  /** 删掉一套；删的是正在用的那套就切到下一套（不能一套都不剩） */
  remove(id: string): Promise<ProfileList>;
}

function toList(store: ProfileStore): ProfileList {
  return {
    activeId: store.activeId,
    profiles: store.profiles.map((p) => ({ id: p.id, name: p.name, savedAt: p.savedAt })),
  };
}

export function createProfileService(deps: ProfileServiceDeps): ProfileService {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());

  const capture = (): ProfileSnapshot => {
    const snap = deps.readSnapshot();
    return { ai: snap.ai, model: snap.model };
  };

  function seed(): ProfileStore {
    const snap = capture();
    const first: ModelProfile = {
      id: newId(),
      name: '方案 1',
      ai: snap.ai,
      model: snap.model,
      savedAt: now().toISOString(),
    };
    const store: ProfileStore = { version: 1, activeId: first.id, profiles: [first] };
    writeProfileStore(deps.file, store);
    return store;
  }

  const load = (): ProfileStore => readProfileStore(deps.file) ?? seed();

  return {
    list() {
      return toList(load());
    },

    async switchTo(id: string) {
      const store = load();
      const target = store.profiles.find((p) => p.id === id);
      if (!target) throw new Error('没有这套方案');
      // 先写 AI 再写宠物配置：AI 那份写失败就当整次没切（下面的 activeId 也不动）
      await deps.applyAi(target.ai);
      deps.applyModel(target.model);
      const next = { ...store, activeId: target.id };
      writeProfileStore(deps.file, next);
      return toList(next);
    },

    snapshot() {
      const store = load();
      const snap = capture();
      const index = store.profiles.findIndex((p) => p.id === store.activeId);
      if (index < 0) return toList(seed());
      const updated: ModelProfile = {
        ...store.profiles[index],
        ai: snap.ai,
        model: snap.model,
        savedAt: now().toISOString(),
      };
      const profiles = store.profiles.slice();
      profiles[index] = updated;
      const next = { ...store, profiles };
      writeProfileStore(deps.file, next);
      return toList(next);
    },

    async create(name?: unknown) {
      const store = load();
      if (store.profiles.length >= MAX_PROFILES) throw new Error(`最多 ${MAX_PROFILES} 套方案`);
      const snap = capture();
      const created: ModelProfile = {
        id: newId(),
        name: cleanProfileName(name, `方案 ${store.profiles.length + 1}`),
        ai: snap.ai,
        model: snap.model,
        savedAt: now().toISOString(),
      };
      const next: ProfileStore = { ...store, activeId: created.id, profiles: [...store.profiles, created] };
      writeProfileStore(deps.file, next);
      return toList(next);
    },

    rename(id: string, name: unknown) {
      const store = load();
      const target = store.profiles.find((p) => p.id === id);
      if (!target) throw new Error('没有这套方案');
      const cleaned = cleanProfileName(name, target.name);
      const next: ProfileStore = {
        ...store,
        profiles: store.profiles.map((p) => (p.id === id ? { ...p, name: cleaned } : p)),
      };
      writeProfileStore(deps.file, next);
      return toList(next);
    },

    async remove(id: string) {
      const store = load();
      if (!store.profiles.some((p) => p.id === id)) throw new Error('没有这套方案');
      if (store.profiles.length <= 1) throw new Error('至少要留一套方案');
      const profiles = store.profiles.filter((p) => p.id !== id);
      const next: ProfileStore = { ...store, profiles };
      if (store.activeId === id) {
        // 删掉的是正在用的那套：切到剩下的第一套（先把它的配置写回去，不留半截状态）
        const fallback = profiles[0];
        await deps.applyAi(fallback.ai);
        deps.applyModel(fallback.model);
        next.activeId = fallback.id;
      }
      writeProfileStore(deps.file, next);
      return toList(next);
    },
  };
}
