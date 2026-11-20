/**
 * 想 · 主想：聊天回话（走对话模型，或转给 DSH 会话）。
 *
 * 接 3 级（他说话）与 5 级（紧急）；4 级的手动入口不进来——
 * 「看一眼 / 说一句」自己会去调动屏幕想和嘴，不该顺手把聊天卷也翻一页。
 */
import type { MindSpec } from '../pipeline/registry';

export const CHAT_MIND: MindSpec = {
  id: 'chat',
  title: '主想：聊天回话',
  handles: [3, 5],
};