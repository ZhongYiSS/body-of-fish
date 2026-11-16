/**
 * 屏幕复读检测（【汐儿 · 11-16 夜 m24648】）
 *
 * 哥哥报「每次重启后鱼的第一句话有莫名其妙的内容注入」。
 * 查下来不是提示词被污染，是**回音**：
 *   ① 陪伴/一眼看把她屏幕上看到的东西写成识图笔记（source='watch'），
 *      而那屏正好是本鱼的工作窗（验收清单、报错、测试结果）；
 *   ② 笔记进 system 之后她照着念了出来（「验收写着不许冒气泡…」）；
 *   ③ 念出来的话又被当成自己的「说出口的话」存进历史（source='chat'）；
 *   ④ 下一次生成（尤其重启后第一次）把历史一读，她接着念——自己喂自己。
 *
 * 所以这里给一个纯函数判据：**一句话里有多少内容能在最近的识图笔记里找到**。
 * 超过阈值的就不算「她想说的话」，而是复读屏幕——不存进历史、也不从历史里读出来。
 */

/** 去掉标点与空白，只留字和数字（中英混排都适用） */
export function normalizeForEcho(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

/** 取 n 元组（按字切，不按词——中文没有空格） */
export function shingles(text: string, size = 3): Set<string> {
  const base = normalizeForEcho(text);
  const out = new Set<string>();
  if (base.length === 0) return out;
  if (base.length <= size) {
    out.add(base);
    return out;
  }
  for (let i = 0; i + size <= base.length; i += 1) out.add(base.slice(i, i + size));
  return out;
}

/** 相似度：A 有多少内容能在 B 里找到（用交集 / A 的大小，也就是「包含度」） */
export function containment(a: string, b: string, size = 3): number {
  const A = shingles(a, size);
  if (A.size === 0) return 0;
  const B = shingles(b, size);
  if (B.size === 0) return 0;
  let hit = 0;
  for (const piece of A) if (B.has(piece)) hit += 1;
  return hit / A.size;
}

/** 默认阈值：60% 的三字组都能在笔记里找到，才算「照抄屏幕」。
 *  为什么不是 0.45：拿今天 106 条真实回复量过——0.45 会把「lib 里确实没有 client.js，装完能跑起来吗」
 *  这种正常点评屏幕的话也砍掉；真正的问题（把「验收/气泡」当自己的活儿）其实是**改写**，
 *  三字组根本对不上（实测 0.19~0.37），那种靠提示词管，不靠这个函数。
 *  这里只兜「成段照抄」——照抄必砍，点评不动。 */
export const ECHO_THRESHOLD = 0.6;

/** 这句话是不是在复读这批笔记里的内容？（短句不判，太容易误伤「嗯」「好呀」） */
export function looksLikeEcho(
  reply: string,
  notes: readonly string[],
  threshold = ECHO_THRESHOLD,
): boolean {
  if (normalizeForEcho(reply).length < 12) return false;
  if (notes.length === 0) return false;
  const joined = notes.join('\n');
  return containment(reply, joined) >= threshold;
}