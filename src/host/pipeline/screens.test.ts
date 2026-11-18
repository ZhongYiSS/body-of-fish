/**
 * 屏幕流水单测（待办第 2 条）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendScreen, dayOf, readScreens, screenBlock, screenFileOf } from './screens.ts';

const dirOf = (): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'screens-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test('一天一个文件，行是 JSON，读回来形状不变', async () => {
  const { dir, cleanup } = dirOf();
  try {
    const at = new Date(2026, 10, 18, 21, 30).getTime();
    assert.equal(dayOf(at), '2026-11-18');
    assert.equal(screenFileOf(dir, at), join(dir, '2026-11-18.jsonl'));
    await appendScreen(dir, { at, app: 'Code', title: 'a.ts', note: '在改代码' });
    await appendScreen(dir, { at: at + 1000, app: 'Edge', title: 'B站', note: '在看视频' });
    const lines = readFileSync(join(dir, '2026-11-18.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const back = await readScreens(dir, '2026-11-18');
    assert.deepEqual(
      back.map((note) => note.note),
      ['在改代码', '在看视频'],
    );
    assert.equal(back[0].app, 'Code');
  } finally {
    cleanup();
  }
});

test('坏行跳过；没有文件回空数组', async () => {
  const { dir, cleanup } = dirOf();
  try {
    assert.deepEqual(await readScreens(dir, '2026-11-19'), []);
    await appendScreen(dir, { at: Date.now(), app: '', title: '', note: '好的行' });
    const file = screenFileOf(dir, Date.now());
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, '{"at":123,"note":"被截断', 'utf8');
    // 文件名按**本地日期**分（dayOf），别拿 toISOString 的 UTC 日期去读 —— 凌晨 0~8 点两者不同天
    const back = await readScreens(dir, dayOf(Date.now()));
    assert.equal(back.length, 1);
    assert.equal(back[0].note, '好的行');
  } finally {
    cleanup();
  }
});

test('拼块：只要窗口内最新 3 条，空的时候给空串', () => {
  const now = Date.now();
  const notes = [0, 1, 2, 3, 4].map((i) => ({ at: now - (4 - i) * 1000, app: '', title: '', note: `第${i}条` }));
  const block = screenBlock(notes, now, 10 * 60_000, 3);
  assert.ok(block.includes('第2条') && block.includes('第4条'));
  assert.ok(!block.includes('第1条'));
  assert.equal(screenBlock([], now), '');
  // 超过 10 分钟的老笔记不算
  assert.equal(screenBlock([{ at: now - 20 * 60_000, app: '', title: '', note: '老' }], now), '');
});