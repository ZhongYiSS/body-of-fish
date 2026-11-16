import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
/**
 * 保留策略：截图与日志不该无限长。
 *
 * 为什么单独一个模块（11-16 体检）：
 *  `D:\AI\身体\数据\logs\陪伴` 一天就能攒到 279MB / 235 张 PNG —— 原来的 pruneWatchSheets 只按
 *  「24 小时」删，而陪伴开一整天，24 小时内的量本身就够大；而且它只在**保存新截图时**才跑，
 *  陪伴关着的时候旧图永远不动。日志 jsonl 则是完全不删。
 *
 * 这里只做两件纯事：
 *   1. planRetention：给一批 {name,size,mtimeMs}，算出该删哪些（先按天数、再按总字节，从最老的删）。
 *   2. pruneDir：按计划真删（失败只记一笔，绝不抛）。
 * 决策与执行分开，是为了让「删哪些」能被测试钉住——删文件这种事不该只靠肉眼验收。
 */

/** 一条候选文件（readdir + stat 的结果，测试里手写） */
export interface RetentionEntry {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface RetentionOptions {
  /** 当前时间（ms） */
  readonly now: number;
  /** 超过这么多天的直接删；<= 0 表示不看时间 */
  readonly keepDays: number;
  /** 删完「过期」之后，总量仍超这个字节数就继续从最老的删；<= 0 表示不看字节 */
  readonly maxBytes: number;
  /** 无论如何都留下最新的这么多份（防止一次配置写错把目录清空） */
  readonly minKeep?: number;
}

export interface RetentionPlan {
  /** 保留的文件名（按 mtime 从新到旧） */
  readonly keep: string[];
  /** 该删的文件名（从最老到最新，方便日志读） */
  readonly drop: string[];
  /** 删掉的总字节 */
  readonly dropBytes: number;
}

const DEFAULT_MIN_KEEP = 20;

/**
 * 算保留计划。规则：
 *  ① 先按 mtime 从新到旧排序；
 *  ② 超过 keepDays 的，全部进 drop —— 但至少留 minKeep 份最新的（新文件可能 mtime 很旧，
 *     比如系统时间跳过、或文件是拷进来的，这时候「全删光」比「留几份」更糟）；
 *  ③ 剩下的从最老的开始删，直到总量 <= maxBytes，同样守住 minKeep。
 */
export function planRetention(entries: readonly RetentionEntry[], options: RetentionOptions): RetentionPlan {
  const minKeep = Math.max(0, Math.floor(options.minKeep ?? DEFAULT_MIN_KEEP));
  const sorted = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));

  const keep: RetentionEntry[] = [];
  const drop: RetentionEntry[] = [];
  const cutoff = options.keepDays > 0 ? options.now - options.keepDays * 24 * 60 * 60 * 1000 : Number.NEGATIVE_INFINITY;

  for (let i = 0; i < sorted.length; i += 1) {
    const entry = sorted[i]!;
    if (i >= minKeep && options.keepDays > 0 && entry.mtimeMs < cutoff) {
      drop.push(entry);
    } else {
      keep.push(entry);
    }
  }

  if (options.maxBytes > 0) {
    let total = keep.reduce((sum, entry) => sum + entry.size, 0);
    // keep 已是「新 → 旧」，从末尾（最老）往前删
    while (total > options.maxBytes && keep.length > minKeep) {
      const victim = keep.pop();
      if (victim === undefined) break;
      drop.push(victim);
      total -= victim.size;
    }
  }

  // drop 从最老到最新，方便人眼核对「删的是不是最老的一批」
  drop.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  return {
    keep: keep.map((entry) => entry.name),
    drop: drop.map((entry) => entry.name),
    dropBytes: drop.reduce((sum, entry) => sum + entry.size, 0),
  };
}
/**
 * 按计划真删。只删 `ext` 结尾（或全部，若没给）的普通文件；目录、符号链接一律跳过。
 * 任何一个文件删不掉都只跳过——保留策略不该让陪伴停下来。
 */
export async function pruneDir(
  dir: string,
  options: RetentionOptions & { readonly ext?: string; readonly log?: (text: string) => void },
): Promise<{ removed: number; bytes: number; names: string[] }> {
  const ext = options.ext;
  let entries: RetentionEntry[] = [];
  try {
    const names = await readdir(dir);
    for (const name of names) {
      if (ext !== undefined && !name.endsWith(ext)) continue;
      const info = await stat(join(dir, name)).catch(() => null);
      if (info === null || !info.isFile()) continue;
      entries.push({ name, size: info.size, mtimeMs: info.mtimeMs });
    }
  } catch {
    return { removed: 0, bytes: 0, names: [] }; // 目录还不存在
  }
  const plan = planRetention(entries, options);
  const removed: string[] = [];
  let bytes = 0;
  for (const name of plan.drop) {
    const size = entries.find((entry) => entry.name === name)?.size ?? 0;
    try {
      await unlink(join(dir, name));
      removed.push(name);
      bytes += size;
    } catch {
      /* 正被别人打开着（比如刚写进去还在读）→ 下一轮再来 */
    }
  }
  if (removed.length > 0) {
    options.log?.(
      `[retention] ${dir} 删 ${removed.length} 个 / ${(bytes / 1024 / 1024).toFixed(1)}MB（上限 ${options.maxBytes > 0 ? (options.maxBytes / 1024 / 1024).toFixed(0) + 'MB' : '不限'}、留 ${options.keepDays} 天）`,
    );
  }
  return { removed: removed.length, bytes, names: removed };
}
