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
 */
export const DEFAULT_MAX_SAY_PARTS = 4;

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
  if (parts.length <= limit) return parts;
  const head = parts.slice(0, limit - 1);
  head.push(parts.slice(limit - 1).join(''));
  return head;
}
