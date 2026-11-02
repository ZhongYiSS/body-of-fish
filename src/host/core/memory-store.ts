/**
 * 短期记忆的文件实现（一天一个 JSON，跨零点自动切天）。
 *
 * 为什么不用数据库：一天一个文件，哥哥用记事本就能看、能改、能删；
 * 出问题最多坏当天那一个，且天然不会越攒越大（sweep 默认留 7 天）。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DIARY_MAX_CHARS,
  TURNS_MAX,
  dayKey,
  type MemoryApi,
  type MemoryTurn,
  type SessionSource,
} from './memory.ts';

interface DayFile {
  date: string;
  turns: MemoryTurn[];
  diary?: string;
}

export interface MemoryStoreOptions {
  /** 数据目录，例如 <DSH_HOME>/dsh-pet2/memory */
  dir: string;
  now?: () => number;
}

export interface MemoryStore extends MemoryApi {
  /** 清空内存里的会话来源（重连时用） */
  dispose(): void;
}

export function createMemoryStore(options: MemoryStoreOptions): MemoryStore {
  const now = options.now ?? Date.now;
  const dir = options.dir;
  let session: SessionSource | null = null;
  const cache = new Map<string, DayFile>();

  const fileOf = (key: string) => join(dir, `${key}.json`);

  async function load(key: string): Promise<DayFile> {
    const hit = cache.get(key);
    if (hit) return hit;
    try {
      const raw = await readFile(fileOf(key), 'utf8');
      const parsed = JSON.parse(raw) as Partial<DayFile>;
      const day: DayFile = {
        date: key,
        turns: Array.isArray(parsed.turns) ? parsed.turns.filter(isTurn) : [],
        ...(typeof parsed.diary === 'string' ? { diary: parsed.diary } : {}),
      };
      cache.set(key, day);
      return day;
    } catch {
      const fresh: DayFile = { date: key, turns: [] };
      cache.set(key, fresh);
      return fresh;
    }
  }

  async function save(day: DayFile): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(fileOf(day.date), JSON.stringify(day, null, 2), 'utf8');
  }

  return {
    async remember(turn) {
      const at = turn.at ?? now();
      const key = dayKey(at);
      const day = await load(key);
      const text = turn.text.trim();
      if (!text) return;
      // 连续重复的那句不重复记（模型偶尔会连说两遍一模一样的话）
      const last = day.turns[day.turns.length - 1];
      if (last && last.text === text && last.role === turn.role) return;
      day.turns.push({ role: turn.role, text, at, source: turn.source });
      if (day.turns.length > TURNS_MAX) day.turns.splice(0, day.turns.length - TURNS_MAX);
      await save(day);
    },

    async today(limit = 40) {
      const day = await load(dayKey(now()));
      return limit > 0 ? day.turns.slice(-limit) : [...day.turns];
    },

    async digest(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      const key = dayKey(now());
      const day = await load(key);
      const existing = day.diary ?? '';
      if (existing.includes(trimmed)) return;
      const next = existing ? `${existing}\n${trimmed}` : trimmed;
      day.diary = next.length > DIARY_MAX_CHARS ? next.slice(0, DIARY_MAX_CHARS) : next;
      await save(day);
    },

    async todayDiary() {
      const day = await load(dayKey(now()));
      return day.diary?.trim() ? day.diary : null;
    },

    sessionSource() {
      return session;
    },

    setSessionSource(source) {
      session = source;
    },

    async sweep(keepDays = 7) {
      const cutoff = dayKey(now() - keepDays * 86_400_000);
      let removed = 0;
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return 0;
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const key = name.slice(0, -'.json'.length);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key >= cutoff) continue;
        cache.delete(key);
        await rm(join(dir, name), { force: true });
        removed += 1;
      }
      return removed;
    },

    dispose() {
      session = null;
      cache.clear();
    },
  };
}

function isTurn(value: unknown): value is MemoryTurn {
  if (!value || typeof value !== 'object') return false;
  const t = value as Partial<MemoryTurn>;
  return (
    (t.role === 'user' || t.role === 'pet') &&
    typeof t.text === 'string' &&
    typeof t.at === 'number' &&
    (t.source === 'chat' || t.source === 'companion')
  );
}
