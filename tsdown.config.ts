import { defineConfig } from 'tsdown';

/**
 * dsh-pet2 构建配置 —— 三个入口，对应 package.json 的三处声明：
 *   lib/index.js       ← main / cordis.patch.yml 的 name
 *   lib/client.js      ← exports['./client']（浏览器半侧）
 *   lib/standalone.js  ← bin.dsh-pet-standalone（独立模式，保留下来的那个）
 *
 * @deepseek-ai/* 是宿主的 peerDependencies，运行期由 DSH 提供，一律不打包。
 */
const external = [/^@deepseek-ai\//, /^react($|\/)/, /^react-dom($|\/)/, 'electron'];

export default defineConfig([
  {
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    dts: false,
    external,
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    external,
  },
  {
    entry: { standalone: 'src/standalone/cli.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    dts: false,
    // 独立模式要能脱离 node_modules 跑（打进 exe 时只带 lib/ 与 assets/）：除 electron 本体外
    // 所有依赖都必须内联，否则 Electron 里会 ERR_MODULE_NOT_FOUND（@electron/get 就是这么炸的）。
    // 注意 DSH 的 @deepseek-ai/* 在这里也要内联——exe 里没有宿主的那套包。
    external: ['electron'],
    noExternal: [/.*/],
    // 不允许拆出共享 chunk：exe 里只搬 standalone.js 一个文件，拆了就会 ERR_MODULE_NOT_FOUND
    outputOptions: { inlineDynamicImports: true },
  },
]);
