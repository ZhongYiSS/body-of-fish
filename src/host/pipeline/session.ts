/**
 * 换卷式上下文（第 4 批）。
 *
 * 一份「卷」= 当前还在聊的这一段：`{id, startedAt, summaryFrom?, turns}`。
 * 卷里的字够 5000（只算「说的」和「想过没说的」）就归档成 `sessions/<时间>.md`，
 * 请模型写一段 ≤300 字摘要当新卷的第一条，旧卷永远不删。
 *
 * 这里只做纯逻辑与落盘；什么时候换卷由宿主决定（嘴空的时候）。
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type TurnKind = 'said' | 'thought' | 'heard';

export interface SessionTurn {
  at: number;
  kind: TurnKind;
  text: string;
}

export interface SessionFile {
  id: string;
  startedAt: number;
  /** 上一卷的摘要（新卷第一条就是它） */
  summaryFrom?: string;
  turns: SessionTurn[];
}

export const ROLL_CHARS = 5_000;
export const SUMMARY_MAX = 300;
export const KEEP_RECENT = 10;

export function emptySession(now: number, summaryFrom?: string): SessionFile {
  return {
    id: `s-${now}`,
    startedAt: now,
    ...(summaryFrom === undefined ? {} : { summaryFrom }),
    turns: [],
  };
}

/** 只有「说的」和「想过没说」进字数；听到的、看到的都不算。 */
export function sessionChars(session: SessionFile): number {
  let total = 0;
  for (const turn of session.turns) if (turn.kind !== 'heard') total += turn.text.length;
  return total;
}

export function shouldRoll(session: SessionFile, maxChars = ROLL_CHARS): boolean {
  return sessionChars(session) >= maxChars;
}

/** 归档用的 markdown（一行一条，带时间和种类）。 */
export function renderSession(session: SessionFile): string {
  const head = [
    `# ${new Date(session.startedAt).toLocaleString('zh-CN', { hour12: false })} 的对话卷`,
    '',
    ...(session.summaryFrom === undefined ? [] : ['## 上一卷摘要', '', session.summaryFrom, '']),
    '## 正文',
    '',
  ];
  const body = session.turns.map((turn) => {
    const time = new Date(turn.at).toLocaleTimeString('zh-CN', { hour12: false });
    const who = turn.kind === 'said' ? '她' : turn.kind === 'thought' ? '（想说没说）' : '他（听到的）';
    return `- ${time} ${who}：${turn.text}`;
  });
  return [...head, ...body, ''].join('\n');
}

/** 请模型写摘要时用的提示词：固定五行 + 原文保留他最后一句。 */
export function summaryPrompt(session: SessionFile): string {
  const said = session.turns.filter((turn) => turn.kind !== 'heard');
  const lastHeard = [...session.turns].reverse().find((turn) => turn.kind === 'heard');
  return [
    '把下面这段聊天压成一小段摘要，给「下一段对话」的自己看。',
    '- 五句话，一句一个主题，总共 300 字以内：现在在聊什么／他的状态和要求／我答应过还没做的／说到一半的／别再提的。',
    '- 只写事实，短句，不写感想，不写「好的」「明白了」这种。',
    '- 最后单独一行，把他最后那句原样抄下来，一个字都别改。',
    '',
    '—— 以下是这一段 ——',
    ...said.map((turn) => `${turn.kind === 'said' ? '她' : '（想说没说）'}：${turn.text}`),
    ...(lastHeard === undefined ? [] : ['', `他最后一句：${lastHeard.text}`]),
  ].join('\n');
}

export interface SessionStoreOptions {
  /** 目录：`数据/memory` */
  dir: string;
  now?: () => number;
  /** 换卷字数：给数字，或给个取值函数（配置文件改了不用重启） */
  maxChars?: number | (() => number);
  /** 写摘要；失败返回空串，走本地兜底 */
  summarize: (prompt: string) => Promise<string>;
  /** 换完卷顺手记 1~2 张长期卡（`by:'pet'`）；失败静默，不阻塞换卷 */
  remember?: (turns: readonly SessionTurn[]) => Promise<void>;
  log?: (line: string) => void;
}

export interface SessionStore {
  load(): Promise<SessionFile>;
  append(turn: Omit<SessionTurn, 'at'> & { at?: number }): Promise<SessionFile>;
  /** 够字就换卷；换完返回新卷（没换返回当前卷） */
  rollIfNeeded(): Promise<{ rolled: boolean; session: SessionFile; archive?: string }>;
  /** 给提示词用：摘要 + 最近 N 条 */
  context(limit?: number): Promise<{ summary: string; turns: SessionTurn[] }>;
}

/**
 * 本地摘要：不叫模型，立刻能拿来换卷。
 * 只抄最近三条「她说的 / 想说没说」的开头，宁可粗糙也不卡住换卷。
 */
export function localSummary(session: SessionFile): string {
  const said = session.turns.filter((turn) => turn.kind !== 'heard').slice(-3);
  if (said.length === 0) return '（这一卷没什么内容）';
  const tail = said
    .map((turn) => turn.text.replace(/\s+/gu, ' ').trim().slice(0, 60))
    .filter((line) => line !== '')
    .join('；');
  return `（本地摘要）最近说过：${tail === '' ? '（没有）' : tail}`.slice(0, SUMMARY_MAX);
}

function fallbackSummary(session: SessionFile): string {
  const last = [...session.turns].reverse().find((turn) => turn.kind !== 'heard');
  const words = session.turns
    .filter((turn) => turn.kind !== 'heard')
    .slice(-3)
    .map((turn) => turn.text.slice(0, 40))
    .join('；');
  return `（自动摘要失败）最近说过：${words === '' ? '（没有）' : words}。最后一句：${last?.text.slice(0, 60) ?? '（没有）'}`.slice(
    0,
    SUMMARY_MAX,
  );
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const now = options.now ?? (() => Date.now());
  // 11-18：可以传函数，改配置当场生效（设置页「会话字数」那栏）
  const maxCharsOf = (): number => {
    const raw = typeof options.maxChars === 'function' ? options.maxChars() : (options.maxChars ?? ROLL_CHARS);
    return Number.isFinite(raw) && raw > 0 ? raw : ROLL_CHARS;
  };
  const log = options.log ?? ((): void => {});
  const file = join(options.dir, 'session.json');
  const archiveDir = join(options.dir, 'sessions');
  let cache: SessionFile | undefined;

  const save = async (session: SessionFile): Promise<void> => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
    cache = session;
  };

  const load = async (): Promise<SessionFile> => {
    if (cache !== undefined) return cache;
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as SessionFile;
      if (Array.isArray(parsed.turns)) {
        cache = parsed;
        return parsed;
      }
    } catch {
      /* 没有就现开一卷 */
    }
    const fresh = emptySession(now());
    await save(fresh);
    return fresh;
  };

  return {
    load,

    async append(turn) {
      const session = await load();
      const next: SessionFile = {
        ...session,
        turns: [...session.turns, { at: turn.at ?? now(), kind: turn.kind, text: turn.text }],
      };
      await save(next);
      return next;
    },

    async rollIfNeeded() {
      const session = await load();
      if (!shouldRoll(session, maxCharsOf())) return { rolled: false, session };
      const stamp = new Date(session.startedAt).toISOString().replace(/[:.]/gu, '-').slice(0, 16);
      const archive = join(archiveDir, `${stamp}.md`);
      await mkdir(archiveDir, { recursive: true });
      await writeFile(archive, renderSession(session), 'utf8');
      // 【11-18 换卷不等模型】先用本地摘要当场换卷——断网 / 模型慢都不影响接着聊；
      // 模型摘要放到后台补，补上就覆盖新卷的 summaryFrom（卷没变才写，换了就丢）。
      const local = localSummary(session);
      const fresh: SessionFile = {
        ...emptySession(now(), local),
        // 新卷留最近 10 条，免得一句话都接不上
        turns: session.turns.slice(-KEEP_RECENT),
      };
      await save(fresh);
      log(`roll local archive=${archive} chars=${sessionChars(session)} summary=${local.length}`);
      const previous = session;
      void (async () => {
        let summary = '';
        try {
          summary = (await options.summarize(summaryPrompt(previous))).trim().slice(0, SUMMARY_MAX);
        } catch {
          summary = '';
        }
        if (summary === '') {
          log('roll summary fail（保留本地摘要）');
          return;
        }
        const current = await load();
        if (current.id !== fresh.id) {
          log('roll summary stale（已经换过卷，丢弃）');
          return;
        }
        await save({ ...current, summaryFrom: summary });
        log(`roll summary ok=${summary.length}`);
      })();
      // 【11-18 第 11 条】换完卷顺手叫她自己记 1~2 张卡（`by:'pet'`），失败静默
      if (options.remember !== undefined) {
        void options.remember(previous.turns).catch((error) => {
          log(`roll cards fail ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      return { rolled: true, session: fresh, archive };
    },

    async context(limit?: number) {
      const session = await load();
      return {
        summary: session.summaryFrom ?? '',
        // 不传 limit = 整卷（主想要「当前卷全文」，文档 9.4）；传了才截最近 N 条
        turns: limit === undefined ? [...session.turns] : session.turns.slice(-limit),
      };
    },
  };
}
