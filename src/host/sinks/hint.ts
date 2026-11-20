/**
 * 输出 · 副气泡（小胶囊，最多 4 行）。
 *
 * 干什么：唯一入口形状，落到宿主的 `pushHint`；撤掉走 `dropHint`。
 * 什么时候别用：要她「说一句话」走 `mouth.ts`，副气泡不出声。
 * 常见坑：id 只有白名单里那几个（`ear` / `think` / `thinkScreen` / `watch` / `say` / `menu` / `status`）；
 *           `task` 类常驻、`event` 类到点自己消失，选错了会一直挂着。
 */
import type { SinkSpec } from '../pipeline/registry';

export const HINT_SINK: SinkSpec = {
  id: 'hint',
  title: '副气泡：小胶囊提示',
  entry: 'pushHint / dropHint',
};

export type HintKind = 'task' | 'event';

export interface HintRequest {
  id: string;
  text: string;
  kind?: HintKind;
  /** event 类的存活时间，默认 3 秒 */
  ttlMs?: number;
}