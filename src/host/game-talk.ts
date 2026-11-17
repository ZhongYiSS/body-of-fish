/**
 * game-talk.ts —— 游戏陪伴（原「看护」）的说话侧纯函数（本鱼 · 11-10）
 *
 * 为什么要单独一个文件：11-10 哥哥拍板把「识图」和「说一句」合成**一次模型调用**
 * （省掉 1~3 秒的第二次往返），于是提示词、回复解析、话题池、场景档案全都要一起换。
 * 这些都只有字符串和数组的进出，好测，所以从 index.ts 里拆出来。
 *
 * 四样东西：
 *   1. `buildWatchPrompt` —— 把「画面 + 场景档案 + 最近观察 + 上次说过的话 + 他停没停手」
 *      塞进**一条** prompt，让模型一次回完「关键点 / 重要性 / 要说的话 / 现况」。
 *   2. `parseWatchReply` —— 兜底解析那四行（模型不守格式也要能看懂）。
 *   3. 话题池 `mergeTopics` / `pickTopic` —— 哥哥说「放弃同话题硬冷却」，
 *      改成攒着：同主题的并成一条、留最新细节，说完的标记消耗。
 *   4. 场景档案 `mergeScene` / `compressScene` —— 一份 ≤200 字的滚动现况，
 *      下次识图时带上，她才有「接着上一眼往下看」的连续性。
 */

export type SceneKind = 'game' | 'video' | 'code' | 'other' | '';

/** 一条攒着的话题：同主题合并，说完 mark 成 consumed */
export interface TalkTopic {
  /** 话题主题（游戏名 + 事件类型之类，用来判「是不是同一件事」） */
  key: string;
  /** 想说的那句（≤30 字） */
  text: string;
  /** 看到它的时刻 */
  at: number;
  /** 重要性 1/2/3 */
  imp: number;
  /** 说过了就不再挑 */
  consumed?: boolean;
}

/** 滚动场景档案：一局玩下来她脑子里那份「现在什么情况」 */
export interface SceneArchive {
  updatedAt: number;
  kind: SceneKind;
  /** 认出来的游戏/内容名；认不出就空着 */
  game: string;
  /** 现况，≤200 字 */
  brief: string;
  /** 最近 5 件事（死亡/过关/换关/开箱…） */
  events: string[];
  /** 这轮说出去的话，最近 5 句（防重复） */
  talked: string[];
  /** 查过哪些关键词（同一款游戏当天不重复查） */
  lookedUp: string[];
  /** 攒着的话题 */
  topics: TalkTopic[];
}

export const SCENE_BRIEF_MAX = 200;

import { STYLE_RULES } from './pipeline/style';

export const DEFAULT_WATCH_PROMPT = [
  '{{persona}}',
  '',
  '【你在干的事】你坐在哥哥旁边，一边看他屏幕一边随口搭话。不是解说员，不是助手，也不报幕。',
  '【你看到的】{{picture}}',
  '【窗口】{{window}}',
  '【这段的剧情】{{bili}}',
  '（这是背景资料，不是台词：别说还没看到的部分，也别照着念；跟画面对不上就以画面为准。）',
  '【他现在这一局】以画面为准，档案只是参考：',
  '现况：{{brief}}',
  '最近发生：',
  '{{events}}',
  '【刚才的观察】',
  '{{recent}}',
  '【你上次开口】{{said}}',
  '{{idle}}',
  '',
  '只回这几行，别的什么都不要写。顺序也别换——第一行就得是「要说的话」，本鱼要先拿到这句才能开口：',
  '3|要说的话：≤30 字，或者只写 -',
  '1|关键点：≤60 字。他在玩什么/看什么 + 一个画面能确认的具体对象（人名、装备、关卡、视频标题、报错文字）。不要写窗口标题、按钮、鼠标位置、颜色变化。',
  '2|重要性：1=日常 2=值得搭一句 3=要紧（死了/卡住/过关/出错）。这一档要 {{impNeed}} 以上才算值得说。',
  '4|现况：≤60 字，更新「他现在在干什么」，没变化就留空。',
  '7|要看细节：画面里有个东西你看不清又真想知道，就写要问的那一句（≤20 字）；不用就别写这行。',
  '',
  '{{style}}',
  '',
  '查不查，你自己定：',
  '- 拿不准、或者他要的东西你不知道，就只输出一行 [[web_search: 查询词]]（这一行本鱼会去执行，结果再交给你说人话）。',
  '- 不需要就别输出这一行，别为了显得勤快去查。',
].join('\n');

/** 「回看」那一问的默认模板；可用占位符：question */
export const DEFAULT_DETAIL_PROMPT = [
  '这是刚刚那一屏的原图（1280×800）。',
  '只回答这一件事：{{question}}',
  '40 字以内，直接给答案（名字、数字、字面上的字），不要描述画面，不要评价，不要称呼，不要念文件名和路径。看不清就写「看不清」。',
].join('\n');

/** 把 {{key}} 替换成 vars[key]；没给的占位符原样留着（方便一眼看出模板写错了） */
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/gu, (whole: string, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] as string) : whole);
}


export function emptyScene(nowMs = 0): SceneArchive {
  return {
    updatedAt: nowMs,
    kind: '',
    game: '',
    brief: '',
    events: [],
    talked: [],
    lookedUp: [],
    topics: [],
  };
}

/** 模型回的四行 → 认识的结构。认不出来就给空，绝不抛错。 */
export interface WatchReply {
  imp: number;
  note: string;
  say: string;
  brief: string;
  kind: SceneKind;
  game: string;
  event: string;
  /** `7|要看细节：…` —— 她想拿单张大图再看一眼的那个问题（哥哥 m18222） */
  detail: string;
}

const LINE = /^([1-7])\s*[|｜:：]\s*([\s\S]*)$/;

function clean(text: string, max: number): string {
  return text
    .replace(/^[「『"'\s]+|[」』"'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * 解析识图+说话合并后的回复。
 *
 * 约定格式（四行，顺序固定但允许缺）：
 *   1|关键点  2|重要性  3|要说的话  4|现况
 * 老格式 `2|笔记` 也认（那时只有一行）；完全认不出就当没看见，返回空 note。
 */
export function parseWatchReply(text: string): WatchReply {
  const out: WatchReply = { imp: 1, note: '', say: '', brief: '', kind: '', game: '', event: '', detail: '' };
  const lines = String(text ?? '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    const hit = LINE.exec(line);
    if (!hit) continue;
    const slot = hit[1];
    const body = hit[2]!.trim();
    if (slot === '1') out.note = clean(body, 60);
    else if (slot === '2') {
      const n = Number((/\d/.exec(body) ?? ['1'])[0]);
      out.imp = n >= 1 && n <= 3 ? n : 1;
    } else if (slot === '3') {
      const said = clean(body.replace(/^(要说的话|说话|say)\s*[:：]?\s*/i, ''), 40);
      out.say = said === '-' || said === '－' || said === '—' ? '' : said;
    } else if (slot === '4') {
      out.brief = clean(body.replace(/^(现况|状况|档案)\s*[:：]?\s*/, ''), 120);
    } else if (slot === '5') {
      out.kind = normalKind(body);
    } else if (slot === '6') {
      // `6|游戏名|事件` 两段：认出来的名字 + 刚发生的事
      const [game, event] = body.split(/[|｜]/).map((s) => clean(s, 40));
      out.game = game ?? '';
      out.event = event ?? '';
    } else if (slot === '7') {
      // 她看不清某个名字/数字，要求拿单张大图再看一眼
      out.detail = clean(body.replace(/^(要看细节|细节|回看)\s*[:：]?\s*/, ''), 60);
    }
  }
  return out;
}

function normalKind(text: string): SceneKind {
  const t = text.trim();
  if (/游戏|game/i.test(t)) return 'game';
  if (/视频|电影|剧|番|直播|video/i.test(t)) return 'video';
  if (/代码|编辑器|终端|code|ide/i.test(t)) return 'code';
  if (t === '') return '';
  return 'other';
}

export interface WatchPromptInput {
  /** 这一张是裁了某个窗口（true）还是整屏（false） */
  cropped?: boolean;
  scene: SceneArchive;
  notes: readonly { at: number; note: string; imp: number }[];
  lastSaid: string;
  lastSaidAgoMs: number;
  /** 他距上次键鼠输入过了多久（毫秒）；-1 = 不知道 */
  idleMs: number;
  /** 人设里那几条说话规矩（调用方拼好传进来） */
  persona: string;
  /** 前台窗口标题搓出来的名字（空 = 不知道，按画面判断） */
  window?: string;
  /** 这轮从网上查到的资料（空 = 没查 / 没查到） */
  wiki?: string;
  /** 这轮拿到的整片剧情梗概（B站才有；空 = 没拿到） */
  bili?: string;
  /** 这一档节奏的重要性门槛 */
  impNeed: number;
  /** 自定义提示词模板（空 = 用内置那一套） */
  template?: string;
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function idleLine(idleMs: number): string {
  if (idleMs < 0) return '他现在的状态：不知道（照画面判断）。';
  // 【汐儿 · 11-10 m18204】停手闸已经拆了，这里只报事实，不再教她「别打断」。
  if (idleMs < 2000) return '他现在的状态：正在动键盘/鼠标。';
  if (idleMs < 8000) return `他现在的状态：手停下了（约 ${Math.round(idleMs / 1000)} 秒没动），正在看画面。`;
  return '他现在的状态：已经停手一会儿了，可能在读东西、等加载或者发呆。';
}

/**
 * 识图 + 说话合并成一条 prompt。
 *
 * 注意这条 prompt 只能塞进识图接口的**一条 user 消息**（`compatVision` 就是这么发的），
 * 所以人设、档案、笔记都必须揉进正文，不能靠 system —— 这也是省下一次往返的代价。
 */
export function buildWatchPrompt(input: WatchPromptInput): string {
  const { scene } = input;
  const picture = input.cropped === true
    ? '一张截图：只截了他正在用的那个窗口（不是整个屏幕），就是刚刚那一刻。'
    : '一张整屏截图：就是刚刚那一刻。';
  const recent = input.notes.slice(-6).map((n) => `- ${hhmm(n.at)} ${n.note}（重要 ${n.imp}）`).join('\n');
  const events = scene.events.length > 0 ? scene.events.map((e) => `- ${e}`).join('\n') : '- （还没记下什么）';
  const said = input.lastSaid === ''
    ? '你还没开过口。'
    : `${Math.round(input.lastSaidAgoMs / 1000)} 秒前你说过「${input.lastSaid}」，别换皮再说一遍。`;
  const template = input.template !== undefined && input.template.trim() !== ''
    ? input.template
    : DEFAULT_WATCH_PROMPT;
  return renderTemplate(template, {
    persona: input.persona,
    // 【汐儿 · 11-17 m26171】说话规矩与聊天共用一份，不再各处自己写
    style: STYLE_RULES,
    picture,
    window: input.window !== undefined && input.window.trim() !== ''
      ? `${input.window.trim()}（从窗口标题读到的，不一定准；和画面打架就以画面为准）`
      : '（不知道，按画面判断）',
    wiki: input.wiki !== undefined && input.wiki.trim() !== ''
      ? input.wiki.trim()
      : '（这轮没查，别硬编游戏名和设定）',
    bili: input.bili !== undefined && input.bili.trim() !== ''
      ? input.bili.trim()
      : '（这轮没有剧情资料，别硬编人名和情节，按画面说）',
    brief: scene.brief === '' ? '（还不知道）' : scene.brief,
    events,
    recent: recent === '' ? '- （还没有）' : recent,
    said,
    idle: idleLine(input.idleMs),
    impNeed: String(input.impNeed),
  });
}

/** 把一条候选话题并进池子：同 key 的合并（保留最新的说法），满了丢最旧最不重要的 */
export function mergeTopics(pool: readonly TalkTopic[], next: TalkTopic, max = 12): TalkTopic[] {
  const kept = pool.filter((t) => !t.consumed);
  const same = kept.findIndex((t) => t.key === next.key);
  let merged: TalkTopic[];
  if (same >= 0) {
    merged = kept.slice();
    merged[same] = { ...next, at: next.at, consumed: false };
  } else {
    merged = [...kept, next];
  }
  if (merged.length > max) {
    const sorted = merged.slice().sort((a, b) => a.imp - b.imp || a.at - b.at);
    const drop = new Set(sorted.slice(0, merged.length - max));
    merged = merged.filter((t) => !drop.has(t));
  }
  return merged.slice(-max);
}

/** 该说哪条：没说过、最重要的、最新的优先 */
export function pickTopic(pool: readonly TalkTopic[], nowMs: number, freshMs = 3 * 60 * 1000): TalkTopic | null {
  const alive = pool.filter((t) => !t.consumed && nowMs - t.at <= freshMs);
  if (alive.length === 0) return null;
  return alive.sort((a, b) => b.imp - a.imp || b.at - a.at)[0] ?? null;
}

/**
 * 合并这一眼的收获进档案：现况覆盖、事件只留 5 条、说过的话只留 5 句、查过的最多 8 条。
 */
export function mergeScene(
  scene: SceneArchive,
  patch: { nowMs: number; kind?: SceneKind; game?: string; brief?: string; event?: string; said?: string; lookedUp?: string; note?: string },
): SceneArchive {
  const events = scene.events.slice();
  if (patch.event && patch.event.trim() !== '') events.push(patch.event.trim());
  const talked = scene.talked.slice();
  if (patch.said && patch.said.trim() !== '') talked.push(patch.said.trim());
  const looked = scene.lookedUp.slice();
  if (patch.lookedUp && !looked.includes(patch.lookedUp)) looked.push(patch.lookedUp);
  return {
    updatedAt: patch.nowMs,
    kind: patch.kind !== undefined && patch.kind !== '' ? patch.kind : scene.kind,
    game: patch.game && patch.game !== '' ? patch.game : scene.game,
    brief: (patch.brief && patch.brief !== '' ? patch.brief : scene.brief).slice(0, SCENE_BRIEF_MAX),
    events: events.slice(-5),
    talked: talked.slice(-5),
    lookedUp: looked.slice(-8),
    topics: scene.topics,
  };
}

/** 每 10 分钟压一次：现况超长就砍尾巴，事件留最近 3 条，话题丢掉过期的 */
export function compressScene(scene: SceneArchive, nowMs: number, idleMs = 10 * 60 * 1000): SceneArchive {
  const fresh = scene.topics.filter((t) => !t.consumed && nowMs - t.at <= 10 * 60 * 1000);
  const brief = scene.brief.length > 150 ? `${scene.brief.slice(0, 150)}…` : scene.brief;
  const stale = nowMs - scene.updatedAt > idleMs;
  return {
    ...scene,
    brief: stale ? brief : scene.brief,
    events: scene.events.slice(-3),
    topics: fresh.slice(-8),
  };
}

/** 他停手了（或这件事足够要紧）才允许开口。 */
export function idleAllowsSpeak(idleMs: number, imp: number): boolean {
  if (imp >= 3) return true; // 死了/过关这种，正在操作也能嚷一句
  if (idleMs < 0) return true; // 读不到空闲就别卡着她
  return idleMs >= 2000;
}

/**
 * 「回看」那一问的 prompt（哥哥 m18222）：拿最近那一帧单张大图，只回答她问的那件事。
 */
export function buildDetailPrompt(question: string, template?: string): string {
  const tpl = template !== undefined && template.trim() !== '' ? template : DEFAULT_DETAIL_PROMPT;
  return renderTemplate(tpl, { question });
}
