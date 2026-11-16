import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { planRetention, pruneDir, type RetentionEntry } from './retention.ts';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-16T12:00:00Z').getTime();

function entry(name: string, ageDays: number, sizeMb = 1): RetentionEntry {
  return { name, size: sizeMb * 1024 * 1024, mtimeMs: now - ageDays * DAY };
}

describe('保留策略 planRetention（11-16 体检：截图与日志不能无限长）', () => {
  test('超过天数的删掉，天数内的留着', () => {
    const plan = planRetention([entry('old.png', 2), entry('fresh.png', 0.5)], {
      now,
      keepDays: 1,
      maxBytes: 0,
      minKeep: 1,
    });
    assert.deepEqual(plan.drop, ['old.png']);
    assert.deepEqual(plan.keep, ['fresh.png']);
    assert.equal(plan.dropBytes, 1024 * 1024);
  });

  test('再老也至少留 minKeep 份最新的（防一次配置写错把目录清空）', () => {
    const plan = planRetention([entry('a.png', 10), entry('b.png', 9), entry('c.png', 8)], {
      now,
      keepDays: 1,
      maxBytes: 0,
      minKeep: 2,
    });
    assert.deepEqual(plan.keep, ['c.png', 'b.png'], 'keep 按 mtime 从新到旧，留最新的两份');
    assert.deepEqual(plan.drop, ['a.png']);
  });

  test('天数没超、但总量超上限 → 从最老的开始删', () => {
    const plan = planRetention(
      [entry('new.png', 0.1, 2), entry('mid.png', 0.2, 2), entry('old.png', 0.3, 2)],
      { now, keepDays: 1, maxBytes: 4 * 1024 * 1024, minKeep: 1 },
    );
    assert.deepEqual(plan.keep, ['new.png', 'mid.png']);
    assert.deepEqual(plan.drop, ['old.png']);
  });

  test('字节上限也要守住 minKeep：超了也不许把最新那份删掉', () => {
    const plan = planRetention([entry('only.png', 0.1, 50)], {
      now,
      keepDays: 1,
      maxBytes: 1024,
      minKeep: 1,
    });
    assert.deepEqual(plan.keep, ['only.png']);
    assert.deepEqual(plan.drop, []);
  });

  test('maxBytes 与 keepDays 都为 0 → 什么都不删', () => {
    const plan = planRetention([entry('a.png', 99), entry('b.png', 98)], { now, keepDays: 0, maxBytes: 0 });
    assert.deepEqual(plan.drop, []);
    assert.equal(plan.keep.length, 2);
  });

  test('drop 按时间从老到新，方便人眼核对', () => {
    const plan = planRetention([entry('x.png', 5), entry('y.png', 3), entry('z.png', 9)], {
      now,
      keepDays: 1,
      maxBytes: 0,
      minKeep: 0,
    });
    assert.deepEqual(plan.drop, ['z.png', 'x.png', 'y.png']);
  });
});

describe('pruneDir：按计划真删（只动指定扩展名）', () => {
  test('删过期 png、不碰 jsonl、目录本身删不动也不报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-retention-'));
    try {
      writeFileSync(join(dir, 'old.png'), Buffer.alloc(1024));
      writeFileSync(join(dir, 'keep.txt'), 'x');
      mkdirSync(join(dir, 'sub.png'));
      // 把 old.png 的 mtime 推回 3 天前
      const { utimesSync } = await import('node:fs');
      const past = new Date(Date.now() - 3 * DAY);
      utimesSync(join(dir, 'old.png'), past, past);

      const result = await pruneDir(dir, {
        now: Date.now(),
        keepDays: 1,
        maxBytes: 0,
        minKeep: 0,
        ext: '.png',
      });
      assert.equal(result.removed, 1);
      assert.deepEqual(result.names, ['old.png']);
      const left = readdirSync(dir).sort();
      assert.deepEqual(left, ['keep.txt', 'sub.png'], '目录不算文件、别的扩展名不许动');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('目录不存在 → 静默返回 0（第一次跑没有目录很正常）', async () => {
    const result = await pruneDir('D:/AI/存档/临时/绝不存在-' + Date.now(), {
      now: Date.now(),
      keepDays: 1,
      maxBytes: 0,
    });
    assert.equal(result.removed, 0);
  });
});