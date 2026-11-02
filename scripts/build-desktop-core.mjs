#!/usr/bin/env node
/**
 * build-desktop-core.mjs —— 桌面壳（runtime/electron-helper）的健康检查。
 *
 * 壳是纯 JS + HTML，不需要打包：Electron 直接加载 runtime/electron-helper/main.js，
 * 渲染端加载 index.html。所以这一步不是"构建"，是**进场检查**：
 *   - 必需文件在不在
 *   - 每个 .js 都能通过语法检查（node --check，按 ESM 判）
 *   - index.html 的 CSP 里有 dsh-pet-bridge:（漏了表情图会被拦，气泡只剩 alt 文字）
 *
 * 任何一条不过就非零退出 —— 宁可构建失败，别让壳起不来。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = join(ROOT, 'runtime/electron-helper');
const REQUIRED = ['main.js', 'preload.js', 'renderer.js', 'sprite.js', 'shared-core.js', 'index.html'];

let failed = false;

for (const name of REQUIRED) {
  const abs = join(HELPER, name);
  if (!existsSync(abs)) {
    console.error(`✗ 缺文件 runtime/electron-helper/${name}`);
    failed = true;
  }
}

// 语法检查：只查真正参与运行的文件，历史 .bak 不管
const scripts = readdirSync(HELPER).filter((f) => f.endsWith('.js') && !f.includes('.bak'));
for (const name of scripts) {
  const abs = join(HELPER, name);
  try {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
  } catch (err) {
    console.error(`✗ 语法错误 runtime/electron-helper/${name}`);
    console.error(String(err.stderr ?? err).trim().split('\n').slice(0, 5).join('\n'));
    failed = true;
  }
}

const html = join(HELPER, 'index.html');
if (existsSync(html)) {
  const text = readFileSync(html, 'utf8');
  if (!text.includes('dsh-pet-bridge:')) {
    console.error('✗ index.html 的 CSP 里没有 dsh-pet-bridge:（表情图会被拦）');
    failed = true;
  }
}

const bak = readdirSync(HELPER).filter((f) => f.includes('.bak'));
if (bak.length) {
  console.log(`[desktop-core] 提示：还有 ${bak.length} 个历史 .bak 文件，发布前该清掉`);
}

if (failed) {
  console.error('[desktop-core] 失败');
  process.exit(1);
}
console.log(`[desktop-core] ok（${scripts.length} 个脚本，${statSync(HELPER).isDirectory() ? '目录正常' : '?'}）`);
