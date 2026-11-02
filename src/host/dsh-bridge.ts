/**
 * 「接入 DSH」：桌宠侧那一半。
 *
 * 分工（哥哥 11-01 定「桌宠的回答交给 DSH 本鱼」）：
 *   - DSH 那边的桥插件（dsh-pet-bridge）把自己的地址和对准的会话写进
 *     `<用户根>/dsh-bridge.json`；
 *   - 这里读那份文件，反过来调 DSH 的 `/api/pet-bridge`：
 *       GET  /state   看桥在不在、接了哪个会话、有哪些会话可选
 *       POST /config  开关接入 / 换会话
 *       POST /say     把桌宠想说的话投给 DSH 本鱼（回复由桥以气泡/朗读送回）
 *
 * 独立模式下桌宠没有 DSH 会话（`context.ts` 的伪 ctx 不订阅事件），所以「接入」
 * 只能是**跨进程**的：文件发现 + HTTP 调用，两边都不需要知道对方怎么启动的。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** 桥插件写发现文件用的名字（和 body-of-fish-bridge/lib/index.js 里一致） */
export const DISCOVERY_FILE = 'body-of-fish-bridge.json';

/** 0.3.x 的老发现文件：升级后第一次连上之前还认它 */
const LEGACY_DISCOVERY_FILE = 'dsh-bridge.json';

export interface DshBridgeSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly status: string;
}

/** 发现文件的内容（桥每次收到请求/改配置都会刷新它） */
export interface DshBridgeDiscovery {
  readonly url: string;
  readonly enabled: boolean;
  readonly sessionId: string;
  readonly selected: string;
  readonly selectedTitle: string;
  readonly sessions: ReadonlyArray<DshBridgeSession>;
  readonly updatedAt: string;
}

/** 运行态：给菜单和对话用的精简视图 */
export interface DshBridgeState {
  /** 桥插件在、地址有，就 true */
  readonly available: boolean;
  /** 桌宠的回复交给 DSH（哥哥要的那个开关） */
  readonly enabled: boolean;
  /** 当前对准的会话名（给菜单标题用） */
  readonly title: string;
  /** 当前对准的会话 id */
  readonly sessionId: string;
  /** 可选会话（换会话时轮着用） */
  readonly sessions: ReadonlyArray<DshBridgeSession>;
  /** 最近一次出错的原因（给气泡说人话） */
  readonly error?: string;
}

export const EMPTY_BRIDGE_STATE: DshBridgeState = {
  available: false,
  enabled: false,
  title: '',
  sessionId: '',
  sessions: [],
};

interface JsonRecord {
  readonly [key: string]: unknown;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const bool = (value: unknown): boolean => value === true;

function toDiscovery(raw: unknown): DshBridgeDiscovery | null {
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as JsonRecord;
  const url = str(record.url);
  if (url === '') return null;
  const list = Array.isArray(record.sessions) ? record.sessions : [];
  const sessions: DshBridgeSession[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as JsonRecord;
    const id = str(row.id);
    if (id === '') continue;
    sessions.push({ id, title: str(row.title), cwd: str(row.cwd), status: str(row.status) });
  }
  return {
    url,
    enabled: bool(record.enabled),
    sessionId: str(record.sessionId),
    selected: str(record.selected),
    selectedTitle: str(record.selectedTitle),
    sessions,
    updatedAt: str(record.updatedAt),
  };
}

/** 读桥插件写下的发现文件；没有/坏了都返回 null（= 没接入过） */
export async function readDiscovery(userRoot: string): Promise<DshBridgeDiscovery | null> {
  for (const name of [DISCOVERY_FILE, LEGACY_DISCOVERY_FILE]) {
    try {
      const text = await fs.readFile(path.join(userRoot, name), 'utf8');
      return toDiscovery(JSON.parse(text));
    } catch {
      // 新文件名没有就看老文件名（升级过渡期）
    }
  }
  return null;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<JsonRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
    const parsed = text.trim() === '' ? {} : JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as JsonRecord) : {};
  } finally {
    clearTimeout(timer);
  }
}

/** 探一下桥活没活、接了哪个会话 */
export async function fetchState(url: string, timeoutMs = 1500): Promise<DshBridgeState> {
  try {
    const data = await fetchJson(`${url}/state`, { method: 'GET' }, timeoutMs);
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    const selected = str(data.selected);
    let title = '';
    const list: DshBridgeSession[] = [];
    for (const item of sessions) {
      if (item === null || typeof item !== 'object') continue;
      const row = item as JsonRecord;
      const id = str(row.id);
      if (id === '') continue;
      const sessionTitle = str(row.title) || str(row.cwd) || id;
      list.push({ id, title: sessionTitle, cwd: str(row.cwd), status: str(row.status) });
      if (id === selected) title = sessionTitle;
    }
    const config = data.config !== null && typeof data.config === 'object' ? (data.config as JsonRecord) : {};
    return {
      available: true,
      enabled: bool(config.enabled),
      title,
      sessionId: selected,
      sessions: list,
    };
  } catch (error) {
    return { ...EMPTY_BRIDGE_STATE, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 切开关 / 换会话（桥那边会顺手刷新发现文件） */
export async function setConfig(
  url: string,
  patch: { enabled?: boolean; sessionId?: string },
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    await fetchJson(
      `${url}/config`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      },
      timeoutMs,
    );
    return true;
  } catch {
    return false;
  }
}

/** 把桌宠想说的话交给 DSH 本鱼（回复不在这里等，桥会在回合结束时送回气泡） */
export async function say(url: string, text: string, timeoutMs = 20_000): Promise<boolean> {
  try {
    await fetchJson(
      `${url}/say`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      },
      timeoutMs,
    );
    return true;
  } catch {
    return false;
  }
}
