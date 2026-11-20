/**
 * 想 · 屏幕想：看图说话（陪伴自动开口 / 一眼看 / Alt+G 看一眼）。
 *
 * 接 2 级（屏幕变化）与 4 级（手动看一眼）；4 级进来时会掐掉还在跑的 2 级
 * （手动的优先级更高，见 `mind.ts` 的 `canInterrupt`）。
 */
import type { MindSpec } from '../pipeline/registry';

export const SCREEN_MIND: MindSpec = {
  id: 'screen',
  title: '屏幕想：看图说话',
  handles: [2, 4],
};