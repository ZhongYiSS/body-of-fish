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
    // 11-16 晚：超时不仅「算成 idle」，还得把提示层那行摘掉、状态真的归零，
    // 否则【在听】会挂到天荒地老（哥哥 m24151）。
    assert.match(hostCode, /Date\.now\(\) - earPhaseAt <= EAR_PHASE_TTL_MS/);
    // 11-17：文件是 CRLF，跨行断言要容忍 \r
    assert.match(hostCode, /earPhase = 'idle';\r?\n    dropHint\('ear'\);/);
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
    // 11-16 晚 m24332：按停麦就报 think（rec-stop）。
    // 【11-16 夜 m24648】出字那次不再补报——重复报会把延迟的【在想】重新计时，看着像闪。
    assert.equal(earCode.split("reportEarPhase('think');").length - 1, 1, '只有按停麦报 think');
    // 11-16 晚第二轮自查：脚本进程自己退出或报错也要撤（3 次）——
    // 不撤的话心跳会一直替它喊「在听」，宿主 45 秒兜底永远等不到，就成永久闭嘴。
    // 【11-17 m24756】reply 不再撤：reply 只是文字到了，声音还要合成两秒，早撤就是「说话前闪一下」。
    // 收尾交给宿主——第一句音频真的开播时它自己 setEarPhase('idle')。
    assert.equal(
      earCode.split("reportEarPhase('idle');").length - 1,
      3,
      'error、进程退出、进程报错各撤一次（reply 不撤）',
    );
    const replyAt = earCode.indexOf("event.event === 'reply'");
    assert.ok(replyAt > 0, '没找到 reply 分支');
    const errAt = earCode.indexOf("event.event === 'error'", replyAt);
    assert.ok(errAt > replyAt, '没找到 error 分支');
    assert.ok(
      !earCode.slice(replyAt, errAt).includes("reportEarPhase('idle')"),
      'reply 里不许再撤状态（那会让【在想】在出声前提前消失）',
    );
  });

  test('按停麦就切【在想】（不等 ASR 出字）', () => {
    // 哥哥 m24332：点停止之后再点一次，【在听】要马上变【在想】。
    // 听.py 现在按停就 emit rec-stop，壳把它翻成 think。
    assert.match(earCode, /event\.event === 'rec-stop'/);
    const at = earCode.indexOf("event.event === 'rec-stop'");
    const body = earCode.slice(at, at + 260);
    assert.match(body, /reportEarPhase\('think'\)/);
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
    // 11-16 晚第二轮自查：以前 chatWithPet 自己 push 一行【在想】、setEarPhase 又推一行 → 屏幕上两行一样的。
    // 现在只由 ear 状态那一条通道出提示。
    assert.match(hostCode, /setEarPhase\('think'\);/);
    assert.ok(!hostCode.includes("pushHint('think', '【在想】', 'task', 180_000)"), '旧的 180 秒提示不该还在');
    assert.match(
      hostCode,
      /dropHint\('think'\);[\s\S]{0,200}setEarPhase\('idle'\);/,
      '开口那一刻要同时撤【在想】和【在听】',
    );
  });

  test('centerSay / centerPlayClip 对非 urgent 让路', () => {
    // 11-16 晚：闸口现在是三处 —— centerSay、centerPlayClip，以及给外面推来的 /say-loud
    // （桥那边一律 urgent，不挡就是「在听时别人插嘴」）。（writeSayBubble 是静默 return，不带 message。）
    assert.equal(
      hostCode.split("message: 'ear-busy'").length - 1,
      2,
      'centerSay 与 centerPlayClip 各一道闸（这两条是 Promise 返回值，用 message）',
    );
    assert.ok(
      hostCode.split("reason: 'ear-busy'").length - 1 >= 1,
      '/broadcast（外部推来的气泡）在「正在录」时用 reason 回 ear-busy',
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
    // 11-17 第 2 批：回话优先级改由事件等级换算（`priorityFor(heard.level)`），断言跟着改
    const at = hostCode.indexOf("void sayWithVoice(petId, generated.text, generated.image, priorityFor(heard.level))");
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

  test('在听/在想时不写说话气泡、不收第三方气泡', () => {
    // 11-16 晚第三轮（m24524）：气泡闸只挡「正在录」——「在想」阶段她自己的回话要走这条路，
    // 挡了就是有字无声。earQuiet 已删除，第三方气泡改走 /broadcast 的 listen 判断。
    // 11-16 晚 m24332：她自己的「让我想想…」占位要能写出去（那时正是 think），所以留了 force 例外。
    assert.match(hostCode, /if \(earPhaseNow\(\) === 'listen'\) return;/, 'writeSayBubble 只在录音时让位');
    assert.match(hostCode, /\{ ok: false, reason: 'ear-busy' \}/);
    assert.ok(!hostCode.includes('earQuiet'), 'earQuiet 应该已经删干净');
  });

  test('她的回话通道 /say-loud 不再按耳语状态让路（m24524 的声音丢失）', () => {
    // 听.py 的 emit(reply) 与 /say-loud 几乎同刻，ear.js 的 idle 常晚一拍；
    // 让路会把「她自己的回话」挡掉 → 说了没声音。
    assert.ok(
      !hostCode.includes('在听/在想，这条让路'),
      '/say-loud 不该再按耳语状态让路',
    );
  });

  test('心跳只给「在听」续命，不给「在想」续命（出声前闪一下的根因）', () => {
    assert.match(ear, /if \(phase === 'listen'\) \{/, '心跳只在 listen 时装');
    assert.match(ear, /if \(earPhaseNow === 'listen'\) void postEarPhase\('listen'\);/);
  });
});