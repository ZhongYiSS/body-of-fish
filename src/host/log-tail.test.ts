import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { readTailLines, tailLines } from './log-tail.ts';

describe('tailLines：只取尾部若干行（11-16 体检：/watch-stats 不再整份读 jsonl）', () => {
  test('取最后 N 个非空行', () => {
    assert.deepEqual(tailLines('a\nb\nc\n', 2), ['b', 'c']);
  });

  test('末尾的空行不算数', () => {
    assert.deepEqual(tailLines('a\nb\n\n\n', 2), ['a', 'b']);
  });

  test('行数不够就有多少给多少', () => {
    assert.deepEqual(tailLines('only\n', 20), ['only']);
  });

  test('截断读时丢掉开头那半行', () => {
    assert.deepEqual(tailLines('半行{"x":1}\n完整1\n完整2\n', 5, true), ['完整1', '完整2']);
  });

  test('limit <= 0 → 空数组', () => {
    assert.deepEqual(tailLines('a\nb\n', 0), []);
  });
});

describe('readTailLines：真文件只读尾部', () => {
  test('文件比预算大时仍能拿到最后几行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-tail-'));
    try {
      const file = join(dir, 'day.jsonl');
      const lines: string[] = [];
      for (let i = 0; i < 2000; i += 1) lines.push(JSON.stringify({ i, pad: 'x'.repeat(40) }));
      writeFileSync(file, `${lines.join('\n')}\n`);
      const got = await readTailLines(file, 3, 1024);
      assert.equal(got.length, 3);
      assert.deepEqual(JSON.parse(got[2]!).i, 1999, '最后一行必须是文件里真正的最后一条');
      assert.deepEqual(JSON.parse(got[0]!).i, 1997);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('文件比预算小 → 全读，第一行不被当成半行丢掉', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-tail-'));
    try {
      const file = join(dir, 'day.jsonl');
      writeFileSync(file, '{"i":1}\n{"i":2}\n');
      assert.deepEqual(await readTailLines(file, 5, 64 * 1024), ['{"i":1}', '{"i":2}']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('空文件 → 空数组', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-tail-'));
    try {
      const file = join(dir, 'empty.jsonl');
      writeFileSync(file, '');
      assert.deepEqual(await readTailLines(file, 5), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});