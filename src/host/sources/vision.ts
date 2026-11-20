/**
 * 输入 · 眼睛：陪伴流与一眼看交进来的「看到的那一屏」，等级 2。
 *
 * 干什么：把一帧（+ 说明 + 目标窗口）包成 `seen` 事件。
 * 什么时候用：陪伴每张图、`/look` 抓到的一帧，出图之后立刻包一条。
 * 什么时候别用：Alt+G 的连拍是手动触发的（4 级），走 `manual.ts`。
 * 常见坑：`image` 是裸 png 字节，别在这里编码；`target` 只放窗口名/网址，别塞整段提示词。
 */
import type { SourceSpec } from '../pipeline/registry';
import { makeEvent } from '../pipeline/sense';
import type { SenseEvent } from '../pipeline/types';

export const VISION_SOURCE: SourceSpec = {
  id: 'vision',
  title: '眼睛：陪伴流与一眼看',
  levels: [2],
};

export function visionEvent(input: {
  text?: string;
  image?: Uint8Array;
  /** 表情包名（不是图片字节），陪伴冒泡时带过来的那个 */
  imageName?: string;
  target?: string;
  at?: number;
}): SenseEvent {
  return makeEvent({
    kind: 'seen',
    source: 'watch',
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.image === undefined ? {} : { image: input.image }),
    ...(input.imageName === undefined ? {} : { imageName: input.imageName }),
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.at === undefined ? {} : { at: input.at }),
  });
}