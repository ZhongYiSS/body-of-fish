/**
 * 「想」的并发与取消（第 3 批）。
 *
 * 两件事：
 *   1. **同一个会话里，新问题顶掉旧问题** —— 他在说话，上一轮还没算完的就不必算了；
 *   2. **高等级（4/5）来了，别的会话让路** —— 手动动作和「听一句」不该排队等陪伴。
 *
 * 这一层只管「谁在跑、该不该掐」，不碰提示词、不碰模型；掐的动作用 AbortSignal。
 */
import type { Level } from './types';

export type MindSession = 'main' | 'screen';

interface Running {
  session: MindSession;
  level: Level;
  controller: AbortController;
  startedAt: number;
}

export interface MindRun {
  /** 传到底层请求上的信号 */
  signal: AbortSignal;
  /** 这一轮结束了（成功、失败、被掐都一样要调） */
  end: () => void;
  /** 已被更晚的请求顶掉？（回调里用来提前收手） */
  cancelled: () => boolean;
}

export interface MindDeps {
  now?: () => number;
  log?: (line: string) => void;
}

export interface Mind {
  /** 开一轮「想」：同会话顶掉旧的；4/5 级再顶掉别的会话 */
  begin(session: MindSession, level: Level): MindRun;
  /** 主动取消某个会话（0 = 全部） */
  cancel(session: MindSession | 'all', reason: string): number;
  /** 当前在跑什么（给日志和 /v1/state 看） */
  running(): Array<{ session: MindSession; level: Level; ms: number }>;
}

export function createMind(deps: MindDeps = {}): Mind {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((): void => {});
  const active = new Map<MindSession, Running>();

  const stop = (session: MindSession, reason: string): boolean => {
    const running = active.get(session);
    if (running === undefined) return false;
    active.delete(session);
    try {
      running.controller.abort(new Error(reason));
    } catch {
      /* abort 本身不该抛 */
    }
    log(`cancel session=${session} level=${running.level} age=${now() - running.startedAt}ms reason=${reason}`);
    return true;
  };

  return {
    begin(session, level) {
      // 1) 同会话：新的顶掉旧的（不管等级高低，他后来问的那句才是要紧的）
      stop(session, 'superseded');
      // 2) 4/5 级：别的会话让路（3 级以下互不打扰，陪伴可以照常想）
      if (level >= 4) {
        for (const other of [...active.keys()]) {
          if (other !== session) stop(other, `preempt-${level}`);
        }
      }
      const controller = new AbortController();
      const record: Running = { session, level, controller, startedAt: now() };
      active.set(session, record);
      log(`begin session=${session} level=${level}`);
      return {
        signal: controller.signal,
        end: () => {
          const cur = active.get(session);
          if (cur !== undefined && cur.controller === controller) active.delete(session);
          log(`end session=${session} level=${level} cost=${now() - record.startedAt}ms`);
        },
        cancelled: () => controller.signal.aborted,
      };
    },

    cancel(session, reason) {
      if (session === 'all') {
        let count = 0;
        for (const key of [...active.keys()]) if (stop(key, reason)) count += 1;
        return count;
      }
      return stop(session, reason) ? 1 : 0;
    },

    running() {
      return [...active.entries()].map(([session, record]) => ({
        session,
        level: record.level,
        ms: now() - record.startedAt,
      }));
    },
  };
}
