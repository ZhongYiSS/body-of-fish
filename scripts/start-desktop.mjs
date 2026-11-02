#!/usr/bin/env node
/**
 * start-desktop.mjs —— 开发流手动拉起桌面壳（不经 DSH 宿主）。
 *
 * 和宿主的 spawn 点（src/host/helper-process.ts）必须保持两条一致：
 *   ① 注入 DSH_PET_HOST_PID，壳才能做「宿主没了就退」的 B 路探测；
 *   ② 删掉 ELECTRON_RUN_AS_NODE —— 这个变量会把 Electron 变成纯 node，
 *      main.js 一开场就崩（issue #63）。
 *
 * 用法：
 *   node scripts/start-desktop.mjs                 # 连默认 3080
 *   node scripts/start-desktop.mjs --port 7340
 *   node scripts/start-desktop.mjs --config-url http://127.0.0.1:3080/dsh-pet-7340/config
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER_DIR = join(ROOT, 'runtime', 'electron-helper');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const port = Number(flag('port', process.env.DSH_PET_PORT || 3080));
const configUrl =
  flag('config-url', process.env.DSH_PET_CONFIG_URL) ||
  `http://127.0.0.1:${port}/dsh-pet-7340/config`;

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh');
const exeName = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? join('Electron.app', 'Contents', 'MacOS', 'Electron') : 'electron';

const candidates = [
  process.env.DSH_PET_ELECTRON_PATH,
  join(dshHome, 'electron', exeName),
  join(ROOT, 'node_modules', 'electron', 'dist', exeName),
].filter(Boolean);

const exe = candidates.find((p) => existsSync(p));
if (!exe) {
  console.error('[start:desktop] 找不到 Electron，候选都试过了：');
  for (const c of candidates) console.error('  -', c);
  console.error('先跑 `pnpm ensure:electron` 落地一份，或用 DSH_PET_ELECTRON_PATH 指路。');
  process.exit(1);
}

const env = {
  ...process.env,
  DSH_PET_CONFIG_URL: configUrl,
  DSH_PET_BRIDGE: '0', // 手动流没有宿主管道，走 HTTP 直连
  DSH_PET_OPEN_TARGET: process.env.DSH_PET_OPEN_TARGET || 'site',
  DSH_PET_HOST_PID: String(process.pid),
};
delete env.ELECTRON_RUN_AS_NODE;

console.log(`[start:desktop] ${exe}`);
console.log(`[start:desktop] config → ${configUrl}`);

const child = spawn(exe, [HELPER_DIR], { cwd: ROOT, env, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) console.log(`[start:desktop] 被信号结束：${signal}`);
  process.exit(signal ? 1 : (code ?? 0));
});
