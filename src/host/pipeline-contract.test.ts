/**
 * 结构契约测试（待办第 6 条，文档 9.11）。
 *
 * 这一份不测行为，只钉「谁许碰哪片叶子」——因为这类规矩一旦破，表现是「偶尔两个气泡打架」
 * 或者「她说了两句」，很难从行为测试里定位。改代码时如果故意要破，得连这里一起改，
 * 那就等于被迫想一遍。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const here = import.meta.dirname;
const indexCode = readFileSync(join(here, 'index.ts'), 'utf8').split('\r\n').join('\n');

/** 取一个箭头函数的函数体：从签名往后找第一个 `=> {`，再配平花括号。 */
function bodyOf(code: string, signature: string): string {
  const at = code.indexOf(signature);
  assert.ok(at >= 0, `没找到 ${signature}`);
  const arrow = code.indexOf('=> {', at);
  assert.ok(arrow > 0, `${signature} 不是箭头函数？`);
  const open = arrow + 3;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  throw new Error(`${signature} 的函数体没闭合`);
}

test('主气泡：只有三个函数能碰 pets.<id>.say 这片叶子', () => {
  const hits = [...indexCode.matchAll(/writePet\([^)]*'say'/gu)].map((hit) => hit[0]);
  assert.equal(hits.length, 4, `say 叶子只许 4 处写入（收/写/立刻写/收），实际 ${hits.length}`);

  const writer = bodyOf(indexCode, 'const writeSayBubble = (');
  assert.match(writer, /writePet\(petId, 'say', payload\)/u, 'writeSayBubble 要自己写叶子（chat 那条）');
  assert.match(writer, /bubble\.say\(/u, 'writeSayBubble 的 companion 那条交给 core 的 bubble.say');

  const nower = bodyOf(indexCode, 'const writeSayNow = (');
  assert.match(nower, /writePet\(petId, 'say', payload as never\)/u);

  const clearer = bodyOf(indexCode, 'const clearSayBubble = (');
  assert.match(clearer, /clear: true/u);
});

test('副气泡：push 的 id 只许这五个，think 只许被 drop', () => {
  const pushed = [...indexCode.matchAll(/pushHint\('([a-z:]+)'/gu)].map((hit) => hit[1]);
  assert.ok(pushed.length > 0, '一个 pushHint 都没有？');
  const allowed = new Set(['ear', 'status', 'say', 'menu', 'watch', 'thinkScreen']);
  for (const id of pushed) assert.ok(allowed.has(id), `不许 push 这个 id：${id}`);
  assert.ok(!pushed.includes('think'), 'think 只是历史遗留的 drop 目标，不许 push');

  const dropped = [...indexCode.matchAll(/dropHint\('([a-z:]+)'/gu)].map((hit) => hit[1]);
  for (const id of dropped) assert.ok(allowed.has(id) || id === 'think', `drop 了一个不认识的 id：${id}`);
});

test('说话：播放只有一处出口（仲裁中心内部）', () => {
  const calls = [...indexCode.matchAll(/await playAudio\(/gu)];
  assert.equal(calls.length, 2, 'playAudio 只许仲裁中心里两处 await（文字 / 音频片段）');
});

test('pipeline/ 只依赖 types.ts，不回头依赖宿主（类型引用例外）', () => {
  const dir = join(here, 'pipeline');
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  for (const name of files) {
    const code = readFileSync(join(dir, name), 'utf8');
    for (const line of code.split('\n')) {
      const hit = /from '([^']+)'/u.exec(line);
      if (hit === null) continue;
      const spec = hit[1];
      if (!spec.startsWith('..')) continue;
      // `import type { … } from '../core/x'` 允许（只借个类型，不借实现）
      assert.ok(line.trimStart().startsWith('import type'), `${name} 反向依赖了宿主：${line.trim()}`);
    }
  }
});

test('每盏任务灯都有 60/90 秒兜底（11-18 自查：加了 thinkScreen 却忘了 TTL）', () => {
  const lampIds = [...indexCode.matchAll(/pushHint\('([A-Za-z]+)', '[^']*', 'task'/gu)].map((m) => m[1]);
  assert.ok(lampIds.length >= 3, '没扫到任务灯 id');
  const from = indexCode.indexOf('const LAMP_TTL_MS');
  const to = indexCode.indexOf('const lampTimer');
  assert.ok(from > 0 && to > from, '没找到 LAMP_TTL_MS 表');
  const table = indexCode.slice(from, to);
  for (const id of new Set(lampIds)) {
    if (id === 'status') continue; // 状态提示一律 event 类，靠自己的 ttlMs
    assert.match(table, new RegExp(`\\b${id}:\\s*\\d`), `灯 ${id} 没在 LAMP_TTL_MS 里，界面可能永久挂着`);
  }
});

test('上下文两边同步（11-18 m27977）：她说出口的话只在开播那一刻写一次卷', () => {
  // 以前是 chatWithPet 整段记一次，陪伴 / 一眼看一句都不记 —— 所以她会重复
  const said = indexCode.split("kind: 'said'").length - 1;
  assert.equal(said, 1, "index.ts 里 kind: 'said' 只该有一处（runSpeakTextInner 的开播回调）");
  assert.ok(indexCode.includes("?.append({ kind: 'said', text: line })"), '逐句写卷要在 show() 里');
  assert.ok(
    !indexCode.includes("sessionStore.append({ kind: 'said', text: generated.text })"),
    'chatWithPet 不许再整段双写',
  );
});

test('上下文两边同步：屏幕想也带记忆块（陪伴 / 一眼看各一处）', () => {
  assert.ok(indexCode.includes("memoryBlockFor('陪伴')"), '陪伴的 system 要带 memoryBlock');
  assert.ok(indexCode.includes("memoryBlockFor('看一眼')"), '一眼看的 system 要带 memoryBlock');
});

test('换卷检查放在仲裁中心（11-18 缺口①）：所有说话路径都要查，不只在聊天里', () => {
  // 原来只有 chatWithPet 说完才查一次 → 只走陪伴 / 一眼看时卷永远不换
  const sites = [...indexCode.matchAll(/rollIfNeeded\(/gu)].length;
  const calls = indexCode.split('sessionRef?.rollIfNeeded()').length - 1;
  assert.equal(sites, 1, `index.ts 里 rollIfNeeded 只该在 done() 里出现一次（含注释），实际 ${sites}`);
  assert.equal(calls, 1, 'done() 里要用 sessionRef?.rollIfNeeded() 兜住所有说话路径');
  assert.ok(
    !indexCode.includes('.then(() =>\n        sessionStore.rollIfNeeded()'),
    'chatWithPet 不许再单独查一次（会漏掉陪伴/一眼看）',
  );
  const done = bodyOf(indexCode, 'const done = (outcome: SpeakOutcome)');
  assert.match(done, /if \(spec\.kind === 'say'\) void sessionRef\?\.rollIfNeeded\(\)/u, 'done() 里要按 say 收尾换卷');
});

test('换完卷抽卡片（11-18 缺口②）：转 DSH 的模型也要能攒卡，门槛 2 句', () => {
  const remember = bodyOf(indexCode, 'const rememberCards = async (');
  assert.match(remember, /if \(spoken\.length < 2\) return;/u, '门槛放宽到 2 句');
  assert.ok(
    !remember.includes('!usesOwnModel(found.conf)'),
    '不许再用 usesOwnModel 一刀切（转 DSH 时卡片永远是 0 张）',
  );
  assert.match(remember, /if \(usesOwnModel\(found\.conf\)\)/u, '自己有模型才走网关');
  assert.match(remember, /await generateChat\(\s*ctx,/u, '转 DSH 时借宿主聊天口抽卡');
});
