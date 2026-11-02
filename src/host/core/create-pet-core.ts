/**
 * PetCore 的第一块实现：说话 + 槽位写入 + 快照。
 *
 * 为什么先做这三样：它们就是 partner（记忆同步、歌词、碎碎念）最常用的三件事，
 * 而且是「route 里唯一那份业务逻辑」最集中的地方 —— 搬进 core 之后，
 * 路由、桌面管道、独立模式、partner 直调**共用同一份**，不再各写一遍。
 *
 * 形状说明：这里的 `say` 收的是**未校验的原始字段**（text/duration/anim 都可能是 unknown），
 * 因为它要接住 HTTP body 与进程内调用两种来源。类型化的 PetCore.say 只是这层的薄壳。
 */
import {
  decideBroadcast,
  normalizeBroadcastAnim,
  normalizeBroadcastDuration,
  normalizeBroadcastText,
} from '../broadcast.ts';
import type { PetLeafName, PollState, PollStateStore, SectionName } from '../state.ts';

/** 说话结果：ok 或**带具体原因**的失败（调用方据此决定 HTTP 状态与文案，不用自己再猜）。 */
export type SayOutcome = { ok: true } | { ok: false; reason: string; message: string };

export interface SayInput {
  /** 请求方要的宠物 id（?pet= 的原值）；空串会被判定层转成 pet-required */
  petId: string;
  text: unknown;
  image?: unknown;
  url?: unknown;
  duration?: unknown;
  anim?: unknown;
  /** 显示端（desktop / browser），给门禁用 */
  surface?: string;
}

/** 门禁：显示端过滤 + 占用锁。core 不关心锁怎么实现，host 注入。 */
export interface SayGateContext {
  petId: string;
  surface?: string;
  params: URLSearchParams;
  /** 本拍读到的成品配置：门禁（显示端过滤）要用，避免再读一次磁盘 */
  cfg: Record<string, Record<string, unknown>>;
  /**
   * 跳过占用锁门禁：歌词这类**旁挂信息**不该被「某人在跟桌宠打字」挡住
   * （旧路由只做了显示端校验，这里原样保留该口径）。
   */
  skipLock?: boolean;
}

/** 歌词输入：text 空串 = 隐藏；不给 text 也当空串（幂等收起） */
export interface LyricInput {
  petId: string;
  text?: unknown;
  instrumental?: unknown;
  surface?: string;
}

export type LyricOutcome =
  | { ok: true; pet: string; chars: number }
  | { ok: false; reason: string; message: string };

export interface PetCoreDeps {
  state: PollStateStore;
  /** 读合并后的成品配置（绝对正确的那份，不做二次兜底） */
  readConfig(): Record<string, Record<string, unknown>>;
  /** 表情包目录解析（名称形态的配图） */
  memeDirsFor(entry: string): string[];
  /** 可选门禁：返回非 null 表示拦下（原因原样回给调用方） */
  gate?(context: SayGateContext): SayOutcome | null;
}

export interface PetCoreRuntime {
  say(input: SayInput, params?: URLSearchParams): SayOutcome;
  /**
   * 歌词气泡（独立于 say 的旁挂叶子 `pets.<id>.lyric`）。
   *
   * 与 say 的差异是刻意保留的：**不受占用锁限制**（旧路由的口径），
   * 但仍然过显示端门禁 —— 桌宠只显示在浏览器时，桌面那份歌词不该被写。
   */
  lyric(input: LyricInput, params?: URLSearchParams): LyricOutcome;
  writeSection(name: SectionName, data: unknown): void;
  writePetSection(petId: string, name: PetLeafName, data: unknown): void;
  /** 只读快照（与 GET /state 完全同源） */
  state(): PollState;
  /** 成品配置快照 */
  config(): unknown;
}

export function createPetCoreRuntime(deps: PetCoreDeps): PetCoreRuntime {
  return {
    say(input, params = new URLSearchParams()) {
      // 判定不需要配置的先短路：别为一个必然失败的请求去碰磁盘
      if (!normalizeBroadcastText(input.text)) {
        return { ok: false, reason: 'bad-request', message: 'text 为空' };
      }
      const duration = normalizeBroadcastDuration(input.duration);
      if (duration === null) {
        return { ok: false, reason: 'bad-request', message: 'duration 必须是 ≥0 的有限数字（毫秒）' };
      }
      const anim = normalizeBroadcastAnim(input.anim);
      try {
        const cfg = deps.readConfig();
        const decision = decideBroadcast({
          cfg,
          requested: input.petId,
          text: input.text,
          image: input.image,
          url: input.url,
          duration,
          anim,
          memeDirs: deps.memeDirsFor,
        });
        if (!decision.ok) {
          return { ok: false, reason: decision.reason, message: decision.message };
        }
        const blocked = deps.gate?.({ petId: decision.petId, surface: input.surface, params, cfg });
        if (blocked) return blocked;
        // duration / anim 写**解析后的生效值**：/state 里能看到实际生效的时长与联动开关
        const pic =
          decision.url !== undefined
            ? { url: decision.url }
            : decision.image !== undefined
              ? { image: decision.image }
              : {};
        deps.state.writePet(decision.petId, 'say', {
          text: decision.text,
          ...pic,
          duration: decision.duration,
          anim: decision.anim,
        });
        return { ok: true };
      } catch (error) {
        // 配置读取失败等（安装损坏）→ 显式失败，不静默
        return {
          ok: false,
          reason: 'generate-error',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },

    lyric(input, params = new URLSearchParams()) {
      // 空文本是合法输入（= 隐藏气泡），所以这里不做短路，直接进判定
      const text = typeof input.text === 'string' ? input.text : '';
      const instrumental = input.instrumental === true;
      try {
        const cfg = deps.readConfig();
        // 复用 say 的落点决策：谁该接这条信息（requested → defaultPet / 单宠物兜底）。
        // 这里只借它算 petId，配图/时长/联动都与歌词无关，所以给中性值（空配图、0 时长、不联动）。
        const decision = decideBroadcast({
          cfg,
          requested: input.petId,
          text: 'x',
          image: undefined,
          url: undefined,
          duration: 0,
          anim: false,
          memeDirs: deps.memeDirsFor,
        });
        if (!decision.ok) {
          return { ok: false, reason: decision.reason, message: decision.message };
        }
        const blocked = deps.gate?.({
          petId: decision.petId,
          surface: input.surface,
          params,
          cfg,
          skipLock: true,
        });
        if (blocked && !blocked.ok) return { ok: false, reason: blocked.reason, message: blocked.message };
        deps.state.writePet(decision.petId, 'lyric', { text, instrumental });
        // chars 按**码点**数：UTF-16 长度会把 emoji / 生僻字算成 2，调用方对不上字数
        return { ok: true, pet: decision.petId, chars: Array.from(text).length };
      } catch (error) {
        return {
          ok: false,
          reason: 'generate-error',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },

    writeSection(name, data) {
      deps.state.writeSection(name, data);
    },

    writePetSection(petId, name, data) {
      deps.state.writePet(petId, name, data);
    },

    state() {
      return deps.state.read();
    },

    config() {
      return deps.readConfig();
    },
  };
}
