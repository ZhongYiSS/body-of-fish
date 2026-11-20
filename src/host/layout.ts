import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 数据目录的布局（哥哥 m32061 / m32088：`数据\陪伴` 是空的、看一眼和陪伴的截图不在一处、
 * 目录名要英文、陪伴截图别留太多）。
 *
 * 现在的样子（v2）：
 * ```
 * 数据/
 *   shots/look/           一眼看的截图（原来 companion-shots/，滚动 12 张）
 *   shots/watch/          陪伴看到的那一张（原来 logs/陪伴/sheets/）
 *   notes/watch/          陪伴的笔记 <日期>.jsonl（原来 logs/陪伴/*.jsonl）
 *   notes/watch/subtitles 视频字幕（原来 陪伴/字幕）
 *   notes/watch/story     剧情梗概（原来 陪伴/剧情）
 *   logs/                 只有三本：mouth.log / sense.log / mind.log
 * ```
 * 老结构（v1）在启动时搬一次，搬完写 `layout.json` 做标记，之后不再搬。
 *
 * 什么时候用：`apply()` 一进门调 `migrateLayoutSync(userRoot)`；路径一律从 `dataLayout()` 取，
 * 不要在别处再手写 `'logs', '陪伴'` 这种字符串——搬一次目录得改八个地方，就是这次的教训。
 *
 * 什么时候别用：备份/恢复脚本不要调它（那是外部工具的事，搬一半会更乱）。
 *
 * 常见坑：①`renameSync` 只能同盘，跨盘会抛 EXDEV ——这里全在同一个 `数据/` 下，不会跨盘；
 * ②老目录里可能有 `grid/` 这种子目录，要递归搬；③搬完只删**空**目录，非空的留着让人自己看。
 */

export const LAYOUT_VERSION = 2;
const MARKER = 'layout.json';

export interface DataLayout {
  /** 截图根 */
  readonly shots: string;
  /** 一眼看的截图（滚动那 12 张） */
  readonly lookShots: string;
  /** 陪伴看到的那张 */
  readonly watchShots: string;
  /** 笔记根 */
  readonly notes: string;
  /** 陪伴的 jsonl 笔记 */
  readonly watchNotes: string;
  /** 视频字幕 */
  readonly watchSubtitles: string;
  /** 剧情梗概 */
  readonly watchStory: string;
}

export function dataLayout(root: string): DataLayout {
  const shots = join(root, 'shots');
  const notes = join(root, 'notes');
  const watch = join(notes, 'watch');
  return {
    shots,
    lookShots: join(shots, 'look'),
    watchShots: join(shots, 'watch'),
    notes,
    watchNotes: watch,
    watchSubtitles: join(watch, 'subtitles'),
    watchStory: join(watch, 'story'),
  };
}

/** 搬完以后还继续扫老目录多久（哥哥 m32229：「会不会变成每次启动都检测」——扫 30 天就收手） */
export const SWEEP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** 一条搬迁：from 里所有内容进 to（目录合并，文件覆盖同名） */
export interface MovePlan {
  readonly from: string;
  readonly to: string;
}

/**
 * 老结构 → 新结构要搬哪些（只看存在性，不改任何东西）。
 * 返回空数组 = 已经是新结构，或者压根没有老数据。
 */
export function planLayoutMigration(root: string): MovePlan[] {
  const layout = dataLayout(root);
  const plans: MovePlan[] = [];
  const legacyShots = join(root, 'companion-shots');
  if (existsSync(legacyShots)) plans.push({ from: legacyShots, to: layout.lookShots });
  const legacyWatch = join(root, 'logs', '陪伴');
  if (existsSync(join(legacyWatch, 'sheets'))) plans.push({ from: join(legacyWatch, 'sheets'), to: layout.watchShots });
  if (existsSync(join(legacyWatch, '字幕'))) plans.push({ from: join(legacyWatch, '字幕'), to: layout.watchSubtitles });
  if (existsSync(join(legacyWatch, '剧情'))) plans.push({ from: join(legacyWatch, '剧情'), to: layout.watchStory });
  // 空的 `数据\陪伴\` 是老「场景档案」的落点（0.5 之后没人写），里面有东西就一起搬到 notes/watch
  const legacyScene = join(root, '陪伴');
  if (existsSync(legacyScene)) {
    if (existsSync(join(legacyScene, '字幕'))) plans.push({ from: join(legacyScene, '字幕'), to: layout.watchSubtitles });
    if (existsSync(join(legacyScene, '剧情'))) plans.push({ from: join(legacyScene, '剧情'), to: layout.watchStory });
  }
  return plans;
}

function moveInto(from: string, to: string): number {
  let moved = 0;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      moved += moveInto(src, dst);
      rmdirIfEmpty(src);
      continue;
    }
    // 目标已存在就不覆盖（宁可留两份，也不静默吃掉旧文件）
    if (existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
    moved += 1;
  }
  return moved;
}

function rmdirIfEmpty(dir: string): boolean {
  try {
    if (readdirSync(dir).length > 0) return false;
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

export interface MigrationReport {
  readonly moved: number;
  readonly version: number;
  /** 已经是新结构（没搬） */
  readonly already: boolean;
  /** 被删掉的老空目录 */
  readonly removed: string[];
  /** 出问题的地方（搬运失败不抛，记下来） */
  readonly problems: string[];
}

/**
 * 搬一次。幂等：`layout.json` 里已经是 v2 就直接返回。
 * 失败不抛——数据目录出问题不该把整只宠物带崩，report 里记着就行。
 */
export function migrateLayoutSync(root: string, log?: (line: string) => void): MigrationReport {
  const marker = join(root, MARKER);
  let already = false;
  let sweeping = false;
  if (existsSync(marker)) {
    try {
      const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { version?: unknown; sweepUntil?: unknown; at?: unknown };
      already = Number(parsed.version) >= LAYOUT_VERSION;
      // 老标记没有 sweepUntil（刚搬过的那一版）→ 按搬家时间往后算一个窗口
      const until = Number(parsed.sweepUntil) || (Date.parse(String(parsed.at ?? '')) + SWEEP_WINDOW_MS);
      sweeping = Number.isFinite(until) && Date.now() < until;
    } catch {
      /* 标记坏了就当没搬过，下面的搬迁本身是幂等的 */
    }
  }
  // 【11-20 m32229】打过标记以后还要再扫一阵子：换版的时候旧实例可能还在往老路径写。
  // 但只在窗口内扫（默认 30 天），窗口一过就不再碰文件系统——启动路径上不该常驻一个「老目录探测」。
  if (already && !sweeping) {
    return { moved: 0, version: LAYOUT_VERSION, already: true, removed: [], problems: [] };
  }
  const pending = planLayoutMigration(root);
  if (already && pending.length === 0) {
    return { moved: 0, version: LAYOUT_VERSION, already: true, removed: [], problems: [] };
  }
  const removed: string[] = [];
  const problems: string[] = [];
  let moved = 0;
  try {
    const layout = dataLayout(root);
    for (const plan of planLayoutMigration(root)) {
      try {
        moved += moveInto(plan.from, plan.to);
        if (rmdirIfEmpty(plan.from)) removed.push(plan.from);
      } catch (error) {
        problems.push(`${plan.from} → ${plan.to}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // 陪伴笔记（jsonl）从 logs/陪伴 挪到 notes/watch
    const legacyNotes = join(root, 'logs', '陪伴');
    if (existsSync(legacyNotes)) {
      moved += moveInto(legacyNotes, layout.watchNotes);
      for (const name of ['sheets', '字幕', '剧情']) {
        if (existsSync(join(legacyNotes, name)) && readdirIfAny(join(legacyNotes, name)) === 0) {
          if (rmdirIfEmpty(join(legacyNotes, name))) removed.push(join(legacyNotes, name));
        }
      }
      if (rmdirIfEmpty(legacyNotes)) removed.push(legacyNotes);
    }
    // 旧 `数据\陪伴\`：字幕/剧情上面已经单独搬走，剩下的（scene.json 等场景档案）
    // 并进 notes/watch —— 代码里 `watchScenePath` 现在写的就是 notes/watch/scene.json。
    // 【11-20 认错】我先前只看 du 显示 0 就说它「空的」，实际它有个 2.6KB 的 scene.json。
    const legacyScene = join(root, '陪伴');
    if (existsSync(legacyScene)) {
      moved += moveInto(legacyScene, layout.watchNotes);
      if (rmdirIfEmpty(legacyScene)) removed.push(legacyScene);
      else problems.push(`${legacyScene} 里还有搬不动的东西，留着没删`);
    }
    mkdirSync(layout.lookShots, { recursive: true });
    mkdirSync(layout.watchShots, { recursive: true });
    mkdirSync(layout.watchNotes, { recursive: true });
    writeFileSync(
      marker,
      `${JSON.stringify(
        {
          version: LAYOUT_VERSION,
          at: new Date().toISOString(),
          moved,
          // 清扫窗口：这段时间内每次启动仍会看一眼老目录（旧实例可能还在写），过了就彻底不管
          sweepUntil: Date.now() + SWEEP_WINDOW_MS,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const report: MigrationReport = { moved, version: LAYOUT_VERSION, already: false, removed, problems };
  if (log && (moved > 0 || problems.length > 0)) {
    log(`[layout] 搬到新结构：${String(moved)} 个文件${removed.length > 0 ? `，删空目录 ${String(removed.length)} 个` : ''}`);
    for (const p of problems) log(`[layout] 注意：${p}`);
  }
  return report;
}

function readdirIfAny(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/** 给测试/排查用：这个目录里有多少文件（递归），不算目录本身 */
export function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else if (statSync(join(dir, entry.name)).isFile()) n += 1;
  }
  return n;
}