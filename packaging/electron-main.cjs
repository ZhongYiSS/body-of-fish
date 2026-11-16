// 打包后的 Electron 主进程入口（electron-builder 通过 extraMetadata.main 指到这里）。
//
// 两种身份，靠命令行参数区分：
//  1) 带 `runtime/electron-helper/main.js` 参数 —— 宿主 spawn 出来的**壳实例**，直接 require 那个 main.js。
//  2) 不带参数 —— 用户双击的**宿主实例**：把自己当 Node 用（ELECTRON_RUN_AS_NODE=1）跑独立版 CLI
//     `lib/standalone.js`；CLI 再通过 DSH_PET_ELECTRON_PATH 用本 exe 拉起壳实例。
//
// 打包后是 GUI 应用、没有控制台，所以全程往 TEMP 下的 dsh-pet-logs\\launcher.log 落日志（同步写，崩溃前也能留痕）。
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { app, dialog } = require('electron');

// 这台机器上 Chromium 拉 GPU 子进程会被拒（error_code=18），随后
// `FATAL: gpu_data_manager_impl_private.cc GPU process isn't usable. Goodbye.`
// 直接自杀 —— 表现就是双击后转两圈什么都没有。桌宠只是小尺寸 webm 动画，
// 关掉 GPU 与子进程沙箱最稳（宿主实例与壳实例都走这个入口，一并生效）。
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('in-process-gpu');

const root = path.dirname(__dirname);
const logDir = path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'dsh-pet-logs');
const logPath = path.join(logDir, 'launcher.log');

function trace(line) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* 日志失败不能影响启动 */
  }
}

const helperArg = process.argv.slice(1).find((arg) => /electron-helper[\\/]main\.js$/i.test(arg));

trace(
  `argv=${JSON.stringify(process.argv)} runAsNode=${process.env.ELECTRON_RUN_AS_NODE || ''} type=${process.type} role=${helperArg ? 'helper' : 'host'}`,
);

process.on('uncaughtException', (err) => trace(`uncaughtException: ${err && err.stack ? err.stack : err}`));
process.on('unhandledRejection', (err) => trace(`unhandledRejection: ${err && err.stack ? err.stack : err}`));

if (helperArg) {
  try {
    require(helperArg);
    trace('helper main.js 已加载');
  } catch (err) {
    trace(`helper 加载失败: ${err && err.stack ? err.stack : err}`);
    throw err;
  }
} else {
  app.whenReady().then(() => {
    // 【汐儿 · 11-16 m23786】单实例：哥哥第二次双击没看到「已经开着一个了」，还留下一个没窗口的幽灵进程。
    // 原因：拦截在 CLI 里、框由 CLI spawn 的 PowerShell 弹，CLI 一退出、宿主还挂着，框容易被吞。
    // 现在宿主自己先看锁，命中就弹原生框、直接退出，连 CLI 都不拉。
    const homeDir =
      process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
        ? process.env.DSH_HOME.trim()
        : path.join(process.env.USERPROFILE || os.homedir(), '.dsh');
    const lockFile = path.join(homeDir, 'body-of-fish', 'standalone.lock');
    let holderPid = 0;
    try {
      holderPid = Number(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid) || 0;
    } catch {
      holderPid = 0;
    }
    if (holderPid > 0) {
      let alive = false;
      try {
        process.kill(holderPid, 0);
        alive = true;
      } catch (err) {
        alive = Boolean(err && err.code === 'EPERM');
      }
      if (alive) {
        trace(`已有实例在跑 pid=${holderPid}，弹框后退出`);
        try {
          dialog.showMessageBoxSync({
            type: 'info',
            title: '本鱼陪伴',
            message: '本鱼已经开着一个了，这个就不开了。',
            detail: '同时开两个会抢声音、抢数据目录。要重开的话，先把桌面上那只关掉。',
            buttons: ['好'],
            noLink: true,
          });
        } catch (err) {
          trace('弹框失败: ' + (err && err.stack ? err.stack : err));
        }
        app.quit();
        return;
      }
    }
    const cli = path.join(root, 'lib', 'standalone.js');
    // 只把 CLI 认识的参数透传过去（Chromium 自己的开关不能让 CLI 看见，否则 CLI 打印用法后退出）。
    const cliArgs = [];
    for (let i = 1; i < process.argv.length; i += 1) {
      const arg = process.argv[i];
      if (arg === '--check') cliArgs.push(arg);
      else if (arg === '--port' && process.argv[i + 1]) {
        cliArgs.push(arg, process.argv[i + 1]);
        i += 1;
      } else if (arg.startsWith('--port=')) cliArgs.push(arg);
    }
    trace(`host ready execPath=${process.execPath} cli=${cli} exists=${fs.existsSync(cli)} cliArgs=${JSON.stringify(cliArgs)}`);
    let sawOutput = false;

    const child = spawn(process.execPath, [cli, ...cliArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.dirname(process.execPath),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_PET_ELECTRON_PATH: process.execPath },
    });

    trace(`spawn 已调用 pid=${child.pid} exitCode=${child.exitCode}`);
    child.on('spawn', () => trace(`child spawn 事件 pid=${child.pid}`));
    child.stdout.on('data', (chunk) => {
      sawOutput = true;
      trace('CLI out: ' + String(chunk).trimEnd());
    });
    child.stderr.on('data', (chunk) => {
      sawOutput = true;
      trace('CLI err: ' + String(chunk).trimEnd());
    });
    child.on('error', (err) => {
      trace(`CLI 启动失败: ${err && err.stack ? err.stack : err}`);
    });
    child.on('close', (code, signal) => {
      trace(`CLI 关闭 code=${code} signal=${signal}`);
      if (!sawOutput) {
        // 【汐儿 · 11-16】以前这里会「在宿主进程内直接加载 CLI」兜底：CLI 一进来就被锁挡回去时，
        // 宿主却留了下来——桌面上看不到窗口、也没在服务，正是哥哥看到的「两个进程」。改成记一笔就退出。
        trace('CLI 未产生任何输出，按失败处理（不留在后台）');
      }
      app.quit();
    });

    setTimeout(() => {
      if (!sawOutput) trace(`15 秒仍无 CLI 输出 pid=${child.pid} exitCode=${child.exitCode}`);
    }, 15000);

    app.on('window-all-closed', () => {});
  });
}
