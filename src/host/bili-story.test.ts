import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  chunkLines,
  chunkPrompt,
  createStoryCache,
  planSummaryChars,
  storyFileName,
  subtitleChars,
} from './bili-story.ts';

const URL_BILI = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2';

function tmpDirs(): { subtitleDir: string; storyDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'dsh-pet-story-'));
  return { subtitleDir: join(base, '字幕'), storyDir: join(base, '剧情') };
}

test('bili-story：梗概字数按字幕长短定（短视频别注水）', () => {
  assert.equal(planSummaryChars(300), 120);
  assert.equal(planSummaryChars(3000), 200);
  assert.equal(planSummaryChars(9000), 300);
});

test('bili-story：字幕按行切块，不切开半句', () => {
  const lines = [
    { from: 0, to: 1, text: '一二三四五' },
    { from: 1, to: 2, text: '六七八九十' },
    { from: 2, to: 3, text: '十一十二' },
    { from: 3, to: 4, text: '' },
  ];
  const chunks = chunkLines(lines, 8);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks, ['一二三四五', '六七八九十', '十一十二']);
  assert.equal(subtitleChars(lines), 14);
  assert.ok(chunkPrompt(1, 3, 'x').includes('第 1/3 段'));
});

test('bili-story：第一次给 null 并在后台生成，第二次直接吃缓存', async () => {
  const dirs = tmpDirs();
  const asked: string[] = [];
  const cache = createStoryCache({
    ...dirs,
    fetchLines: async () => ({ ok: true, lines: [{ from: 0, to: 1, text: '她在雨里等他' }] }),
    ask: async (prompt) => {
      asked.push(prompt);
      return '一个女孩在雨里等人，等到最后也没等到。';
    },
  });

  assert.equal(await cache.get(URL_BILI, '雨'), null);

  let hit = null;
  for (let i = 0; i < 50 && hit === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    hit = await cache.get(URL_BILI, '雨');
  }
  assert.ok(hit !== null);
  assert.equal(hit.cached, true);
  assert.ok(hit.summary.includes('雨里'));
  assert.equal(asked.length, 1); // 只有「合并」那一次：单块不走分段摘要

  // 字幕、梗概各落一份，文件名按 BV + 分P
  const name = storyFileName('BV1xx411c7mD', 2);
  assert.deepEqual(readdirSync(dirs.subtitleDir), [name]);
  assert.deepEqual(readdirSync(dirs.storyDir), [name]);
  const story = JSON.parse(readFileSync(join(dirs.storyDir, name), 'utf8')) as { summary: string; title: string };
  assert.equal(story.title, '雨');
});

test('bili-story：长字幕先分段再合并', async () => {
  const dirs = tmpDirs();
  const longLines = Array.from({ length: 40 }, (_, i) => ({ from: i, to: i + 1, text: '第' + String(i) + '句' + '台词内容'.repeat(20) }));
  let calls = 0;
  const cache = createStoryCache({
    ...dirs,
    fetchLines: async () => ({ ok: true, lines: longLines }),
    ask: async () => {
      calls += 1;
      return '这一段在讲事情。';
    },
  });
  assert.equal(await cache.get(URL_BILI, '长'), null);
  let hit = null;
  for (let i = 0; i < 50 && hit === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    hit = await cache.get(URL_BILI, '长');
  }
  assert.ok(hit !== null);
  assert.ok(calls >= 3, '应该分段摘要多次再合并，实际 ' + String(calls));
});

test('bili-story：字幕拿不到就不生成，也不写文件', async () => {
  const dirs = tmpDirs();
  const logs: string[] = [];
  const cache = createStoryCache({
    ...dirs,
    fetchLines: async () => ({ ok: false, lines: [], reason: 'no-cookie' }),
    ask: async () => '不该被叫到',
    log: (message) => logs.push(message),
  });
  assert.equal(await cache.get(URL_BILI, 'x'), null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await cache.get(URL_BILI, 'x'), null);
  assert.ok(logs.some((line) => line.includes('no-cookie')));
});

test('bili-story：定时删除把过期的字幕和梗概清掉', async () => {
  const dirs = tmpDirs();
  const cache = createStoryCache({
    ...dirs,
    fetchLines: async () => ({ ok: true, lines: [] }),
    ask: async () => '',
    keepDays: 30,
  });
  const old = join(dirs.storyDir, storyFileName('BVold', 1));
  mkdirSync(dirs.storyDir, { recursive: true });
  writeFileSync(old, JSON.stringify({ summary: '旧的' }), 'utf8');
  const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  utimesSync(old, past, past);
  assert.equal(await cache.cleanup(), 1);
  assert.deepEqual(readdirSync(dirs.storyDir), []);
});

