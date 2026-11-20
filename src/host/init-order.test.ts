/**
 * 启动顺序的钉子测试（源码层，不跑宿主）。
 *
 * 起因（2026-11-20 实测）：独立模式日志里冒出
 *   `ERROR 初始化某项失败（已跳过）：Cannot access 'screensDir' before initialization`
 * ——`ctx.effect` 注册时**当场执行**（里面会 prune 屏幕流水），但 `screensDir` 的 `const`
 * 声明写在使用点后面，撞了 TDZ；那一条初始化被整体跳过，屏幕流水的保留策略悄悄不生效。
 *
 * 这一类错 tsc 查不出来（同一函数体里），只有真起一个实例才会炸，
 * 所以在这儿钉死：这几个「初始化时就要用的目录常量」必须声明在第一次使用之前。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'index.ts'), 'utf8');

/** 某个 const 的声明位置（-1 表示没找到） */
function declAt(name: string): number {
  // 两种写法都认：`const x = …` 和带类型标注的 `const x: T = …`
  const plain = source.indexOf(`const ${name} =`);
  const typed = source.indexOf(`const ${name}:`);
  const hits = [plain, typed].filter((n) => n >= 0);
  return hits.length === 0 ? -1 : Math.min(...hits);
}

test('screensDir 必须声明在 ctx.effect 里第一次用到它之前（防 TDZ）', () => {
  const decl = declAt('screensDir');
  assert.ok(decl > 0, '找不到 screensDir 的声明');
  const firstUse = source.indexOf('pruneDir(screensDir');
  assert.ok(firstUse > 0, '找不到 initialize 阶段的 pruneDir(screensDir)');
  assert.ok(decl < firstUse, `screensDir 声明在第 ${decl} 字符，使用在第 ${firstUse} 字符——顺序反了`);
});

test('userRoot 与 memoryStore 的声明顺序：userRoot 先', () => {
  const root = declAt('userRoot');
  const store = declAt('memoryStore');
  assert.ok(root > 0 && store > 0);
  assert.ok(root < store, 'userRoot 要在 memoryStore 之前');
});