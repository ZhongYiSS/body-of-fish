/**
 * 「听」：全局热键 Alt+T → 拉起/驱动 D:\AI\工具箱\听.py。
 *
 * 为什么热键在桌宠这一层：Electron 的 globalShortcut 是唯一能全局收键的地方
 * （渲染进程只在窗口聚焦时收得到键，关着窗就废了）。所以主进程只做两件事：
 *   ① 第一次按时拉起常驻的 听.py（它自己管录音、识别、回话、念出来）
 *   ② 之后每次按时往它的 stdin 写一行 `toggle`（按一下开始录、再按一下停）
 *
 * 听.py 的 stdout 是逐行 JSON 事件（ready / rec-start / text / reply / error），
 * 这里只把事件写进 helper 日志，气泡和声音都由 听.py 自己走宿主接口完成。
 *
 * 环境变量不用管：DSH_PET_CONFIG_URL 由宿主注入到本进程，spawn 时自动继承，
 * 听.py 靠它推宿主端口（端口每次重启都变，写死必坏）。
 */
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } = require('node:fs');
const path = require('node:path');

const PYTHON = 'D:\\AI\\GPT-SoVITS\\.venv\\Scripts\\python.exe';
const SCRIPT = 'D:\\AI\\工具箱\\听.py';
const HOTKEY = 'Alt+T';
/** 「看一眼」的默认热键（10-29 加）：和「听」一样可在设置页改 */
const PEEK_HOTKEY = 'Alt+G';
/** 「说一句」的默认热键（10-30 加）：等价于点右键菜单「声音 → 说一句」 */
const SAY_HOTKEY = 'Alt+S';
/** 装好/失败都写一份状态：helper 的 stdout 走宿主管道、看不到，落盘才验得了 */
const STATUS_FILE = 'D:\\AI\\存档\\临时\\桌宠\\ear-status.json';
/** 「听」的事件流水（按热键、录音、识别、回话），排查用 */
const EVENT_LOG = 'D:\\AI\\存档\\临时\\桌宠\\ear.log';
/** 热键改在哪：设置页写的就是这个文件（陪伴插件的 companion.json）；测的时候可用 env 换掉 */
const CONFIG_FILE =
  process.env.DSH_PET_EAR_CONFIG || 'C:\\Users\\hb109\\.dsh\\plugins\\dsh-pet-extras\\companion.json';
/** 多久看一眼设置页有没有改热键 */
const HOTKEY_POLL_MS = 5000;

/**
 * 从 companion.json 读热键。读不到/没写就用默认 Alt+T。
 * 合法性不在这里断言——交给 Electron 的 register 返回结果说话（认什么写法它最清楚）。
 */
function readHotkeys() {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    cfg = {};
  }
  const ear = String((cfg && cfg.earHotkey) || '').trim() || HOTKEY;
  const peek = String((cfg && cfg.peekHotkey) || '').trim() || PEEK_HOTKEY;
  const say = String((cfg && cfg.sayHotkey) || '').trim() || SAY_HOTKEY;
  return { ear, peek, say };
}

/**
 * 宿主接口前缀：`DSH_PET_CONFIG_URL` 形如 http://127.0.0.1:56318/dsh-pet-7340/config。
 * 端口每次重启都变，所以从 env 推，别写死。
 */
function petBase() {
  const url = String(process.env.DSH_PET_CONFIG_URL || '').trim();
  const m = url.match(/^(https?:\/\/[^/]+)(\/[^/]+)?\/config\/?$/);
  if (m) return m[1] + (m[2] || '');
  return 'http://127.0.0.1:3080/dsh-pet-7340';
}

let child = null;
let buffer = '';

function log(msg) {
  console.error('[dsh-pet-desktop-helper] ear: ' + msg);
}

function writeStatus(obj) {
  try {
    mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    writeFileSync(STATUS_FILE, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, obj), null, 2), 'utf8');
  } catch (e) {
    log('写状态文件失败：' + (e && e.message ? e.message : String(e)));
  }
}

function appendEvent(event, extra) {
  try {
    mkdirSync(path.dirname(EVENT_LOG), { recursive: true });
    appendFileSync(EVENT_LOG, new Date().toISOString() + ' ' + event + ' ' + (extra || '') + '\n', 'utf8');
  } catch {
    /* 日志写不进去不影响主流程 */
  }
}

function handleLine(line) {
  const text = String(line || '').trim();
  if (!text) return;
  let event = null;
  try {
    event = JSON.parse(text);
  } catch {
    log('输出不是 JSON：' + text.slice(0, 200));
    return;
  }
  if (!event || !event.event) return;
  appendEvent(event.event, event.text || event.message || event.file || '');
  if (event.event === 'ready') {
    log('就绪 pid=' + event.pid);
    return;
  }
  if (event.event === 'rec-start') {
    log('开始录 ' + (event.file || ''));
    return;
  }
  if (event.event === 'text') {
    log('听到：' + event.text);
    return;
  }
  if (event.event === 'reply') {
    log('回：' + event.text);
    return;
  }
  if (event.event === 'error') {
    log('出错：' + (event.message || ''));
  }
}

function ensureDaemon() {
  if (child) return true;
  if (!existsSync(PYTHON)) {
    log('找不到 python：' + PYTHON);
    return false;
  }
  if (!existsSync(SCRIPT)) {
    log('找不到脚本：' + SCRIPT);
    return false;
  }
  try {
    child = spawn(PYTHON, [SCRIPT], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    log('拉不起来：' + (e && e.message ? e.message : String(e)));
    child = null;
    return false;
  }
  const proc = child;
  buffer = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) log('stderr: ' + text.slice(0, 400));
  });
  proc.on('error', (e) => log('进程错误：' + (e && e.message ? e.message : String(e))));
  proc.on('exit', (code) => {
    appendEvent('exit', 'code=' + code);
    log('进程退出 code=' + code + '（下次按热键会重新拉起）');
    if (child === proc) child = null;
  });
  appendEvent('spawn', 'pid=' + proc.pid);
  return true;
}

/** 按住热键会以 ~30ms 的间隔重复触发（Windows 的自动重复），得把重复的丢掉 */
let lastHotkeyAt = 0;
let hotkeyFired = false;

function toggle() {
  const now = Date.now();
  if (now - lastHotkeyAt > 400) hotkeyFired = false;
  lastHotkeyAt = now;
  if (hotkeyFired) return;
  hotkeyFired = true;
  appendEvent('hotkey', '');
  if (!ensureDaemon()) return;
  if (!child || !child.stdin || !child.stdin.writable) {
    log('管道没准备好，这次按了不算');
    return;
  }
  child.stdin.write('toggle\n');
}

/** 按住键的自动重复也一并丢（与 toggle 同一套去重） */
let lastPeekAt = 0;
let peekFired = false;

/**
 * 按一个右键菜单项，等价于点它（看一眼 / 声音：说一句都走这里）。
 * 做成通用的是因为热键会越来越多：壳这边不需要知道"看了以后做什么"，
 * 具体逻辑全在宿主（陪伴、发声）里。
 */
async function triggerMenu(label, event) {
  const url = petBase() + '/menu/click';
  try {
    const res = await fetch(url, {
      method: 'POST',
      // 能力令牌：不带就是 403「请从桌宠菜单重新打开设置」——「热键按了没反应」正是这个坑
      // （键其实收到了，POST 被门禁吞掉）。令牌只从环境变量来，不落盘。
      headers: {
        'content-type': 'application/json',
        ...(process.env.DSH_PET_API_TOKEN ? { 'x-dsh-pet-token': process.env.DSH_PET_API_TOKEN } : {}),
      },
      body: JSON.stringify({ owner: '本鱼陪伴', label, pet: 'main' }),
    });
    const text = await res.text();
    appendEvent(event + '-result', res.status + ' ' + String(text || '').slice(0, 120));
  } catch (e) {
    appendEvent(event + '-error', e && e.message ? e.message : String(e));
  }
}

/**
 * 「看一眼」热键：走宿主现成的菜单触发接口，等价于点右键菜单第一项「看一眼」。
 * 具体做什么（截图/识图/不看模式只聊一句）全在陪伴插件里，这边不发命令。
 */
async function peek() {
  const now = Date.now();
  if (now - lastPeekAt > 400) peekFired = false;
  lastPeekAt = now;
  if (peekFired) return;
  peekFired = true;
  appendEvent('peek', '');
  await triggerMenu('陪伴：看一眼', 'peek');
}

/** 按住键的自动重复也丢一份（和 peek 同一套去重，各算各的） */
let lastSayAt = 0;
let sayFired = false;

/** 「说一句」热键：直接打宿主的 /say（菜单里已经没有这一项了，走菜单会 delivered:false） */
async function saySomething() {
  const now = Date.now();
  if (now - lastSayAt > 400) sayFired = false;
  lastSayAt = now;
  if (sayFired) return;
  sayFired = true;
  appendEvent('say', '');
  try {
    const res = await fetch(petBase() + '/say', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.DSH_PET_API_TOKEN ? { 'x-dsh-pet-token': process.env.DSH_PET_API_TOKEN } : {}),
      },
      body: '{}',
    });
    const text = await res.text();
    appendEvent('say-result', res.status + ' ' + String(text || '').slice(0, 120));
  } catch (e) {
    appendEvent('say-error', e && e.message ? e.message : String(e));
  }
}

/**
 * 装热键。只在 app ready 之后调用一次。
 * @param {{ globalShortcut: object, log?: (s: string) => void }} opts
 * @returns {{ dispose: () => void }}
 */
function installEar(opts) {
  const shortcuts = opts && opts.globalShortcut;
  const out = opts && typeof opts.log === 'function' ? opts.log : log;
  const disposeDaemon = () => {
    try {
      if (child && child.stdin && child.stdin.writable) child.stdin.write('quit\n');
    } catch (e) {
      out('收尾写 quit 失败：' + (e && e.message ? e.message : String(e)));
    }
    try {
      if (child) child.kill();
    } catch (e) {
      out('收尾杀进程失败：' + (e && e.message ? e.message : String(e)));
    }
    child = null;
  };
  if (!shortcuts) {
    out('没有 globalShortcut，热键没装');
    return { dispose: disposeDaemon };
  }

  // 三个热键共用一套注册/轮询逻辑：ear = 听，peek = 看一眼（10-29 加），say = 说一句（10-30 加）
  const slots = [
    { key: 'ear', def: HOTKEY, handler: () => toggle(), label: '听' },
    { key: 'peek', def: PEEK_HOTKEY, handler: () => { void peek(); }, label: '看一眼' },
    { key: 'say', def: SAY_HOTKEY, handler: () => { void saySomething(); }, label: '说一句' },
  ];
  for (const slot of slots) slot.current = null;
  let timer = null;
  const bind = (slot, accelerator) => {
    if (!accelerator) return false;
    // 每次按键都留一行证据：哥哥说"按了没反应"时，先看是键没触发还是触发了但动作失败
    // （注册成功 ≠ 按得动；也可能是别的窗口抢了焦点）。证据在 ear-events.log 里。
    const wrapped = () => {
      appendEvent('trigger', slot.key + ' ' + accelerator);
      try {
        slot.handler();
      } catch (e) {
        appendEvent('trigger-error', slot.key + ' ' + (e && e.message ? e.message : String(e)));
      }
    };
    try {
      return shortcuts.register(accelerator, wrapped) === true;
    } catch (e) {
      out('注册热键异常（' + accelerator + '）：' + (e && e.message ? e.message : String(e)));
      return false;
    }
  };
  const report = (want) =>
    writeStatus({
      hotkey: slots[0].current,
      requested: want.ear,
      registered: Boolean(slots[0].current),
      peekHotkey: slots[1].current,
      peekRequested: want.peek,
      peekRegistered: Boolean(slots[1].current),
      sayHotkey: slots[2].current,
      sayRequested: want.say,
      sayRegistered: Boolean(slots[2].current),
      helperPid: process.pid,
      python: PYTHON,
      script: SCRIPT,
      pythonExists: existsSync(PYTHON),
      scriptExists: existsSync(SCRIPT),
    });

  const want = readHotkeys();
  for (const slot of slots) {
    const acc = want[slot.key];
    if (bind(slot, acc)) {
      slot.current = acc;
      out(slot.label + '热键已装：' + acc);
    } else {
      out(slot.label + '热键注册失败（可能被别的程序占了）：' + acc);
    }
  }
  report(want);

  // 设置页改了就自己跟上：每 5 秒看一眼 companion.json 里的 earHotkey / peekHotkey
  timer = setInterval(() => {
    const next = readHotkeys();
    let changed = false;
    for (const slot of slots) {
      const acc = next[slot.key];
      if (acc === slot.current) continue;
      changed = true;
      const old = slot.current;
      if (old) {
        try {
          shortcuts.unregister(old);
        } catch {
          /* 忽略 */
        }
        slot.current = null;
      }
      if (bind(slot, acc)) {
        slot.current = acc;
        appendEvent('hotkey-change', slot.key + ' old=' + (old || '') + ' new=' + acc);
        out(slot.label + '热键换成：' + acc);
      } else if (old && bind(slot, old)) {
        slot.current = old;
        appendEvent('hotkey-change-fail', slot.key + ' want=' + acc + ' 仍用=' + old);
        out(slot.label + '热键 ' + acc + ' 注册不上（被占了？），还用 ' + old);
      } else {
        appendEvent('hotkey-change-fail', slot.key + ' want=' + acc);
        out(slot.label + '热键 ' + acc + ' 注册不上，现在没有可用的热键');
      }
    }
    if (changed) report(next);
  }, HOTKEY_POLL_MS);
  timer.unref?.();

  return {
    dispose: () => {
      if (timer) clearInterval(timer);
      timer = null;
      for (const slot of slots) {
        try {
          if (slot.current) shortcuts.unregister(slot.current);
        } catch {
          /* 忽略 */
        }
        slot.current = null;
      }
      disposeDaemon();
    },
  };
}

module.exports = { installEar, HOTKEY, PEEK_HOTKEY, SAY_HOTKEY };
