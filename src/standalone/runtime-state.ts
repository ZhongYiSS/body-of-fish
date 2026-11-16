import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { writePrivateJson } from './ai-storage';
import { dataDirIn } from '../host/data-dir';

interface RuntimeDetails {
  port: number;
  token: string;
  settingsUrl: string;
  pluginRoot: string;
}

/**
 * 「现在是不是已经有一个身体在跑」（【汐儿 · 11-15】哥哥报：明明只开了一个，却提示两个进程在抢声音）。
 *
 * 只认能力文件里的 pid：文件在、pid 还活着（`process.kill(pid, 0)` 不抛）就算在跑。
 * 文件是陈旧的（关进程时被杀掉、没来得及清理）→ pid 早已不在，按「没在跑」处理，绝不把用户挡在门外。
 */
export interface RunningInstance {
  readonly pid: number;
  readonly port: number;
}

export function readRunningInstance(home: string): RunningInstance | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dataDirIn(home), 'standalone-runtime.json'), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: { pid?: unknown; port?: unknown };
  try {
    parsed = JSON.parse(raw) as { pid?: unknown; port?: unknown };
  } catch {
    return undefined;
  }
  const pid = typeof parsed.pid === 'number' ? parsed.pid : 0;
  const port = typeof parsed.port === 'number' ? parsed.port : 0;
  if (pid <= 0 || port <= 0 || pid === process.pid) return undefined;
  try {
    process.kill(pid, 0); // 只探活：不发信号、不做事
  } catch {
    return undefined;
  }
  return { pid, port };
}

/** 进程还在不在（只探活，不发信号）。自己的 pid 不算「别人在跑」。 */
function alivePid(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const LOCK_NAME = 'standalone.lock';

export interface InstanceLock {
  readonly file: string;
  release(): void;
}

/**
 * 单实例锁（【汐儿 · 11-15】哥哥选 A+B）。
 *
 * `openSync(file, 'wx')` 是**原子**创建：同一瞬间两个进程一起启动，只有一个能成功，
 * 另一个拿到 EEXIST —— 这挡住了「都在写能力文件之前通过检查」那个竞态。
 * 锁里写自己的 pid；进程被硬杀留下的陈旧锁，pid 探活发现不在就清掉重试一次。
 */
export function acquireInstanceLock(home: string): { ok: true; lock: InstanceLock } | { ok: false; pid: number } {
  const directory = dataDirIn(home);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        ok: true,
        lock: {
          file,
          release: () => {
            if (released) return;
            released = true;
            try {
              unlinkSync(file);
            } catch {
              /* 已经被清掉了也不算错 */
            }
          },
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder: unknown = 0;
      try {
        holder = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid;
      } catch {
        holder = 0;
      }
      if (alivePid(holder)) return { ok: false, pid: holder as number };
      // 陈旧锁：持锁进程已经不在了，清掉重来
      try {
        unlinkSync(file);
      } catch {
        /* 别人先清了也无所谓，下一轮会重新抢 */
      }
    }
  }
  return { ok: false, pid: 0 };
}

/** 只给本机启动器的能力文件；HTTP health 不得包含其 token/settingsUrl。 */
export function writeStandaloneRuntime(home: string, details: RuntimeDetails): () => void {
  const directory = dataDirIn(home);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'standalone-runtime.json');
  try {
    writePrivateJson(file, {
      name: 'dsh-pet-standalone',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...details,
    });
  } catch (error) {
    throw new Error('无法安全写入桌宠运行状态，请检查数据目录的访问权限。', { cause: error });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; token?: string };
      if (current.pid === process.pid && current.token === details.token) unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('清理桌宠运行状态失败；请检查数据目录，未删除其他进程的状态。', { cause: error });
    }
  };
}
