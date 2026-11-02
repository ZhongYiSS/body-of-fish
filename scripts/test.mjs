#!/usr/bin/env node
/**
 * test.mjs —— `pnpm test` 的真身。
 *
 * 为什么不直接写 `node --test src/**\/*.test.ts`：
 *   1. Windows 的 cmd 不会展开 `**`，必须自己把测试文件列出来传给 node；
 *   2. 本机把 temp 目录指到本会话**没有写权限**的位置（C:\Users\...\Temp），
 *      而部分测试要 mkdtemp → 全部 EPERM 失败。所以这里统一把
 *      TEMP/TMP/TMPDIR 指到 D 盘的临时目录，再起子进程。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = 'D:\\AI\\存档\\临时\\pet2-test-tmp';
mkdirSync(TMP, { recursive: true });

function collect(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      collect(abs, out);
    } else if (ent.name.endsWith('.test.ts') || ent.name.endsWith('.test.mjs')) {
      out.push(abs);
    }
  }
  return out;
}

const files = collect(join(ROOT, 'src'))
  .map((abs) => relative(ROOT, abs).split(sep).join('/'))
  .sort();
if (files.length === 0) {
  console.error('[test] 没找到任何 *.test.ts');
  process.exit(1);
}

const args = [
  '--experimental-strip-types',
  '--import',
  // 注意：--import 收绝对 Windows 路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME，必须给 file:// URL
  pathToFileURL(resolve(ROOT, 'scripts/test-register.mjs')).href,
  '--test',
  ...files,
];

const child = spawn(process.execPath, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, TEMP: TMP, TMP: TMP, TMPDIR: TMP },
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
