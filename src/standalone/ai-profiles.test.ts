import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanProfileName, createProfileService, readProfileStore } from './ai-profiles.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-pet-profiles-'));
}

/** 造一个"当前生效的配置" + 记录写回了什么的服务 */
function harness() {
  const dir = tempDir();
  const file = join(dir, 'ai-profiles.json');
  const state = {
    ai: { model: 'deepseek-chat', baseUrl: 'https://a.example/v1', apiKey: 'k1' } as Record<string, unknown>,
    model: { vision: { enabled: true } } as Record<string, unknown>,
  };
  const applied: Array<{ ai?: Record<string, unknown>; model?: Record<string, unknown> }> = [];
  let nextId = 0;
  const service = createProfileService({
    file,
    readSnapshot: () => ({ ai: { ...state.ai }, model: { ...state.model } }),
    applyAi: async (ai) => {
      applied.push({ ai });
      state.ai = { ...ai };
    },
    applyModel: (model) => {
      applied.push({ model });
      state.model = { ...model };
    },
    now: () => new Date('2026-11-11T10:00:00Z'),
    newId: () => `p${(nextId += 1)}`,
  });
  return { dir, file, state, applied, service };
}

test('cleanProfileName：去控制字符、压空白、截 24 字、空则用兜底', () => {
  assert.equal(cleanProfileName('  DeepSeek\t主力  '), 'DeepSeek 主力');
  assert.equal(cleanProfileName('a\nb'), 'a b');
  assert.equal(cleanProfileName('x'.repeat(40)).length, 24);
  assert.equal(cleanProfileName('', '方案 2'), '方案 2');
  assert.equal(cleanProfileName(undefined, '方案 3'), '方案 3');
  assert.equal(cleanProfileName(123, '方案 4'), '方案 4');
});

test('第一次 list 会拿当前配置现开一套「方案 1」，并写进文件', () => {
  const h = harness();
  try {
    const list = h.service.list();
    assert.equal(list.profiles.length, 1);
    assert.equal(list.profiles[0].name, '方案 1');
    assert.equal(list.activeId, list.profiles[0].id);
    const store = readProfileStore(h.file);
    assert.ok(store);
    assert.equal(store?.profiles[0].ai.model, 'deepseek-chat');
    assert.deepEqual(store?.profiles[0].model, { vision: { enabled: true } });
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('snapshot：把当前配置存回正在用的那一套（切回来就是它）', () => {
  const h = harness();
  try {
    h.service.list();
    h.state.ai = { model: '改了', apiKey: 'k2' };
    h.state.model = { vision: { enabled: false } };
    h.service.snapshot();
    const store = readProfileStore(h.file);
    assert.equal(store?.profiles[0].ai.model, '改了');
    assert.deepEqual(store?.profiles[0].model, { vision: { enabled: false } });
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('create：用当前配置再开一套并切过去；switch 真的把两份写回去', async () => {
  const h = harness();
  try {
    h.service.list();
    const afterCreate = await h.service.create('备用');
    assert.equal(afterCreate.profiles.length, 2);
    assert.equal(afterCreate.profiles[1].name, '备用');
    assert.equal(afterCreate.activeId, afterCreate.profiles[1].id);
    // 新开的那套 = 当前配置的副本
    assert.equal(readProfileStore(h.file)?.profiles[1].ai.model, 'deepseek-chat');

    // 改掉当前配置，再切回第一套
    h.state.ai = { model: '现在这套' };
    h.state.model = { vision: { enabled: 'now' } };
    const firstId = afterCreate.profiles[0].id;
    h.applied.length = 0;
    const list = await h.service.switchTo(firstId);
    assert.equal(list.activeId, firstId);
    assert.equal(h.applied.length, 2);
    assert.equal(h.applied[0].ai?.model, 'deepseek-chat');
    assert.deepEqual(h.applied[1].model, { vision: { enabled: true } });
    assert.equal(h.state.ai.model, 'deepseek-chat');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('switch 时 AI 那份写失败 → 宠物配置不写、activeId 也不变', async () => {
  const dir = tempDir();
  const file = join(dir, 'ai-profiles.json');
  try {
    const service = createProfileService({
      file,
      readSnapshot: () => ({ ai: { model: 'x' }, model: {} }),
      applyAi: async () => {
        throw new Error('盘满了');
      },
      applyModel: () => {
        throw new Error('不该走到这里');
      },
      newId: () => 'p1',
    });
    service.list();
    await assert.rejects(() => service.switchTo('p1'), /盘满了/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rename / remove：改名生效；删正在用的会切到剩下那套；只剩一套不许删', async () => {
  const h = harness();
  try {
    h.service.list();
    const two = await h.service.create('第二套');
    const [first, second] = two.profiles;
    assert.equal(h.service.rename(second.id, '  改过名  ').profiles[1].name, '改过名');

    h.applied.length = 0;
    const afterRemove = await h.service.remove(second.id);
    assert.equal(afterRemove.profiles.length, 1);
    assert.equal(afterRemove.activeId, first.id);
    // 删掉正在用的那套 → 把剩下的那套的配置写回去，不留半截状态
    assert.equal(h.applied.length, 2);
    await assert.rejects(() => h.service.remove(first.id), /至少/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('文件坏了 / 缺字段：当作没有，重新开一套，不抛', () => {
  const dir = tempDir();
  const file = join(dir, 'ai-profiles.json');
  try {
    writeFileSync(file, '{ 这不是 json', 'utf8');
    assert.equal(readProfileStore(file), undefined);
    writeFileSync(file, JSON.stringify({ version: 1, activeId: 'x', profiles: [{ id: '' }] }), 'utf8');
    assert.equal(readProfileStore(file), undefined);
    const service = createProfileService({
      file,
      readSnapshot: () => ({ ai: {}, model: {} }),
      applyAi: async () => {},
      applyModel: () => {},
      newId: () => 'fresh',
    });
    assert.equal(service.list().profiles[0].id, 'fresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('activeId 指向不存在的那套时，回落到第一套（不会切到空）', () => {
  const dir = tempDir();
  const file = join(dir, 'ai-profiles.json');
  try {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        activeId: 'nope',
        profiles: [{ id: 'a', name: 'A', ai: {}, model: {}, savedAt: '' }],
      }),
      'utf8',
    );
    assert.equal(readProfileStore(file)?.activeId, 'a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
