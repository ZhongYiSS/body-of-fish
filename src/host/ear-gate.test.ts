/**
 * 「在听 / 在想」与「截图不错位」的契约测试（哥哥 m24046 的三件反馈）。
 *
 * 三件事都是「时序 / 状态」问题，编译器看不出来，只能钉源码：
 *   1. 抓屏进程重启时必须把残留半帧清掉 —— 不清就是**每一帧都错位**，
 *      落到图上就是横纹、斜切、缺一块（哥哥看到的就是这个）。
 *   2. 录音挂【在听】、出字换【在想】、开口就撤 —— 三个状态都要真的落到提示层。
 *   3. 在听 / 在想的时候别的声音和气泡让路（urgent 手动动作例外）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const host = read('./index.ts');
const watch = read('./watch-mode.ts');
const ear = readFileSync(fileURLToPath(new URL('../../runtime/electron-helper/ear.js', import.meta.url)), 'utf8');

/** 只留代码行（注释里也会提到这些词，不能算实现） */
const codeOnly = (source: string): string =>
  source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
    })
    .join('\n');

const hostCode = codeOnly(host);
const watchCode = codeOnly(watch);
const earCode = codeOnly(ear);

describe('自动截图：抓屏重启不许留着半帧', () => {
  test('spawnCapture 里清空 pending / pendingLen', () => {
    const start = watchCode.indexOf('function spawnCapture()');
    assert.ok(start >= 0, '没找到 spawnCapture');
    const body = watchCode.slice(start, start + 1_200);
    assert.match(body, /pending = \[\];/, '重启时没清残留字节 —— 新流的帧会从旧偏移接着拼，图上就是横纹');
    assert.match(body, /pendingLen = 0;/, 'pendingLen 没归零，长度判断会错一位');
  });
});

describe('在听 / 在想：三个状态都要落到提示层', () => {
  test('setEarPhase 三条分支齐全', () => {
    assert.match(host, /type EarPhase = 'idle' \| 'listen' \| 'think';/);
    assert.match(hostCode, /pushHint\('ear', '【在听】', 'task'\);/);
    assert.match(hostCode, /pushHint\('ear', '【在想】', 'task'\);/);
    assert.match(hostCode, /dropHint\('ear'\);/);
  });

  test('状态有兜底失效，不会因为脚本崩了永久挂着', () => {
    assert.match(hostCode, /const EAR_PHASE_TTL_MS = 120_000;/);
    assert.match(hostCode, /earPhaseAt > EAR_PHASE_TTL_MS/);
  });

  test('POST /ear 把 phase 收下来', () => {
    assert.match(hostCode, /if \(rest === 'ear'\) \{/);
    assert.match(hostCode, /setEarPhase\(phase\);/);
    assert.match(hostCode, /\{ ok: true, phase: earPhaseNow\(\) \}/);
  });

  test('壳把 rec-start / text / reply / error 翻成 listen / think / idle', () => {
    assert.match(earCode, /async function postEarPhase\(phase\)/);
    assert.match(earCode, /await fetch\(petBase\(\) \+ '\/ear'/);
    assert.equal(
      earCode.split("void postEarPhase('listen');").length - 1,
      1,
      '录音开始要报一次 listen',
    );
    assert.equal(earCode.split("void postEarPhase('think');").length - 1, 1, '出字要报一次 think');
    assert.equal(
      earCode.split("void postEarPhase('idle');").length - 1,
      2,
      'reply 和 error 各要撤一次',
    );
  });
});

describe('在听 / 在想：别的声音和气泡让路', () => {
  test('生成期间挂【在想】，开口那一刻撤', () => {
    assert.match(hostCode, /pushHint\('think', '【在想】', 'task', 180_000\);/);
    assert.match(
      hostCode,
      /dropHint\('think'\);[\s\S]{0,200}setEarPhase\('idle'\);/,
      '开口那一刻要同时撤【在想】和【在听】',
    );
  });

  test('centerSay / centerPlayClip 对非 urgent 让路', () => {
    assert.equal(
      hostCode.split("message: 'ear-busy'").length - 1,
      2,
      'centerSay 与 centerPlayClip 各一道闸（writeSayBubble 是静默 return）',
    );
    assert.match(hostCode, /if \(earMuted\(\) && \(req\.priority \?\? 'normal'\) !== 'urgent'\)/);
    assert.match(hostCode, /if \(earMuted\(\) && \(req\.priority \?\? 'urgent'\) !== 'urgent'\)/);
  });

  test('录音时不写说话气泡、不收第三方气泡', () => {
    assert.match(hostCode, /if \(earQuiet\(\)\) return;/);
    assert.match(hostCode, /\{ ok: false, reason: 'ear-busy' \}/);
  });
});