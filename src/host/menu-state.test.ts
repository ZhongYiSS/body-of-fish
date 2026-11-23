/**
 * 菜单状态字段的接线契约（11-22 自测发现：点了「状态 ▸ 联网查」配置真的变了，标签却永远显示「开」）。
 *
 * 为什么读源码：这类 bug 的类型系统抓不到——`PetMenuState` 的字段全是可选的，
 * `refreshPetMenu` 少传一个，标签就退回默认值，看起来像「点了没反应」。
 * 所以把「谁能改、谁必须传、谁必须读」钉成断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const host = readSource('./index.ts');
const menu = readSource('./pet-menu.ts');

test('refreshPetMenu 必须把 searchEnabled 传给菜单', () => {
  assert.ok(/searchEnabled: searchEnabled\(\),/u.test(host), 'refreshPetMenu 里要 searchEnabled: searchEnabled()');
});

test('联网查标签读的是 state.searchEnabled（false 才显示关）', () => {
  assert.ok(/state\.searchEnabled === false \? '关' : '开'/u.test(menu), '标签要按 state.searchEnabled 显示');
});

test('联网查开关只写 search.enabled，别动 search 段其它字段', () => {
  assert.ok(/case 'search-toggle': \{[\s\S]{0,300}?const next = !searchEnabled\(\);/u.test(host), '开关按当前值取反');
  assert.ok(/raw\.search = \{ \.\.\.section, enabled: next \};/u.test(host), '只覆盖 enabled');
});