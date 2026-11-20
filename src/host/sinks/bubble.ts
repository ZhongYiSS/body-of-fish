/**
 * 输出 · 主气泡（她头顶那条）。
 *
 * 干什么：唯一入口形状，落到宿主的 `writeSayBubble`；`clear` 落到 `clearSayBubble`。
 * 什么时候别用：想显示「【在看】/【在听】」这类短提示走 `hint.ts`，别占主气泡。
 * 常见坑：`duration` 不传就按 8 秒；表情包靠 `image`，别把图名写进 text。
 */
import type { SinkSpec } from '../pipeline/registry';

export const BUBBLE_SINK: SinkSpec = {
  id: 'bubble',
  title: '主气泡：头顶说话那条',
  entry: 'writeSayBubble / clearSayBubble',
};

export interface BubbleRequest {
  petId?: string;
  source?: 'chat' | 'companion';
  text: string;
  image?: string;
  durationMs?: number;
  /** 绕过「在听时不冒泡」的闸（她自己的回话要写） */
  force?: boolean;
}