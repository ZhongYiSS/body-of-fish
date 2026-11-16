/**
 * 单实例锁的契约测试（【汐儿 · 11-15】哥哥选 A+B）。
 *
 * 钉三件事：① 原子创建：锁在就抢不到 ② 陈旧锁（pid 早没了）要能清掉重抢
 * ③ 释放之后还能再抢。真正「两个进程同时启动」的并发由 `openSync(..., 'wx')` 的原子性保证，
 * 这里用「锁文件里写着别的活 pid」来模拟那一步。
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { acquireInstanceLock } from './runtime-state.ts';
import { dataDirIn } from '../host/data-dir.ts';

const home = join(tmpdir(), `dsh-lock-test-${process.pid}-${Date.now()}`);
const lockFile = join(dataDirIn(home), 'standalone.lock');

before(() => {
  mkdirSync(dataDirIn(home), { recursive: true });
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('acquireInstanceLock', () => {
  test('没人持锁时能抢到，并在锁文件里写自己的 pid', () => {
    const got = acquireInstanceLock(home);
    assert.equal(got.ok, true);
    if (!got.ok) return;
    assert.equal(existsSync(lockFile), true);
    const raw = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid: number };
    assert.equal(raw.pid, process.pid);
    got.lock.release();
  });

  test('锁被活着的进程持有时抢不到，并把那个 pid 报出来', () => {
    // 用父进程当「另一个活着的身体」：pid 真实存在，又不是自己
    writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }), 'utf8');
    const got = acquireInstanceLock(home);
    assert.equal(got.ok, false);
    if (got.ok) return;
    assert.equal(got.pid, process.ppid);
    rmSync(lockFile, { force: true });
  });

  test('陈旧锁（pid 早已不存在）会被清掉并重新抢到', () => {
    writeFileSync(lockFile, JSON.stringify({ pid: 2_147_000_001, at: '2020-01-01T00:00:00.000Z' }), 'utf8');
    const got = acquireInstanceLock(home);
    assert.equal(got.ok, true);
    if (got.ok) got.lock.release();
  });

  test('锁文件内容坏了（不是 JSON）也当陈旧锁处理，不抛', () => {
    writeFileSync(lockFile, 'not json at all', 'utf8');
    const got = acquireInstanceLock(home);
    assert.equal(got.ok, true);
    if (got.ok) got.lock.release();
  });

  test('释放之后还能再抢；重复释放不抛', () => {
    const first = acquireInstanceLock(home);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    first.lock.release();
    first.lock.release();
    assert.equal(existsSync(lockFile), false);
    const second = acquireInstanceLock(home);
    assert.equal(second.ok, true);
    if (second.ok) second.lock.release();
  });
});
