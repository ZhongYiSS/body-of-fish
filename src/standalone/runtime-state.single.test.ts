import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { dataDirIn } from '../host/data-dir';
import { readRunningInstance, writeStandaloneRuntime } from './runtime-state.ts';

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'pet-single-'));
}

test('没有能力文件 = 没在跑', () => {
  const home = fixture();
  try {
    assert.equal(readRunningInstance(home), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('自己写的文件里是自己 → 不算「另一个实例」', () => {
  const home = fixture();
  try {
    writeStandaloneRuntime(home, {
      port: 31380,
      token: 'test-only',
      settingsUrl: 'http://127.0.0.1:31380/standalone-ai/',
      pluginRoot: '/test/plugin',
    });
    assert.equal(readRunningInstance(home), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('pid 已经不在了（陈旧文件）→ 不算在跑，不许把用户挡在门外', () => {
  const home = fixture();
  try {
    mkdirSync(dataDirIn(home), { recursive: true });
    const file = join(dataDirIn(home), 'standalone-runtime.json');
    writeFileSync(file, JSON.stringify({ pid: 2_147_000_001, port: 31381, token: 'x' }), 'utf8');
    assert.equal(readRunningInstance(home), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('坏 JSON / 缺字段 → 当作没在跑', () => {
  const home = fixture();
  try {
    mkdirSync(dataDirIn(home), { recursive: true });
    const file = join(dataDirIn(home), 'standalone-runtime.json');
    writeFileSync(file, '{ not json', 'utf8');
    assert.equal(readRunningInstance(home), undefined);
    writeFileSync(file, JSON.stringify({ pid: 'x', port: 1 }), 'utf8');
    assert.equal(readRunningInstance(home), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('pid 活着（拿父进程当样本）→ 认出「已经有一个在跑」', () => {
  const home = fixture();
  try {
    const ppid = process.ppid;
    if (ppid === undefined || ppid <= 0) return; // 拿不到父进程就没法造样本，跳过
    mkdirSync(dataDirIn(home), { recursive: true });
    const file = join(dataDirIn(home), 'standalone-runtime.json');
    writeFileSync(file, JSON.stringify({ pid: ppid, port: 31382, token: 'x' }), 'utf8');
    assert.deepEqual(readRunningInstance(home), { pid: ppid, port: 31382 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
