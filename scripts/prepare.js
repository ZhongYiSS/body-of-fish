#!/usr/bin/env node
/**
 * prepare.js —— `pnpm build` 的真身。
 *
 * 做三件事：
 *   1. 调 tsdown 打三个入口（host / client / standalone）到 lib/；
 *   2. 校验产物真的出来了（缺一个就非零退出，不许"构建成功但没有文件"）；
 *   3. 打印产物大小表，方便肉眼对版本。
 *
 * 为什么不用 `tsdown` 直接当 build 脚本：原包的 build 里还要做素材健康检查、
 * files 收敛（白名单外的文件不能进包），这里先保底做产物校验，其余按需再补。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = ['lib/index.js', 'lib/client.js', 'lib/standalone.js'];

function tsdownBin() {
  const pkgPath = join(ROOT, 'node_modules/tsdown/package.json');
  if (!existsSync(pkgPath)) {
    console.error('[build] 找不到 node_modules/tsdown，先跑 pnpm install');
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsdown;
  if (!bin) {
    console.error('[build] tsdown 的 package.json 里没有 bin 字段');
    process.exit(1);
  }
  return join(dirname(pkgPath), bin);
}

function fmt(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}

console.log('[build] tsdown …');
execFileSync(process.execPath, [tsdownBin()], { cwd: ROOT, stdio: 'inherit' });

let failed = false;
console.log('\n[build] 产物：');
for (const rel of REQUIRED) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    console.error(`  ✗ ${rel} 没生成`);
    failed = true;
    continue;
  }
  const size = statSync(abs).size;
  console.log(`  ✓ ${rel}  ${fmt(size)}`);
  if (size < 1024) {
    console.error(`  ✗ ${rel} 只有 ${size} 字节，明显不对`);
    failed = true;
  }
}

// bin 入口必须有 shebang，否则 `dsh-pet-standalone` 在 unix 上不能直接执行。
// tsdown 0.8 的类型里没有 banner 选项（写了 tsc 会红），构建完自己补一行最稳。
const cliPath = join(ROOT, 'lib/standalone.js');
if (existsSync(cliPath)) {
  const cli = readFileSync(cliPath, 'utf8');
  if (!cli.startsWith('#!')) writeFileSync(cliPath, `#!/usr/bin/env node\n${cli}`);
}

if (failed) {
  console.error('\n[build] 失败');
  process.exit(1);
}
console.log('\n[build] ok');
