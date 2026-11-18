/**
 * 读盘缓存（11-18 待办 10.5）：命中不串数据，改文件立刻看得见。
 *
 * 三个必测点：
 *   1. 命中缓存时返回的是**副本**——调用方改自己的不会污染下一次；
 *   2. 改了用户配置文件（mtime 变了）立刻读到新值——不靠 TTL 蒙；
 *   3. `invalidateConfigCache()` 能强制重读（同一毫秒写完又读的边界）。
 *
 * 注意：合并结果的 `name` 在 `pets[]` 里（条目顶层没有 name），断言都走 `main.pets[0]`。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { invalidateConfigCache, readAllConfig, type ConfigPaths } from './config.ts';

function makePaths(): { paths: ConfigPaths; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pet-cache-'));
  const petDir = join(root, 'pet');
  mkdirSync(petDir, { recursive: true });
  const defaultFile = join(import.meta.dirname, '..', '..', 'assets', 'config.jsonc');
  const userFile = join(root, 'main-config.jsonc');
  writeFileSync(userFile, '{\n  "pets": [{ "id": "main", "name": "第一版" }]\n}\n', 'utf8');
  return { paths: { defaultFile, userFile, petDir }, root };
}

function petName(paths: ConfigPaths): unknown {
  const pets = readAllConfig(paths).main.pets as Array<Record<string, unknown>>;
  return pets[0]?.name;
}

test('缓存命中返回副本：改结果不会污染下一次', () => {
  const { paths, root } = makePaths();
  try {
    invalidateConfigCache();
    const first = readAllConfig(paths);
    (first.main.pets as Array<Record<string, unknown>>)[0].name = '被调用方改掉了';
    assert.equal(petName(paths), '第一版', '缓存被调用方改脏了');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('改用户配置文件立刻读得到（按 mtime，不靠 TTL）', () => {
  const { paths, root } = makePaths();
  try {
    invalidateConfigCache();
    assert.equal(petName(paths), '第一版');
    writeFileSync(paths.userFile, '{\n  "pets": [{ "id": "main", "name": "第二版" }]\n}\n', 'utf8');
    // 显式把 mtime 推到 20ms 之后：同一毫秒内覆盖写在部分实现里分不出来，测试不能靠运气
    const later = new Date(Date.now() + 20);
    utimesSync(paths.userFile, later, later);
    assert.equal(petName(paths), '第二版');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalidateConfigCache 强制重读', () => {
  const { paths, root } = makePaths();
  try {
    invalidateConfigCache();
    assert.equal(petName(paths), '第一版');
    writeFileSync(paths.userFile, '{\n  "pets": [{ "id": "main", "name": "第三版" }]\n}\n', 'utf8');
    invalidateConfigCache();
    assert.equal(petName(paths), '第三版');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});