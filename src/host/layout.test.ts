/**
 * 数据目录布局（哥哥 m32061 / m32088）。
 *
 * 他的原话：「数据里有一个【陪伴】但是里面实际没东西？以及看一眼和陪伴的文件夹不在同一个位置，
 * 或许应该放在更容易找到的地方」——空的 `数据\陪伴` 是老「场景档案」的落点（0.5 后没人写），
 * 而一眼看的截图在 `companion-shots\`、陪伴的截图在 `logs\陪伴\sheets\`，两处都是英文但到处散。
 *
 * 这一份钉三件事：①新路径长什么样；②老结构能搬过来且幂等；③空的老目录会收掉、非空的留着报备。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { countFiles, dataLayout, migrateLayoutSync, planLayoutMigration } from './layout';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'pet-layout-'));
}

test('新布局：截图都在 shots/ 下，笔记在 notes/watch 下', () => {
  const layout = dataLayout('R');
  assert.equal(layout.lookShots, join('R', 'shots', 'look'));
  assert.equal(layout.watchShots, join('R', 'shots', 'watch'));
  assert.equal(layout.watchNotes, join('R', 'notes', 'watch'));
  assert.equal(layout.watchSubtitles, join('R', 'notes', 'watch', 'subtitles'));
  assert.equal(layout.watchStory, join('R', 'notes', 'watch', 'story'));
});

test('老结构：companion-shots / logs\陪伴\sheets / 陪伴 空目录 都能认出来', () => {
  const root = makeRoot();
  mkdirSync(join(root, 'companion-shots'), { recursive: true });
  mkdirSync(join(root, 'logs', '陪伴', 'sheets'), { recursive: true });
  mkdirSync(join(root, '陪伴'), { recursive: true });
  const plans = planLayoutMigration(root);
  assert.ok(plans.some((p) => p.from.endsWith('companion-shots') && p.to.endsWith(join('shots', 'look'))));
  assert.ok(plans.some((p) => p.from.endsWith('sheets') && p.to.endsWith(join('shots', 'watch'))));
});

test('搬迁：文件真的动了、空目录收掉、写 layout.json、第二次是空操作', () => {
  const root = makeRoot();
  mkdirSync(join(root, 'companion-shots'), { recursive: true });
  writeFileSync(join(root, 'companion-shots', 'shot-0.jpg'), 'look');
  mkdirSync(join(root, 'logs', '陪伴', 'sheets'), { recursive: true });
  writeFileSync(join(root, 'logs', '陪伴', 'sheets', '2026-11-19T12-13-27-021Z_mark.png'), 'png');
  writeFileSync(join(root, 'logs', '陪伴', '2026-11-19.jsonl'), '{"a":1}\n');
  mkdirSync(join(root, '陪伴'), { recursive: true });

  const first = migrateLayoutSync(root);
  assert.equal(first.moved, 3, JSON.stringify(first));
  assert.ok(existsSync(join(root, 'shots', 'look', 'shot-0.jpg')));
  assert.ok(existsSync(join(root, 'shots', 'watch', '2026-11-19T12-13-27-021Z_mark.png')));
  assert.ok(existsSync(join(root, 'notes', 'watch', '2026-11-19.jsonl')));
  assert.ok(!existsSync(join(root, 'companion-shots')), '老截图目录应该空掉后被删');
  assert.ok(!existsSync(join(root, '陪伴')), '空的 数据\\陪伴 应该被收掉');
  const marker = JSON.parse(readFileSync(join(root, 'layout.json'), 'utf8')) as { version: number };
  assert.equal(marker.version, 2);

  const second = migrateLayoutSync(root);
  assert.equal(second.already, true);
  assert.equal(second.moved, 0);
});

test('老目录里还有东西（scene.json）也一起搬进 notes/watch', () => {
  const root = makeRoot();
  mkdirSync(join(root, '陪伴'), { recursive: true });
  writeFileSync(join(root, '陪伴', 'scene.json'), '{}');
  const report = migrateLayoutSync(root);
  assert.equal(report.problems.length, 0, JSON.stringify(report));
  assert.ok(existsSync(join(root, 'notes', 'watch', 'scene.json')));
  assert.ok(!existsSync(join(root, '陪伴')));
});

test('打过标记之后又冒出老目录（旧实例还在写），下次启动照样搬走', () => {
  const root = makeRoot();
  migrateLayoutSync(root);
  assert.equal(existsSync(join(root, 'layout.json')), true);
  mkdirSync(join(root, 'companion-shots'), { recursive: true });
  writeFileSync(join(root, 'companion-shots', 'shot-7.jpg'), 'x');
  const again = migrateLayoutSync(root);
  assert.equal(again.moved, 1);
  assert.ok(existsSync(join(root, 'shots', 'look', 'shot-7.jpg')));
});

test('countFiles 递归数文件（排查用）', () => {
  const root = makeRoot();
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  writeFileSync(join(root, 'a', 'b', 'x.txt'), '1');
  writeFileSync(join(root, 'a', 'y.txt'), '1');
  assert.equal(countFiles(join(root, 'a')), 2);
  assert.equal(statSync(join(root, 'a')).isDirectory(), true);
});

test('清扫窗口：搬家后 30 天内会扫老目录，窗口一过就不再碰（m32229）', () => {
  const root = makeRoot();
  const first = migrateLayoutSync(root);
  assert.equal(first.already, false);
  const marker = JSON.parse(readFileSync(join(root, 'layout.json'), 'utf8')) as { sweepUntil: number };
  assert.ok(marker.sweepUntil > Date.now(), '标记里要写清扫截止');

  // 窗口内：旧实例又写出老目录 → 下次启动跟着搬
  mkdirSync(join(root, 'companion-shots'), { recursive: true });
  writeFileSync(join(root, 'companion-shots', 'shot-3.jpg'), 'x');
  assert.equal(migrateLayoutSync(root).moved, 1);

  // 窗口过了：同样有老目录也不搬（启动路径上不再常驻探测）
  writeFileSync(
    join(root, 'layout.json'),
    JSON.stringify({ version: 2, at: new Date().toISOString(), sweepUntil: Date.now() - 1000 }),
  );
  mkdirSync(join(root, 'companion-shots'), { recursive: true });
  writeFileSync(join(root, 'companion-shots', 'shot-4.jpg'), 'y');
  const late = migrateLayoutSync(root);
  assert.equal(late.moved, 0);
  assert.equal(late.already, true);
});