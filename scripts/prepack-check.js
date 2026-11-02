#!/usr/bin/env node
/**
 * prepack-check.js —— 发布前最后一道闸：npm 包里该有的文件一个都不能少。
 *
 * 为什么需要：`files` 是白名单，漏一个文件 npm 不会报错，只会在别人机器上
 * 变成「装好了但壳起不来」。壳（runtime/electron-helper）是整目录发行的，
 * main.js 用相对路径 require 同目录的模块——漏一个就启动即崩，日志还看不出原因。
 *
 * 所以这里不只看白名单写了什么，还把壳目录里**实际存在的**每个 .js 反向核对：
 * 有文件但没进 REQUIRED = 有人加了模块忘了登记，同样报错。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = 'runtime/electron-helper';

/** 发布必需清单（相对仓库根，一律正斜杠）：少一个都会在用户机上炸。 */
const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/client.js',
  'lib/standalone.js',
  'assets/config.jsonc',
  'assets/logo.png',
  'scripts/ensure-electron.mjs',
  // 壳：main.js 逐个 require 同目录模块，缺一即启动崩溃
  'runtime/electron-helper/index.html',
  'runtime/electron-helper/main.js',
  'runtime/electron-helper/preload.js',
  'runtime/electron-helper/renderer.js',
  'runtime/electron-helper/sprite.js',
  'runtime/electron-helper/shared-core.js',
  'runtime/electron-helper/constants.js',
  'runtime/electron-helper/dpi-linearization.js',
  'runtime/electron-helper/host-liveness.js',
  'runtime/electron-helper/events.js',
  'runtime/electron-helper/ear.js',
  'runtime/electron-helper/desktop-geometry.js',
  'runtime/electron-helper/pointer-target.js',
  'runtime/electron-helper/topmost-watchdog.js',
  'runtime/electron-helper/tray-platform.js',
];

const problems = [];

for (const rel of REQUIRED) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    problems.push(`缺文件: ${rel}`);
    continue;
  }
  if (statSync(abs).size === 0) problems.push(`空文件: ${rel}`);
}

// 反向核对：壳目录里实际存在的 .js 必须都登记过（防止有人加模块忘登记）
const helperAbs = join(ROOT, HELPER);
if (existsSync(helperAbs)) {
  for (const name of readdirSync(helperAbs)) {
    if (!name.endsWith('.js') || name.includes('.bak')) continue;
    const rel = `${HELPER}/${name}`;
    if (!REQUIRED.includes(rel)) problems.push(`壳里有未登记模块: ${rel}`);
  }
} else {
  problems.push(`缺目录: ${HELPER}`);
}

// 素材：动画一个都没有的话，宠物就是个不会动的贴纸
const webmDir = join(ROOT, 'assets', 'webm');
const webmCount = existsSync(webmDir) ? readdirSync(webmDir).filter((f) => f.endsWith('.webm')).length : 0;
if (webmCount === 0) problems.push('assets/webm 里没有任何 .webm 动画');

// index.html 的 CSP 必须放行桥协议，否则表情图被拦、气泡只剩 alt 文字
const htmlPath = join(ROOT, HELPER, 'index.html');
if (existsSync(htmlPath)) {
  const html = readFileSync(htmlPath, 'utf8');
  if (!html.includes('dsh-pet-bridge:')) {
    problems.push("index.html 的 CSP 缺 dsh-pet-bridge:（表情图会被拦）");
  }
}

if (problems.length > 0) {
  console.error('[prepack] 检查没过：');
  for (const p of problems) console.error('  ✗', p);
  process.exit(1);
}

console.log(`[prepack] ok —— ${REQUIRED.length} 个必需文件齐全，壳模块全登记，动画 ${webmCount} 个`);
