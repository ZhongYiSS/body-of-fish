/**
 * 短期记忆守卫 —— 对应哥哥第一条要求：只留当天、只读当天、不要长期。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DIARY_MAX_CHARS, dayKey } from './memory.ts';
import { createMemoryStore } from './memory-store.ts';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pet2-memory-'));
}

/** 固定时钟：2026-10-30 13:00 本地时间 */
const T0 = new Date(2026, 9, 30, 13, 0, 0).getTime();

describe('短期记忆', () => {
  it('记下来的当天回声按时间正序取最后 N 条', async () => {
    const dir = await tempDir();
    const store = createMemoryStore({ dir, now: () => T0 });
    await store.remember({ role: 'user', text: '在吗', source: 'chat' });
    await store.remember({ role: 'pet', text: '在的哥哥', source: 'chat' });
    const turns = await store.today(10);
    assert.deepEqual(
      turns.map((t) => t.text),
      ['在吗', '在的哥哥'],
    );
    assert.equal(turns[0]!.source, 'chat');
    store.dispose();
  });

  it('同一句连着说两遍只记一遍', async () => {
    const dir = await tempDir();
    const store = createMemoryStore({ dir, now: () => T0 });
    await store.remember({ role: 'pet', text: '咕噜', source: 'companion' });
    await store.remember({ role: 'pet', text: '咕噜', source: 'companion' });
    assert.equal((await store.today()).length, 1);
    store.dispose();
  });

  it('跨零点就切天：昨天的不在今天里', async () => {
    const dir = await tempDir();
    let clock = T0;
    const store = createMemoryStore({ dir, now: () => clock });
    await store.remember({ role: 'user', text: '昨天的话', source: 'chat' });
    clock = T0 + 86_400_000;
    await store.remember({ role: 'user', text: '今天的话', source: 'chat' });
    const today = await store.today();
    assert.deepEqual(
      today.map((t) => t.text),
      ['今天的话'],
    );
    const files = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    assert.equal(files.length, 2, '一天一个文件，不合并');
    store.dispose();
  });

  it('日记只读当天、超 300 字截断、同一句不重复写', async () => {
    const dir = await tempDir();
    const store = createMemoryStore({ dir, now: () => T0 });
    assert.equal(await store.todayDiary(), null);
    await store.digest('早上把桌宠备份做完了');
    await store.digest('早上把桌宠备份做完了');
    const once = await store.todayDiary();
    assert.equal(once, '早上把桌宠备份做完了');
    await store.digest('长'.repeat(400));
    const capped = await store.todayDiary();
    assert.equal(capped!.length, DIARY_MAX_CHARS);
    store.dispose();
  });

  it('损坏的当天文件不会让它崩，只会当成空的一天', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, `${dayKey(T0)}.json`), '{ 这不是 json', 'utf8');
    const store = createMemoryStore({ dir, now: () => T0 });
    assert.deepEqual(await store.today(), []);
    await store.remember({ role: 'user', text: '照常能写', source: 'chat' });
    assert.equal((await store.today()).length, 1);
    store.dispose();
  });

  it('会话接上了就记着来源，断开就清空', async () => {
    const dir = await tempDir();
    const store = createMemoryStore({ dir, now: () => T0 });
    assert.equal(store.sessionSource(), null);
    store.setSessionSource({ id: 's-1', title: '桌宠大改', attachedAt: T0 });
    assert.equal(store.sessionSource()?.title, '桌宠大改');
    store.dispose();
    assert.equal(store.sessionSource(), null);
  });

  it('sweep 只删超期的日子，今天和近几天都留着', async () => {
    const dir = await tempDir();
    const store = createMemoryStore({ dir, now: () => T0 });
    await writeFile(join(dir, '2026-10-01.json'), '{}', 'utf8');
    await writeFile(join(dir, '2026-10-29.json'), '{}', 'utf8');
    await writeFile(join(dir, `${dayKey(T0)}.json`), '{}', 'utf8');
    const removed = await store.sweep(7);
    assert.equal(removed, 1);
    const left = (await readdir(dir)).sort();
    assert.ok(left.includes('2026-10-29.json'));
    assert.ok(left.includes(`${dayKey(T0)}.json`));
    assert.ok(!left.includes('2026-10-01.json'));
    store.dispose();
  });
});
