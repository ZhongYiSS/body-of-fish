import { registerHooks } from 'node:module';
import { accessSync, constants } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * 测试用的模块解析钩子。
 *
 * 为什么需要：`src` 里的 import 是混着写的 —— 一部分带 `.ts` 后缀
 * （`from './anim.ts'`），一部分是省略后缀的老写法（`from './types'`）。
 * 浏览器打包（tsdown/rolldown）两种都认，但裸 `node --test` 只认完整路径，
 * 所以测试前挂这个钩子，按 Node 的解析顺序补后缀。
 *
 * 用法（package.json）：
 *   node --experimental-strip-types --import ./scripts/test-register.mjs --test "src/**\/*.test.ts"
 */
const EXTS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.json', '.jsx'];

function readable(p) {
  try {
    accessSync(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function candidatesFor(base) {
  const out = [];
  // 显式写了后缀：先试把 .js 换成 .ts（TS 的 ESM 习惯），再试原样
  if (/\.(ts|tsx|mts|js|mjs|cjs|json|jsx)$/.test(base)) {
    if (base.endsWith('.js')) out.push(base.slice(0, -3) + '.ts');
    out.push(base);
    return out;
  }
  // 没写后缀：补后缀，再试目录 index
  for (const ext of EXTS) out.push(base + ext);
  for (const ext of EXTS) out.push(join(base, 'index' + ext));
  return out;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:');
    if (!relative) return nextResolve(specifier, context);

    let base;
    try {
      if (specifier.startsWith('file:')) base = fileURLToPath(specifier);
      else {
        const parent = context.parentURL ? fileURLToPath(context.parentURL) : join(process.cwd(), '_root.ts');
        base = resolve(dirname(parent), specifier);
      }
    } catch {
      return nextResolve(specifier, context);
    }

    for (const candidate of candidatesFor(base)) {
      if (readable(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
