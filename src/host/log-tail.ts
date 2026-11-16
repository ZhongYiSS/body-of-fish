/**
 * 读文件尾部若干行（不整份读进内存）。
 *
 * 11-16 体检：`/dsh-pet-7340/watch-stats` 每次请求都 `readFile` 整份当天的 jsonl 再取最后 20 行。
 * 平时一天几 KB 无所谓，但陪伴开得久、又不停追加，文件会一直长；这类「只要最后几行」的接口
 * 应该只读尾部。这里把「取尾部 → 切完整行」写成纯函数，IO 只留一层薄壳。
 */

/** 默认真读这么多字节（够放几十行 JSON，一般 1~2KB 一行） */
export const DEFAULT_TAIL_BYTES = 64 * 1024;

/**
 * 从整段文本里取最后 `limit` 个非空行；若文本开头是半行（截断造成），那一行会被丢掉。
 * `truncated` 为真时表示调用方是从文件中段开始读的。
 */
export function tailLines(raw: string, limit: number, truncated = false): string[] {
  if (limit <= 0) return [];
  const lines = raw.split('\n');
  if (truncated && lines.length > 0) lines.shift(); // 第一段可能是被截断的半行
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    out.push(line);
  }
  return out.reverse();
}

/** 只读文件尾部（超过 `bytes` 时从中间截断，第一行可能不完整 → 丢掉它）。 */
export async function readTailLines(file: string, limit: number, bytes = DEFAULT_TAIL_BYTES): Promise<string[]> {
  const { open } = await import('node:fs/promises');
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    const size = info.size;
    const start = size > bytes ? size - bytes : 0;
    const length = size - start;
    if (length <= 0) return [];
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return tailLines(buffer.toString('utf8'), limit, start > 0);
  } finally {
    await handle.close();
  }
}