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
  const short = parts.flatMap((piece) => splitLong(piece, MAX_SEGMENT_CHARS));
  if (short.length <= limit) return short;
  const head = short.slice(0, limit - 1);
  // 超出的部分并进最后一句；并完还超 80 就继续硬截（保每段 ≤80）
  head.push(...splitLong(short.slice(limit - 1).join(''), MAX_SEGMENT_CHARS));
  return head;
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
