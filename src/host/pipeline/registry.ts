/**
 * 身体的接线表（注册表 · 薄版）
 *
 * 干什么：把「谁交消息 / 谁去想 / 谁负责输出」收进三张表，宿主只注册一次。
 *          以后加一条输入或一种输出，落到 `sources/`、`minds/`、`sinks/` 三个目录里注册，
 *          不用再去 `index.ts` 里翻两千行找接线的地方。
 *
 * 什么时候用：`index.ts` 的 `ctx.effect` 里建一次；产生「听和看」事件的地方用 `emitSense()`；
 *            对外 `describe()` 给 `/v1/describe` 看当前注册了什么。
 *
 * 什么时候别用：别在这里放逻辑（不判等级、不决策、不碰 IO）——
 *              等级由 `sense.ts` 定，先后由 `level.ts` 定，说嘴由仲裁中心定。
 *
 * 常见坑：
 *  - `registerX` 重复注册同一个 id 会抛错（宁可炸，也别悄悄覆盖掉旧接线）。
 *  - `emitSense` 只记账 + 扇出，**不负责写进哪个「想」**；想的调用仍在上层，
 *    这一版不接管调用顺序（接管是后面的活）。
 */
import { describeEvent } from './sense';
import type { Level, SenseEvent } from './types';

/** 三种输入：耳朵 / 手动按的 / 眼睛看的 */
export type SourceId = 'ear' | 'manual' | 'vision';
/** 两个想：主想（聊天）/ 屏幕想（看图） */
export type MindId = 'chat' | 'screen';
/** 五种输出：嘴 / 主气泡 / 副气泡 / 动作 / 投给 DSH */
export type SinkId = 'mouth' | 'bubble' | 'hint' | 'anim' | 'handoff';

export interface SourceSpec {
  readonly id: SourceId;
  readonly title: string;
  /** 这条输入可能产出的等级 */
  readonly levels: readonly Level[];
}

export interface MindSpec {
  readonly id: MindId;
  readonly title: string;
  /** 这个想接哪些等级的消息 */
  readonly handles: readonly Level[];
}

export interface SinkSpec {
  readonly id: SinkId;
  readonly title: string;
  /** 真正落地的宿主函数名（只用来对账，运行时不靠它） */
  readonly entry: string;
}

export interface RegistryDeps {
  /** 记账（宿主传 `noteSense`） */
  readonly log?: (line: string) => void;
  /** 把事件交给想（这一版宿主不接，留口子） */
  readonly onSense?: (event: SenseEvent) => void;
}

export interface RegistryDescribe {
  readonly sources: readonly string[];
  readonly minds: readonly string[];
  readonly sinks: readonly string[];
}

export interface Registry {
  registerSource(spec: SourceSpec): void;
  registerMind(spec: MindSpec): void;
  registerSink(spec: SinkSpec): void;
  emitSense(event: SenseEvent): void;
  describe(): RegistryDescribe;
  /** 某个等级的事件应该由哪个想接（`undefined` = 没有想认领） */
  mindFor(level: Level): MindId | undefined;
}

export function createRegistry(deps: RegistryDeps = {}): Registry {
  const sources = new Map<SourceId, SourceSpec>();
  const minds = new Map<MindId, MindSpec>();
  const sinks = new Map<SinkId, SinkSpec>();

  const put = <Id extends string, Spec extends { readonly id: Id }>(
    table: Map<Id, Spec>,
    spec: Spec,
    kind: string,
  ): void => {
    if (table.has(spec.id)) throw new Error(`注册表里已经有${kind}「${spec.id}」了`);
    table.set(spec.id, spec);
  };

  return {
    registerSource(spec) {
      put(sources, spec, '输入');
    },
    registerMind(spec) {
      put(minds, spec, '想');
    },
    registerSink(spec) {
      put(sinks, spec, '输出');
    },
    emitSense(event) {
      deps.log?.(describeEvent(event));
      deps.onSense?.(event);
    },
    describe() {
      return {
        sources: [...sources.values()].map((spec) => spec.id),
        minds: [...minds.values()].map((spec) => spec.id),
        sinks: [...sinks.values()].map((spec) => spec.id),
      };
    },
    mindFor(level) {
      for (const spec of minds.values()) {
        if (spec.handles.includes(level)) return spec.id;
      }
      return undefined;
    },
  };
}