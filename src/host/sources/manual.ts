/**
 * 输入 · 手动：他自己按的（热键、右键菜单、桥的 say-loud），等级 4。
 *
 * 干什么：把「他手动触发了一次」包成 `command` 事件。
 * 为什么单独一条输入：4 级要能掐掉屏幕想（`noteCommand` 里做），
 *                    和耳朵的 3 级、眼睛的 2 级分开记，查日志时能分清是点的还是按的。
 * 什么时候别用：程序自己决定要说话（陪伴、碎碎念）不是手动，不要用这个包。
 * 常见坑：`origin` 只有 `menu` / `hotkey` / `bridge` 三个值（见 `SenseOrigin`），别乱填。
 */
import type { SourceSpec } from '../pipeline/registry';
import { makeEvent, type SenseOrigin } from '../pipeline/sense';
import type { SenseEvent } from '../pipeline/types';

export const MANUAL_SOURCE: SourceSpec = {
  id: 'manual',
  title: '手动：热键 / 右键菜单 / 桥',
  levels: [4],
};

export type ManualOrigin = Extract<SenseOrigin, 'menu' | 'hotkey' | 'bridge'>;

export function manualEvent(origin: ManualOrigin, text: string, at?: number): SenseEvent {
  return makeEvent({
    kind: 'command',
    source: origin,
    text,
    ...(at === undefined ? {} : { at }),
  });
}