import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KEEP_RECENT,
  ROLL_CHARS,
  createSessionStore,
  emptySession,
  renderSession,
  sessionChars,
  shouldRoll,
  summaryPrompt,
} from './session';

describe('换卷式上下文（纯逻辑）', () => {
  it('只有「说的 / 想过没说」算字数，听到的不算', () => {
    const session = {
      ...emptySession(1),
      turns: [
        { at: 1, kind: 'heard' as const, text: 'x'.repeat(100) },
        { at: 2, kind: 'said' as const, text: 'y'.repeat(30) },
        { at: 3, kind: 'thought' as const, text: 'z'.repeat(20) },
      ],
    };
    assert.equal(sessionChars(session), 50);
    assert.equal(shouldRoll(session, 50), true);
    assert.equal(shouldRoll(session, 51), false);
  });

  it('摘要提示词要五句、≤300 字、并原文保留他最后一句', () => {
    const session = {
      ...emptySession(1),
      turns: [
        { at: 1, kind: 'said' as const, text: '我在改身体' },
        { at: 2, kind: 'heard' as const, text: '记得别把声音弄丢' },
      ],
    };
    const prompt = summaryPrompt(session);
    assert.match(prompt, /300 字以内/u);
    assert.match(prompt, /他最后一句：记得别把声音弄丢/u);
    assert.doesNotMatch(prompt, /我在改身体\s*$/u);
  });

  it('归档 markdown 带时间、带「想说没说」', () => {
    const session = {
      ...emptySession(1_700_000_000_000),
      turns: [{ at: 1_700_000_000_000, kind: 'thought' as const, text: '想说没说的一句' }],
    };
    const md = renderSession(session);
    assert.match(md, /（想说没说）/u);
    assert.match(md, /的对话卷/u);
  });
});

describe('换卷式上下文（落盘）', () => {
  it('够了就换卷：旧卷归档、新卷带摘要与最近 10 条，旧卷不删', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-session-'));
    const store = createSessionStore({
      dir,
      now: () => 1_700_000_000_000,
      maxChars: 100,
      summarize: async () => '他让我把声音修好；我答应了还没做。\n他最后一句：修好声音',
    });
    await store.append({ kind: 'said', text: 'a'.repeat(60) });
    await store.append({ kind: 'said', text: 'b'.repeat(60) });
    const result = await store.rollIfNeeded();
    assert.equal(result.rolled, true);
    assert.ok(result.archive !== undefined && existsSync(result.archive));
    const archived = readFileSync(result.archive!, 'utf8');
    assert.match(archived, /aaaa/u);
    const fresh = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
    assert.match(fresh.summaryFrom, /修好声音/u);
    assert.ok(fresh.turns.length <= KEEP_RECENT);
  });

  it('没到字就不换，摘要为空也不炸', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-session2-'));
    const store = createSessionStore({ dir, now: () => 1, maxChars: ROLL_CHARS, summarize: async () => '' });
    await store.append({ kind: 'said', text: '短' });
    const result = await store.rollIfNeeded();
    assert.equal(result.rolled, false);
    const context = await store.context();
    assert.equal(context.summary, '');
    assert.equal(context.turns.length, 1);
  });

  it('摘要抛错走本地兜底，不把卷丢掉', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-session3-'));
    const store = createSessionStore({
      dir,
      now: () => 1_700_000_000_000,
      maxChars: 10,
      summarize: async () => {
        throw new Error('模型挂了');
      },
    });
    await store.append({ kind: 'said', text: 'x'.repeat(20) });
    const result = await store.rollIfNeeded();
    assert.equal(result.rolled, true);
    assert.match(result.session.summaryFrom ?? '', /自动摘要失败/u);
  });
});
