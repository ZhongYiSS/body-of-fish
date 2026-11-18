#!/usr/bin/env node
/**
 * 10.4 迁移（待办第 2 条的收尾）：把老记忆搬成 0.5.x 的三层结构。
 *
 * 干什么：
 *   1. `memory/<日期>.json` 里的 `source:'watch'` 条目 → 搬进 `memory/screens/<日期>.jsonl`（行 `{at,app,title,note}`），然后从当天文件里删掉；
 *   2. 剩下的条目补 `kind`（`role:'user'` → `heard`，`role:'pet'` → `said`）；
 *   3. 确保 `memory/sessions/`、`memory/screens/`、`memory/cards.json` 存在；
 *   4. 没有 `memory/session.json` 时，用今天最近 30 分钟的话开第一卷（本地摘要，不调模型）。
 *
 * 什么时候用：升级到 0.5.x 之后跑一次；以后丢了卷也能重跑（幂等，已经搬过的不再动）。
 * 什么时候别用：别在身体运行中跑（两处同时写 `memory/` 会打架）；先关桌宠。
 * 常见坑：
 *   - 默认**只预演**，不改任何文件；确认过再加 `--yes`。
 *   - `--home <目录>` 指向数据根（默认 `~/.dsh/body-of-fish`）。
 *   - 当天文件里 `source:'watch'` 的文本形如「看到 21:30 在改代码」，迁移时剥掉前缀只留笔记。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const apply = args.includes('--yes');
const homeAt = args.indexOf('--home');
const home = homeAt >= 0 ? args[homeAt + 1] : join(homedir(), '.dsh', 'body-of-fish');
const memDir = join(home, 'memory');
const screensDir = join(memDir, 'screens');
const sessionsDir = join(memDir, 'sessions');

if (!existsSync(memDir)) {
  console.error('找不到记忆目录：' + memDir);
  process.exit(1);
}

const stripWatch = (text) => text.replace(/^(?:看护|看到)\s+\d{1,2}:\d{2}\s*/u, '').trim();
const dayFiles = readdirSync(memDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort();

let moved = 0;
let relabeled = 0;
let touched = 0;
const plans = [];

for (const name of dayFiles) {
  const file = join(memDir, name);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.warn('跳过（不是 JSON）：' + name);
    continue;
  }
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  const watch = turns.filter((turn) => turn && turn.source === 'watch');
  const rest = turns.filter((turn) => !(turn && turn.source === 'watch'));
  const relabel = rest.map((turn) => {
    if (turn.kind !== undefined) return turn;
    relabeled += 1;
    return { ...turn, kind: turn.role === 'user' ? 'heard' : 'said' };
  });
  if (watch.length === 0 && relabel.every((turn, i) => turn === rest[i])) continue;
  touched += 1;
  plans.push({ name, file, raw, watch, relabel });
  moved += watch.length;
}

console.log(`数据根：${home}`);
console.log(`当天文件 ${dayFiles.length} 个；要动 ${touched} 个；搬笔记 ${moved} 条；补 kind ${relabeled} 条。`);
if (!apply) {
  console.log('（预演，没有改任何文件。确认后加 --yes 再跑一次。）');
  process.exit(0);
}

mkdirSync(screensDir, { recursive: true });
mkdirSync(sessionsDir, { recursive: true });

for (const plan of plans) {
  copyFileSync(plan.file, plan.file + '.bak-10-4');
  if (plan.watch.length > 0) {
    const day = plan.name.replace(/\.json$/u, '');
    const lines = plan.watch
      .map((turn) =>
        JSON.stringify({
          at: typeof turn.at === 'number' ? turn.at : Date.now(),
          app: '',
          title: '',
          note: stripWatch(String(turn.text || '')),
        }),
      )
      .filter((line) => line.length > 20)
      .join('\n');
    if (lines !== '') writeFileSync(join(screensDir, `${day}.jsonl`), lines + '\n', 'utf8');
  }
  writeFileSync(plan.file, JSON.stringify({ ...plan.raw, turns: plan.relabel }, null, 2) + '\n', 'utf8');
}

// cards.json：没有就建个空壳
const cardsFile = join(memDir, 'cards.json');
if (!existsSync(cardsFile)) writeFileSync(cardsFile, JSON.stringify({ cards: [] }, null, 2) + '\n', 'utf8');

// 第一卷：今天最近 30 分钟
const sessionFile = join(memDir, 'session.json');
if (!existsSync(sessionFile)) {
  const now = Date.now();
  const today = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const file = join(memDir, `${day}.json`);
  let turns = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      turns = (Array.isArray(parsed.turns) ? parsed.turns : [])
        .filter((turn) => typeof turn.at === 'number' && now - turn.at <= 30 * 60_000)
        .map((turn) => ({
          at: turn.at,
          kind: turn.kind ?? (turn.role === 'user' ? 'heard' : 'said'),
          text: String(turn.text || ''),
        }))
        .filter((turn) => turn.text !== '');
    } catch {
      turns = [];
    }
  }
  const tail = turns
    .filter((turn) => turn.kind !== 'heard')
    .slice(-3)
    .map((turn) => turn.text.replace(/\s+/gu, ' ').trim().slice(0, 60))
    .join('；');
  const summary = `（本地摘要）最近说过：${tail === '' ? '（没有）' : tail}`.slice(0, 300);
  writeFileSync(
    sessionFile,
    JSON.stringify({ id: `s-${now}`, startedAt: now, summaryFrom: summary, turns }, null, 2) + '\n',
    'utf8',
  );
  console.log(`开了第一卷：${turns.length} 条（最近 30 分钟）`);
}

console.log('迁移完成（每个改过的当天文件都留了 .bak-10-4）。');