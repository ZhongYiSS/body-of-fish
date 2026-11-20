/**
 * 把一段回复拆成「一句一个气泡」。
 *
 * 哥哥 11-01 的要求：**一个一个冒，并设置好语音间隔**——一句一个气泡、一句一段语音，
 * 而不是整段字挤在一个大气泡里、语音一口气念完。
 *
 * 拆分口径（宁可少拆不要碎）：
 * - 只在句末标点后断：`。！？!?；;…` 与换行；**逗号不断**（一口气更自然）。
 * - 标点跟着前一句走，不丢；只有标点、没有字的碎片（比如连续两个 `……`）直接丢掉。
 * - 最多 `maxParts` 句：模型偶尔一次吐一大段，全拆成十几条就变成刷屏了；
 *   超出的部分并进最后一句，一个字都不丢。
 * - 【11-18 待办第 12 条】每段最多 `MAX_SEGMENT_CHARS` 字：一句 200 字没标点会整段合成
 *   8~10 秒，字跟着声音一起出就变成"点了半天没动静"。超长的段先按逗号/顿号再切，
 *   还超就硬截（宁可断在半句，也不让她憋十秒）。
 */
export const DEFAULT_MAX_SAY_PARTS = 6;
export const MAX_SEGMENT_CHARS = 80;

/**
 * 流式攒句：把「这次新确定下来的句子」挑出来（【汐儿 · 11-20 半流式】）。
 *
 * - `partial` 是**到目前为止**收到的全文，`final` 表示流已经结束、不会再有新字。
 * - 末段在 `final` 之前一律不算：它还会继续长，提前合成等于白烧一次嗓子。
 * - `emitted` 是调用方已经拿走过的句数；语气词并句可能让句子边界后移，
 *   这时宁可少给（多给的那句会在最终切句时对不上，预热落空，但不影响正文）。
 */
export function takeReadySentences(partial: string, emitted: number, final: boolean): string[] {
  const parts = splitSentences(partial);
  const ready = final ? parts.length : Math.max(0, parts.length - 1);
  const from = Math.max(0, Math.floor(emitted));
  return from < ready ? parts.slice(from, ready) : [];
}

const TERMINATORS = '。！？!?；;…\n';
/** 一句里至少得有一个"真字"，否则这一片只是标点，丢掉（`……` 会连刷两个终止符） */
const HAS_CONTENT = /[^\s。！？!?；;…]/;
/**
 * 一片 = 「若干非终止符」+「尽可能多的终止符」。
 * 这样 `真的吗……` 里的两个省略号会跟着同一句走，不会被切成 `真的吗…` + 一个空片。
 */
const PIECE = /[^。！？!?；;…\n]+[。！？!?；;…\n]*/g;

export function splitSentences(text: string, maxParts: number = DEFAULT_MAX_SAY_PARTS): string[] {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return [''];

  const parts = (trimmed.match(PIECE) ?? [])
    .map((piece) => piece.trim())
    .filter((piece) => HAS_CONTENT.test(piece));
  if (parts.length === 0) return [trimmed];

  const limit = Math.max(1, Math.floor(maxParts));
  // 先按 80 字把每个句子切短（长句不切会整段合成）
  const short = mergeFillers(parts.flatMap((piece) => splitLong(piece, MAX_SEGMENT_CHARS)));
  if (short.length <= limit) return short;
  const head = short.slice(0, limit - 1);
  // 超出的部分并进最后一句；并完还超 80 就继续硬截（保每段 ≤80）
  head.push(...splitLong(short.slice(limit - 1).join(''), MAX_SEGMENT_CHARS));
  return head;
}

/**
 * 【11-20 体检 ④】纯语气词的短句（「咕噜…」「嗯…」「哦哦」）不单独成一句，并到下一句里。
 *
 * 为什么：一句 3 字的气泡刚冒就被下一句顶掉，看着像「闪了一下」；
 * 念起来也断得很硬。并进下一句之后，气泡、语音、上下文都只有一句。
 */
const FILLER_CHARS = /^[\s咕噜嗯啊哦呀吧啦哈嘿呜噗呜呼呀嘛诶欸哎~～…。！？!?，,]+$/u;
const FILLER_MAX_CHARS = 5;

function isFillerSentence(text: string): boolean {
  const stripped = text.trim();
  return stripped !== '' && stripped.length <= FILLER_MAX_CHARS && FILLER_CHARS.test(stripped);
}

function mergeFillers(parts: string[]): string[] {
  if (parts.length <= 1) return parts;
  const out: string[] = [];
  let carry = '';
  for (const part of parts) {
    if (isFillerSentence(part)) {
      carry += part;
      continue;
    }
    out.push(carry + part);
    carry = '';
  }
  if (carry !== '') {
    // 落在最后：并回上一句，别单独冒一个气泡
    if (out.length > 0) out[out.length - 1] += carry;
    else out.push(carry);
  }
  return out;
}

/** 超长的段：先在逗号 / 顿号处切，仍超就按字数硬截；一个字都不丢。 */
function splitLong(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // 在 limit 以内找最后一个逗号/顿号当断点；找不到就硬截
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf('，'), window.lastIndexOf('、'), window.lastIndexOf(','));
    const take = cut > 0 ? cut + 1 : limit;
    out.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  if (rest !== '') out.push(rest);
  return out;
}
