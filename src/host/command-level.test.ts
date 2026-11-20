/**
 * 第 4 级「手动」（11-18 补）：command 事件 + 屏幕想让路。
 *
 * 为什么要有这一条：文档五级台阶的第 4 级此前是空表——只有说话优先级 urgent，
 * 没有事件、也不会让「屏幕想」让路，表现是他点一下「看一眼」，几秒后听到两句。
 *
 * 这里钉的是「谁在什么位置发 command」，以及「只掐屏幕想、不掐主聊天」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const here = import.meta.dirname;
const indexCode = readFileSync(join(here, 'index.ts'), 'utf8').split('\r\n').join('\n');
const senseCode = readFileSync(join(here, 'pipeline', 'sense.ts'), 'utf8');

test('command 是 4 级，来源里有 hotkey', () => {
  assert.match(senseCode, /command: 4,/u);
  assert.match(senseCode, /'hotkey'/u);
});

test('noteCommand 发 command 事件，且只掐屏幕想', () => {
  const at = indexCode.indexOf('const noteCommand = (');
  assert.ok(at > 0, '没找到 noteCommand');
  const body = indexCode.slice(at, at + 700);
  // 11-19 起 command 事件由 `sources/manual.ts` 产，这里只认「走接线表」这一件事
  assert.match(body, /registry\.emitSense\(manualEvent\(source, text\)\)/u);
  assert.match(body, /mind\.cancel\('screen'/u);
  assert.ok(!/mind\.cancel\('main'/u.test(body), '手动动作不该掐主聊天');
  assert.ok(!/mind\.cancel\('all'/u.test(body), '手动动作不该掐掉所有');
});

test('四个手动入口都埋了点（菜单项 / 看一眼 / 说一句 / 听一句）', () => {
  assert.equal(indexCode.split('noteCommand(').length - 1, 4, '正好四处调用');
  const calls = [...indexCode.matchAll(/noteCommand\('(menu|hotkey|bridge)'/gu)].map((m) => m[1]);
  assert.equal(calls.filter((x) => x === 'menu').length, 1, '菜单项');
  assert.equal(calls.filter((x) => x === 'hotkey').length, 2, '看一眼 + 听一句');
  assert.equal(calls.filter((x) => x === 'bridge').length, 1, '桥/听.py 说一句');
});

test('打开右键菜单不触发（拉标签那条路由不经过 noteCommand）', () => {
  const from = indexCode.indexOf("if (rest === 'menu/item')");
  const to = indexCode.indexOf("if (rest === 'menu/click')");
  assert.ok(from > 0 && to > from, '没找到菜单那几条路由');
  const menuRead = indexCode.slice(from, to);
  assert.ok(!menuRead.includes('noteCommand('), '拉菜单标签 / 点菜单时不许直接发 command');
});