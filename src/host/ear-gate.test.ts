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
    assert.match(hostCode, /const EAR_PHASE_TTL_MS = 45_000;/, '45 秒（11-16 晚收短，原来两分钟太长）');
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
    assert.equal(earCode.split("reportEarPhase('listen');").length - 1, 1, '录音开始要报一次 listen');
    assert.equal(earCode.split("reportEarPhase('think');").length - 1, 1, '出字要报一次 think');
    assert.equal(
      earCode.split("reportEarPhase('idle');").length - 1,
      2,
      'reply 和 error 各要撤一次',
    );
  });

  test('长按说话时心跳续命，状态不会半路失效', () => {
    // 宿主那边只有 45 秒有效期（防脚本崩了状态挂死），按住说一分钟就得定时重报。
    assert.match(earCode, /let earPhaseNow = 'idle';/);
    assert.match(earCode, /earHeartbeat = setInterval\(\(\) => \{/);
    assert.match(earCode, /\}, 8000\);/);
    assert.match(earCode, /clearInterval\(earHeartbeat\);/);
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

  test('进入在听 / 在想时收掉头顶气泡（别跟提示层重复）', () => {
    // 哥哥 m24151：头顶气泡（听.py 自己写的「我在听…」60 秒）+ 提示层的【在听】同时挂着。
    const start = hostCode.indexOf('const setEarPhase = (phase: EarPhase): void => {');
    assert.ok(start >= 0, '没找到 setEarPhase');
    const body = hostCode.slice(start, start + 900);
    assert.match(body, /if \(phase !== 'idle'\) \{/);
    assert.match(body, /state\.writePet\('main', 'say', \{ clear: true \}\);/);
  });

  test('回话之前必须先撤状态（否则自己的闸把回话挡住 = 死锁）', () => {
    // 哥哥 m24151：一直【在想】、话说不出来。根因就是 chatWithPet 的回复走 normal，
    // 被 earMuted() 挡成 ear-busy → show() 不执行 → idle 永远不到。
    const at = hostCode.indexOf("void sayWithVoice(petId, generated.text, generated.image);");
    assert.ok(at > 0, '没找到对话回话的 sayWithVoice');
    const before = hostCode.slice(Math.max(0, at - 600), at);
    assert.match(before, /setEarPhase\('idle'\);/, '回话前没撤 ear 状态');
    assert.match(before, /dropHint\('think'\);/);
  });

  test('手按「看一眼」也要先撤状态', () => {
    const at = hostCode.indexOf('const lookOnce = async (');
    assert.ok(at > 0, '没找到 lookOnce');
    const body = hostCode.slice(at, at + 700);
    assert.match(body, /setEarPhase\('idle'\);/);
  });

  test('录音时不写说话气泡、不收第三方气泡', () => {
    assert.match(hostCode, /if \(earQuiet\(\)\) return;/);
    assert.match(hostCode, /\{ ok: false, reason: 'ear-busy' \}/);
  });
});