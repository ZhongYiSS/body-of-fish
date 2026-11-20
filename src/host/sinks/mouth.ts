/**
 * 输出 · 嘴：把一句话交给仲裁中心（`centerSay` / `centerPlayClip`）。
 *
 * 干什么：统一「要她说话」的入口形状。谁想让她开口都填这一份，不再各自拼 SpeakSpec。
 * 什么时候别用：已经有合成好的音频（陪伴的自动出声）走 `MouthClip`。
 * 常见坑：`priority` 决定插队规则，别一律 urgent —— 那样碎碎念也会掐对话。
 */
import type { SpeakPriority } from '../core/speak-center';
import type { SinkSpec } from '../pipeline/registry';

export const MOUTH_SINK: SinkSpec = {
  id: 'mouth',
  title: '嘴：仲裁后合成并播放',
  entry: 'centerSay / centerPlayClip',
};

export interface MouthRequest {
  text: string;
  priority: SpeakPriority;
  /** false = 只冒泡不出声（陪伴的独立开关） */
  voice?: boolean;
  image?: string;
  petId?: string;
  source?: 'chat' | 'companion' | 'dsh';
  fallbackMs?: number;
  replacePrefix?: string;
}

export interface MouthClip {
  audio: Uint8Array;
  mime: string;
  text?: string;
  priority?: SpeakPriority;
  petId?: string;
  bubbleText?: string;
  bubbleImage?: string;
}