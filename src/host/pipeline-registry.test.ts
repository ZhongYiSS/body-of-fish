/**
 * 接线表的结构契约（11-19 注册表薄版）。
 *
 * 钉三件事：
 *  1. `index.ts` 只注册一次，且三张表齐全；
 *  2. `makeEvent` 只许在 `sources/` 里出现——事件从哪来只有三个地方说了算；
 *  3. 每个 sink 都有 spec（`*_SINK`），`/v1/describe` 能把它报出来。
 *
 * 破了这三条，表现是「加了一个入口，但没人记账 / 查日志查不到」——很难靠行为测试发现。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const here = import.meta.dirname;
const indexCode = readFileSync(join(here, 'index.ts'), 'utf8').split('\r\n').join('\n');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

test('接线表：3 个输入 / 2 个想 / 5 个输出，各注册一次', () => {
  const count = (pattern: RegExp): number => [...indexCode.matchAll(pattern)].length;
  assert.equal(count(/registry\.registerSource\(/gu), 3, '三个输入');
  assert.equal(count(/registry\.registerMind\(/gu), 2, '两个想');
  assert.equal(count(/registry\.registerSink\(/gu), 5, '五个输出');
  assert.equal(count(/createRegistry\(/gu), 1, '注册表只建一次');

  for (const spec of ['EAR_SOURCE', 'MANUAL_SOURCE', 'VISION_SOURCE']) {
    assert.match(indexCode, new RegExp(`registry\\.registerSource\\(${spec}\\)`, 'u'), `缺 ${spec}`);
  }
  for (const spec of ['CHAT_MIND', 'SCREEN_MIND']) {
    assert.match(indexCode, new RegExp(`registry\\.registerMind\\(${spec}\\)`, 'u'), `缺 ${spec}`);
  }
  for (const spec of ['MOUTH_SINK', 'BUBBLE_SINK', 'HINT_SINK', 'ANIM_SINK', 'HANDOFF_SINK']) {
    assert.match(indexCode, new RegExp(`registry\\.registerSink\\(${spec}\\)`, 'u'), `缺 ${spec}`);
  }
});

test('接线表：三条输入都真的在产事件（不许注册了却没人用）', () => {
  // 耳朵那条要先把事件留个引用（`heard.level` 后面还要用），所以分开写
  assert.match(indexCode, /const heard = earEvent\(text\);/u, '耳朵没用上');
  assert.match(indexCode, /registry\.emitSense\(heard\);/u, '耳朵事件没进接线表');
  assert.match(indexCode, /registry\.emitSense\(manualEvent\(/u, '手动没用上');
  assert.match(indexCode, /registry\.emitSense\(visionEvent\(/u, '眼睛没用上');
});

test('接线表：makeEvent 只许出现在 sources/ 里', () => {
  const offenders = walk(here)
    .filter((file) => !/\.test\.ts$/u.test(file))
    .filter((file) => !file.includes(`${join('host', 'sources')}`))
    // 定义在那里，不算「谁自己造事件」
    .filter((file) => !file.endsWith(join('pipeline', 'sense.ts')))
    .filter((file) => readFileSync(file, 'utf8').includes('makeEvent('));
  assert.deepEqual(offenders, [], `这些文件自己造事件了，应该走 sources/：${offenders.join(' / ')}`);
});

test('接线表：每个 sink 一个文件、一个 *_SINK，且写了 entry', () => {
  const dir = join(here, 'sinks');
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
  assert.deepEqual(files.sort(), ['anim.ts', 'bubble.ts', 'handoff.ts', 'hint.ts', 'mouth.ts']);

  for (const [file, spec] of [
    ['anim.ts', 'ANIM_SINK'],
    ['bubble.ts', 'BUBBLE_SINK'],
    ['handoff.ts', 'HANDOFF_SINK'],
    ['hint.ts', 'HINT_SINK'],
    ['mouth.ts', 'MOUTH_SINK'],
  ] as const) {
    const code = readFileSync(join(dir, file), 'utf8');
    assert.match(code, new RegExp(`export const ${spec}: SinkSpec = \\{`, 'u'), `${file} 缺 ${spec}`);
    assert.match(code, /entry: '/u, `${file} 没写 entry（对账要用）`);
  }
});

test('/v1/describe 报的是注册表本身，不是另抄一份', () => {
  const at = indexCode.indexOf("if (rest === 'describe')");
  assert.ok(at > 0, '没有 /v1/describe');
  const body = indexCode.slice(at, at + 260);
  assert.match(body, /data: registry\.describe\(\)/u);
});