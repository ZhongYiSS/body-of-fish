/**
 * 历史出厂提示词的快照（只用来「认出来」，不要再拿去拼文案）。
 *
 * 为什么需要：设置页把默认提示词灌进 textarea，用户一保存，配置里就多一份副本；
 * 之后代码里改 `DEFAULT_WATCH_PROMPT` 对这些人**完全无效**——2026-11-20 体检发现
 * 陪伴到 0.6 都还在用 0.5.0 的那份（没有 {{window}}、没有 {{context}}，所以它永远
 * 不知道他在用什么软件）。
 *
 * 规矩：配置里的模板等于下面任何一份（空白归一后）→ 当成「没设过」，用代码默认。
 * 用户真改过的内容不会和这些逐字相同，不会被误伤。
 */

import { DEFAULT_DETAIL_PROMPT, DEFAULT_WATCH_PROMPT } from './game-talk';

/** 0.5.0 出厂的陪伴模板（11-19 加 {{window}}/{{context}} 之前的那版） */
export const LEGACY_WATCH_PROMPT = "{{persona}}\n\n【你在干的事】你坐在哥哥旁边，一边看他屏幕一边随口搭话。你不是解说员，也不是助手。\n【这张图是什么】{{picture}}\n【他现在这一局】以画面为准，档案只是参考：\n现况：{{brief}}\n最近发生：\n{{events}}\n【刚才的观察】\n{{recent}}\n【你上次开口】{{said}}\n{{idle}}\n\n只回这几行，别的什么都不要写。顺序也别换——第一行就得是「要说的话」，本鱼要先拿到这句才能开口：\n3|要说的话：≤30 字，或者只写 -\n1|关键点：≤60 字。他在玩什么/看什么 + 一个画面能确认的具体对象（人名、装备、关卡、视频标题、报错文字）。不要写窗口标题、按钮、鼠标位置、颜色变化。\n2|重要性：1=日常 2=值得搭一句 3=要紧（死了/卡住/过关/出错）。这一档要 {{impNeed}} 以上才算值得说。\n4|现况：≤60 字，更新「他现在在干什么」，没变化就留空。\n7|要看细节：画面里有个东西你看不清又真想知道（名字、数字、按钮上的字），就写要问的那一句（≤20 字）；不用就别写这行。\n\n说话的规矩：\n- 不用管他手停没停：有具体、有意思的话就说，没意思就写 -。\n- 只说一件具体的事：先说你看到的，再顺一句你的反应；别每句都用问句收尾。\n- 不复述界面文字，不评价他干活的方式，不喊称呼，不解释自己在做什么。";

/** 0.5.0 出厂的「回看」模板（里面写着 1280×800，早就不是这个尺寸了） */
export const LEGACY_DETAIL_PROMPT = "这是刚刚那一屏的原图（1280×800）。\n只回答这一件事：{{question}}\n40 字以内，直接给答案（名字、数字、字面上的字），不要描述画面，不要评价，不要称呼。看不清就写「看不清」。";

/** 空白归一：模板里换行、缩进、尾随空格都不该影响「是不是同一份」的判断 */
export function normalizeTemplate(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** 陪伴模板的「出厂集合」：现役默认 + 历史默认 */
export const WATCH_STOCK: readonly string[] = [DEFAULT_WATCH_PROMPT, LEGACY_WATCH_PROMPT];

/** 「回看」模板的出厂集合 */
export const DETAIL_STOCK: readonly string[] = [DEFAULT_DETAIL_PROMPT, LEGACY_DETAIL_PROMPT];

/**
 * 配置里存的模板 → 真正要用的模板。
 *
 * 空白归一后等于任何一份出厂文本 → 返回空串（= 用代码默认）；用户真改过的照原样返回。
 * 空串也返回空串。
 */
export function freshTemplate(value: unknown, stock: readonly string[]): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const normalized = normalizeTemplate(value);
  return stock.some((one) => normalizeTemplate(one) === normalized) ? '' : value;
}
