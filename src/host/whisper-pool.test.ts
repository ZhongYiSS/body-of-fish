/**
 * 碎碎念池守卫：缓存口径、坏文件降级、抽卡规则。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { MemeEntry } from './memes.ts';
import { createWhisperPoolCache, pickFromWhisperPool, readWhisperPool } from './whisper-pool.ts';

const dir = mkdtempSync(join(tmpdir(), 'pet-whisper-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function poolFile(name: string, content: string): string {
  const file = join(dir, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

const MEMES: MemeEntry[] = [
  { name: '揉眼睛', desc: '刚醒' },
  { name: '啃饭团', desc: '干饭' },
];

describe('readWhisperPool', () => {
  it('没有池文件 → 空池（模型路径照走）', () => {
    assert.deepEqual(readWhisperPool(join(dir, '不存在的池.json')), []);
  });

  it('只留对象项，字符串/数字项跳过而不是整份作废', () => {
    const file = poolFile('mixed.json', '[{"text":"在"}, "坏的", 42, {"text":"好的"}]');
    assert.deepEqual(readWhisperPool(file).map((x) => x.text), ['在', '好的']);
  });

  it('顶层不是数组 → 空池', () => {
    const file = poolFile('obj.json', '{"text":"在"}');
    assert.deepEqual(readWhisperPool(file), []);
  });

  it('按 mtime 缓存：同一份缓存第二次读命中缓存', () => {
    const file = poolFile('cache.json', '[{"text":"第一句"}]');
    const cache = createWhisperPoolCache();
    assert.equal(readWhisperPool(file, cache)[0]?.text, '第一句');
    assert.equal(cache.mtime !== -1, true);
    assert.equal(readWhisperPool(file, cache)[0]?.text, '第一句');
  });

  it('文件被改坏时沿用上一次成功的内容（不把碎碎念弄哑）', () => {
    const file = poolFile('broken.json', '[{"text":"还活着"}]');
    const cache = createWhisperPoolCache();
    assert.equal(readWhisperPool(file, cache)[0]?.text, '还活着');
    writeFileSync(file, '{ 半个 JSON', 'utf8');
    assert.equal(readWhisperPool(file, cache)[0]?.text, '还活着');
  });
});

describe('pickFromWhisperPool', () => {
  it('空池 → undefined（调用方回 empty-pool，不写空气泡）', () => {
    assert.equal(pickFromWhisperPool([], MEMES), undefined);
  });

  it('文字 + 池内写明的 meme → 原样用', () => {
    const got = pickFromWhisperPool([{ text: '  在的哥哥 ', meme: '揉眼睛' }], MEMES, () => 0);
    assert.deepEqual(got, { text: '在的哥哥', image: '揉眼睛' });
  });

  it('meme 名字不在池里 → 随机抽一张兜底', () => {
    const got = pickFromWhisperPool([{ text: '嗯', meme: '不存在的图' }], MEMES, () => 0.9);
    assert.deepEqual(got, { text: '嗯', image: '啃饭团' });
  });

  it('只配图不配字 → 文本用单个空格占位', () => {
    const got = pickFromWhisperPool([{ meme: '啃饭团' }], MEMES, () => 0);
    assert.deepEqual(got, { text: ' ', image: '啃饭团' });
  });

  it('没字也没图（表情包池也空）→ undefined', () => {
    assert.equal(pickFromWhisperPool([{}], [], () => 0), undefined);
  });

  it('只有文字、表情包池为空 → 纯文字气泡', () => {
    assert.deepEqual(pickFromWhisperPool([{ text: '困了' }], [], () => 0), { text: '困了' });
  });
});
