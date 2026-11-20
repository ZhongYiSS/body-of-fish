/**
 * 输出 · 投给 DSH：把「她看到的」写成三段信封塞进会话。
 *
 * 干什么：唯一入口形状，落到 `bridgeHandoff` / `imageHandoffText`。
 * 什么时候别用：DSH 没接入时不要走（会静默失败），先判断 `bridgeHandoff` 的返回值。
 * 常见坑：详情会压成一行、封顶 400 字；别把整段提示词塞进去。
 */
import type { SinkSpec } from '../pipeline/registry';

export const HANDOFF_SINK: SinkSpec = {
  id: 'handoff',
  title: '投给 DSH：三段信封',
  entry: 'bridgeHandoff / imageHandoffText',
};

export type HandoffKind = 'look' | 'watch' | 'image';

export interface HandoffRequest {
  kind: HandoffKind;
  detail: string;
}