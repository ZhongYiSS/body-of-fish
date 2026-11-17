/**
 * 身体 · 三大模块的公共类型（第一批：只听和看 / 想 / 张嘴 三件事）
 *
 * 设计文档：`C:/Users/hb109/Desktop/身体修改思路.md` 第 9.1 节。
 * 这里只放**形状**，不放逻辑；逻辑在 `level.ts`（谁先谁后）与 `mouth.ts`（怎么说）。
 */

/**
 * 消息的轻重缓急，5 级。
 * 等级由「听和看」在产消息时写好，想与嘴都不许改（哥哥 11-17 拍板：级别要分清）。
 *
 *   5  听一句（他在按着说话）/ 紧急提醒  —— 立刻打断别人，也掐掉正在说的
 *   4  手动（看一眼 / 说一句 / 桥 say-loud）
 *   3  对话（他打字或说话，她回话）
 *   2  主动（陪伴 / 一眼看自己觉得想说）
 *   1  碎碎念 —— 谁都不许打断，嘴忙就丢
 */
export type Level = 1 | 2 | 3 | 4 | 5;

/** 消息从哪来：耳朵 / 眼睛 / 手动入口 */
export type SenseKind = 'heard' | 'seen' | 'command';

/** 一条「听和看」交出来的消息 */
export interface SenseEvent {
  /** 一次事件一个 id，用来去重、写日志、对账 */
  id: string;
  kind: SenseKind;
  level: Level;
  /** 毫秒时间戳 */
  at: number;
  /** 听到的话 / 看到的那一屏的说明 / 手动入口的正文 */
  text: string;
  /** 看到的那一屏（png），只有 seen 有 */
  image?: Uint8Array;
  /** 屏幕目标（窗口标题之类），只有 seen 有 */
  target?: string;
  /** 谁交出来的：ear / watch / menu / bridge / dsh */
  source: string;
}

/** 张嘴要说的一句话：想产出来，嘴只负责说 */
export interface Utterance {
  /** 一次 utterance 一个 id */
  id: string;
  level: Level;
  /** 哪个「想」产出的（决定日志与配图规则） */
  session: 'main' | 'screen';
  /** say = 要合成的文本；clip = 已经有的音频 */
  kind: 'say' | 'clip';
  text: string;
  /** 要跟出来的表情包名（可选） */
  image?: string;
  /** clip 时的音频 */
  audio?: Uint8Array;
  /** clip 时的 mime */
  mime?: string;
  /** 哪只宠物在说（多宠物） */
  petId: string;
  /** 毫秒时间戳 */
  at: number;
}

/** 嘴的三种出口状态（副气泡的灯） */
export type MouthPhase = 'idle' | 'speaking';