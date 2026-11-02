#!/usr/bin/env node
/**
 * dsh-pet 独立模式入口 —— 不打开 DSH 也能养桌宠。
 *
 * 它把三件事串起来（每一步都复用插件自己的实现，没有第二份业务逻辑）：
 *   1. `./context` 造一个伪 Cordis ctx，把插件的宿主半边（`src/host/index.ts` 的 `apply`）跑起来；
 *   2. `./server` 起一个真正的 `node:http` 服务，把 `apply` 注册的 prefix handler 接上去
 *      （路由表仍然只有插件那一份）；
 *   3. 插件自己的 `launchHelper` 因此照常探测 Electron、按配置拉起透明置顶小窗，
 *      并与宿主经 bridge 管道通信 —— 与 DSH 内运行完全同一条路径。
 *
 * 用法：
 *   npx dsh-pet-standalone              # 插件装好后直接跑（package.json 的 bin）
 *   npm run standalone                  # 仓库里跑（先安装依赖并 npm run build）
 *   node lib/standalone.js --port 3081
 *   node lib/standalone.js --check      # 只体检，不开窗口
 *
 * 独立模式的边界：动画、物理拖拽、右键菜单、多开、自定义素材与宠物种类全部可用；
 * 余额、碎碎念、对话、系统通知依赖 DSH 的凭证/模型/会话，在独立模式下明确不可用
 * （结构化失败 + 日志，不假装成功）。详见 README 的「独立运行（不打开 DSH）」一节。
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { flattenPetList, readAllConfig } from '../host/config';
import { dshHomeDir, packageRoot } from '../host/helper-process';
import { apply } from '../host/index';
import { runCheck, packageVersion } from './check';
import { createStandaloneAi } from './ai-provider';
import { createPetSettingsService } from './pet-settings';
import { createRequestSecurity } from './request-security';
import { writeStandaloneRuntime } from './runtime-state';
import {
  createStandaloneContext,
  createStandaloneLogger,
  type RegisteredRoute,
  type StandaloneLogger,
} from './context';
import { configPathsFor, describePets, isDesktopVisible, parseArgs, USAGE } from './options';
import { listenStandaloneServer } from './server';

/** 启动独立模式：先起服务拿到端口，再 `apply`（插件据此拼桌面 Helper 的 configUrl） */
async function run(logger: StandaloneLogger, options: { port: number }): Promise<void> {
  const home = dshHomeDir();
  const paths = configPathsFor(packageRoot, home);

  // 预检：包内默认配置读不到时宿主半边必然每请求失败；早给可操作的诊断，别让用户对着空桌面猜
  if (!existsSync(paths.defaultFile)) {
    logger.error(
      `包内默认配置缺失：${paths.defaultFile}。若你是在直接跑源码（包根被解析成了 src/），` +
        '请改用构建产物：npm run bundle 后 node lib/standalone.js（或 npm run standalone）。',
    );
    process.exitCode = 1;
    return;
  }

  const routes: RegisteredRoute[] = [];
  const portRef = { value: options.port };
  const ai = createStandaloneAi(home, logger);
  // 保存桌宠设置后要让桌面小窗按新配置重开；重开接口在服务起来之后才存在，
  // 所以先留一个转发器，服务就绪后把真实实现填进去（配置落盘时机早于保存动作）。
  let reloadDesktop: () => void = () => {};
  const petSettings = createPetSettingsService(paths.userFile, () => reloadDesktop());
  const security = createRequestSecurity();
  // 托盘「退出」要调的是后面才定义的 shutdown：同样用转发器解耦（apply 时它还没定义）
  let quitFromTray: () => void = () => {};
  const context = createStandaloneContext({
    port: () => portRef.value,
    logger,
    routes,
    ai,
    authenticatedUrl: security.authenticatedUrl,
    // 托盘那三项只在独立版存在：地址/令牌此时还没算出来，所以传**函数**，点的时候才读。
    petTray: {
      settingsUrl: () => petSettingsUrl,
      aiSettingsUrl: () => settingsUrl,
      quit: () => quitFromTray(),
      token: () => security.token,
    },
  });
  // /shutdown 的回调要在服务构造时给出去，而停机函数要在服务之后定义：
  // 用一个可替换的转发器解耦（服务构造时只拿到"将来会是谁"）。
  let forwardShutdown: () => void = () => {};
  const server = await listenStandaloneServer({
    routes,
    logger,
    port: options.port,
    security,
    ai,
    pet: petSettings,
    status: () => ({
      name: 'dsh-pet-standalone',
      pid: process.pid,
      pluginRoot: packageRoot,
      plugin: { root: packageRoot, version: packageVersion(packageRoot) },
      port: portRef.value,
      uptimeSec: Math.round(process.uptime()),
    }),
    onShutdown: () => forwardShutdown(),
  });
  portRef.value = server.port;
  // 内部自请求：host 头由 fetch 自动填成本进程地址；鉴权只带 x-dsh-pet-token（别设 Origin）
  const internalRequest = async (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), 'x-dsh-pet-token': security.token },
    });
  reloadDesktop = () => {
    void internalRequest('/dsh-pet-7340/reload', { method: 'POST' }).catch((error: unknown) => {
      logger.warn(`桌面小窗重开失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const settingsUrl = security.authenticatedUrl(`http://127.0.0.1:${server.port}`);
  const petSettingsUrl = settingsUrl.replace('/standalone-ai/', '/standalone-pet/');
  let releaseRuntime: () => void;
  try {
    releaseRuntime = writeStandaloneRuntime(home, {
      port: server.port,
      token: security.token,
      settingsUrl,
      pluginRoot: packageRoot,
    });
  } catch (error) {
    await context.dispose();
    await server.close();
    throw error;
  }

  let menuPolling = true;
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    menuPolling = false;
    logger.info(`收尾（${reason}）…`);
    // 先释放插件注册的 effect（停桌面 Helper、清周期定时器），再关服务
    try {
      await context.dispose();
    } finally {
      await server.close();
      releaseRuntime();
    }
    logger.info('已退出。');
  };
  const requestShutdown = (reason: string): void => {
    shutdown(reason)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error(`收尾失败：${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
  };
  forwardShutdown = () => requestShutdown('POST /shutdown');
  // 托盘「退出桌宠」= 走同一条收尾路径（停 Helper、关服务、删能力文件），不是直接 process.exit：
  // 少了这一步会留下孤儿 Electron 窗口和占着端口不放的僵尸服务。
  quitFromTray = () => requestShutdown('托盘菜单');
  process.on('SIGINT', () => requestShutdown('SIGINT'));
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));

  // 起插件宿主半边：路由表、状态仓、桌面 Helper（含 bridge 管道）都在这一句里
  apply(context.ctx);

  // —— 右键菜单入口 ——
  // 右键菜单只能注册 label（没有 URL 字段），所以本进程负责：注册两项 + 长轮询等点击 + 开浏览器。
  // 菜单项不注册也行（设置地址仍会打在启动横幅上），因此这里失败只降级警告，不拦启动。
  const openInBrowser = (url: string): void => {
    const isWin = process.platform === 'win32';
    const command = isWin ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = isWin ? ['/c', 'start', '', url] : [url];
    try {
      spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (error) {
      logger.warn(
        `打开设置页失败（请手动访问 ${url}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const registerMenu = async (): Promise<boolean> => {
    try {
      const res = await internalRequest('/dsh-pet-7340/menu/item', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: 'standalone', labels: ['打开设置'] }),
      });
      const payload = (await res.json()) as { ok?: boolean; message?: string };
      if (payload.ok !== true) throw new Error(payload.message ?? '注册被拒绝');
      return true;
    } catch (error) {
      logger.warn(`右键菜单入口注册失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  const watchMenu = async (): Promise<void> => {
    let registered = await registerMenu();
    while (menuPolling) {
      if (!registered) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        registered = await registerMenu();
        continue;
      }
      try {
        const res = await internalRequest('/dsh-pet-7340/menu/events?owner=standalone&wait=10000');
        const payload = (await res.json()) as { ok?: boolean; events?: Record<string, string | null> };
        // ok:false = 这个 owner 已经不在了（宿主重开过）：重新注册，再继续等
        if (payload.ok !== true) {
          registered = false;
          continue;
        }
        for (const [label, pet] of Object.entries(payload.events ?? {})) {
          if (pet === null) continue; // 读取即消费：没点过的是 null
          openInBrowser(petSettingsUrl);
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  };
  void watchMenu();

  let pets: Record<string, unknown>[] = [];
  let configSource = paths.userFile;
  try {
    pets = flattenPetList(readAllConfig(paths));
    if (!existsSync(paths.userFile)) configSource = `${paths.userFile}（不存在 → 用包内默认）`;
  } catch (error) {
    logger.warn(
      `读配置失败（服务照常运行，相关端点会显式报错）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const desktopVisible = pets.filter(isDesktopVisible);
  for (const line of [
    '',
    '===== dsh-pet 独立模式（不需要 DSH）=====',
    `  插件        dsh-pet@${packageVersion(packageRoot)}  ${packageRoot}`,
    `  路由        http://127.0.0.1:${server.port}/dsh-pet-7340/`,
    `  配置        ${configSource}`,
    `  宠物        ${describePets(pets)}`,
    desktopVisible.length === 0
      ? '  桌面小窗    0 只：display 需要 desktop 或 both 才会出现透明小窗（服务仍在运行）'
      : `  桌面小窗    ${desktopVisible.length} 只`,
    `  外观设置    ${petSettingsUrl}`,
    ai.isReady()
      ? '  AI          本机 API 已启用；自动碎碎念遵循设置页开关'
      : '  AI          未配置或未启用，不发送模型请求；右键“打开设置”后在本机填写',
    '  不可用      余额 / 会话工作状态 / DSH 系统通知',
    '  退出        Ctrl+C，或 POST /shutdown',
    '',
  ]) {
    logger.info(line);
  }
  if (context.failures.length > 0) {
    logger.warn(`初始化期间有 ${context.failures.length} 项失败（见上方日志）；路由仍可用，相关端点会显式报错`);
  }
}

/** CLI 入口 */
async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`dsh-pet-standalone: ${parsed.error}\n`);
    console.error(USAGE);
    return 2;
  }
  const { options } = parsed;
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const logger = createStandaloneLogger();
  if (options.check) return runCheck(logger);
  await run(logger, options);
  return 0;
}

// 本文件就是可执行入口（package.json 的 bin 指向构建产物 lib/standalone.js），
// 因此无条件启动：不做 import.meta.main / argv[1] 比较之类的守卫 ——
// import.meta.main 要 Node 24+，而 argv[1] 比较在 pnpm 的 bin 符号链接下会判错。
main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(`dsh-pet-standalone: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  });
