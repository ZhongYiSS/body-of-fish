/**
 * 输出 · 动作：动画 / 姿势 / 位置 / 抛掷 / 锁定。
 *
 * 干什么：把「让她动一下」收成一份形状，落到 `state.writePet` 的 `anim`/`position` 等叶子。
 * 什么时候别用：说话自带的口型与表情包不在这里（嘴和主气泡自己带）。
 * 常见坑：动作名必须是壳认识的（`animationNames()`）；位置是窗口坐标，别写百分比。
 */
import type { SinkSpec } from '../pipeline/registry';

export const ANIM_SINK: SinkSpec = {
  id: 'anim',
  title: '动作：动画 / 姿势 / 位置',
  entry: 'state.writePet(anim|position)',
};

export type AffectKind = 'anim' | 'pose' | 'position' | 'throw' | 'lock';

export interface AffectRequest {
  petId?: string;
  kind: AffectKind;
  /** anim/pose 的动作名；position 的 `{x,y}`；throw 的力度；lock 的布尔 */
  data: string | number | boolean | { x: number; y: number };
}