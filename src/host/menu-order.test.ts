/**
 * 右键菜单一级顺序的契约（哥哥 m35246：把「说」挪到「听」下面）。
 *
 * 为什么要读壳的源码：一级顺序是**壳**摆的（`runtime/electron-helper/sprite.js` 的
 * `onContextMenu`），宿主只负责注册标签。壳没有 `takeBranch` 的层会掉到 `petTree`
 * 尾巴（「碎碎念」后面）——2026-11-20 新加「说」层时就漏了这一步，哥哥看到的它跑到下面去了。
 *
 * 改动只有一处也安全：改了顺序必须让这三条一起过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const sprite = readSource('../../runtime/electron-helper/sprite.js');

test('壳里也把「说」摘出来（否则掉到 petTree 尾巴）', () => {
  assert.ok(/const sayBranch = takeBranch\('说'\);/u.test(sprite), 'sprite.js 里要 takeBranch(\'说\')');
});

test('一级顺序：听 → 说 → 陪伴', () => {
  const hear = sprite.indexOf('...(hearBranch ? [hearBranch] : []),');
  const say = sprite.indexOf('...(sayBranch ? [sayBranch] : []),');
  const companion = sprite.indexOf('...(companionBranch ? [companionBranch] : []),');
  assert.ok(hear > 0, '找得到听那条');
  assert.ok(say > hear, '「说」必须排在「听」后面');
  assert.ok(companion > say, '「说」必须排在「陪伴」前面');
});

test('顺序注释与代码一致（别只改代码不改账）', () => {
  assert.ok(/顺序：状态 → 看 → 听 → 说 → 陪伴/u.test(sprite), 'sprite.js 的顺序注释要写上「说」');
});