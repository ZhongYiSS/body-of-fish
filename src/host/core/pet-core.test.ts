/**
 * PetCore 边界的守卫测试。
 *
 * 这一层只有类型、没有实现（P2 才接线），所以测试盯的不是"跑得通"，而是三件
 * 一旦松动就会在别处炸掉的事：
 *
 *   1. **不许 import src/shared**：DSH 的单文件加载约束会把 shared 拆 chunk，
 *      宿主侧一引入就变成"插件加载失败"，而且日志里看不到原因。
 *   2. **接口承诺的路由必须真的存在**：契约里写了 `core.say` → `/broadcast`，
 *      哪天有人把那条路由删了/改名，这里立刻红，而不是等 partner 调空。
 *   3. **宿主侧与 shared 侧的 cue 字面量必须在字面上一致**：两边按约定各写一份
 *      （宿主不能 import shared），靠这条测试钉住"两份必须一样"。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const core = readSource('./pet-core.ts');
const host = readSource('../index.ts');
const sharedState = readSource('../../shared/state.ts');

describe('PetCore 边界', () => {
  test('不许 import src/shared（DSH 单文件加载会拆 chunk 导致插件加载失败）', () => {
    assert.ok(!/from\s+['"][^'"]*shared\//.test(core), 'pet-core.ts 不得 import src/shared 下的任何模块');
    assert.ok(!/from\s+['"]\.\.\/shared/.test(core), 'pet-core.ts 不得 import ../shared');
  });

  test('接口承诺的路由在宿主里真的存在', () => {
    // 契约里的每条"旧 → 新"映射都必须能落到一条真实路由上；删路由就要同步改契约。
    const routes = [
      'config',
      'state',
      'broadcast',
      'bubble/clear',
      'anim',
      'playback',
      'position',
      'throw',
      'lock',
      'reload',
      'work-status',
      'balance',
      'menu/events',
    ];
    const missing = routes.filter((r) => !host.includes(`rest === '${r}'`) && !host.includes(`'${r}'`));
    assert.deepEqual(missing, [], `这些路由在 src/host/index.ts 里找不到了：${missing.join(', ')}`);
  });

  test('宿主侧与 shared 侧的 say 形状字面量一致', () => {
    // shared 的读端（浏览器/壳）："clear 优先、然后必须有非空 text"
    assert.ok(/d\.clear === true\) return \{ kind: 'clear' \}/.test(sharedState), 'shared 读端必须还认 clear 指令');
    assert.ok(/d\.text/.test(sharedState), 'shared 读端必须还读 text');
    // 宿主写下端：两种形态、配图两字段并列
    for (const field of ['image', 'url', 'duration', 'anim']) {
      assert.ok(new RegExp(`\\b${field}\\?:`).test(core), `宿主 SayCue 必须声明 ${field}（与 shared 读端同名）`);
      assert.ok(new RegExp(`d\\.${field}`).test(sharedState), `shared 读端必须读 d.${field}（与宿主写端同名）`);
    }
  });

  test('动画 cue 与播放状态取值和实现一致', () => {
    for (const field of ['name', 'url', 'facing']) {
      assert.ok(new RegExp(`\\b${field}\\?:`).test(core), `AnimCue 必须声明 ${field}`);
    }
    // 播放状态：契约抄的是 playback.ts 的权威取值，五个必须全在，且实现里真有这些字面量。
    // 之所以比对源码而不是 import：这份契约是"两份字面量必须一致"的守卫，不是运行时依赖。
    const playback = readSource('../playback.ts');
    const decl = /export type PlaybackStatus = ([^;]+);/.exec(playback)?.[1] ?? '';
    const implStatuses = [...decl.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(
      implStatuses,
      ['accepted', 'cancelled', 'ended', 'failed', 'playing'],
      'playback.ts 的 PlaybackStatus 取值变了——契约要同步改',
    );
    for (const s of implStatuses) {
      assert.ok(core.includes(`'${s}'`), `PetCore 的 PlaybackStatus 必须含 '${s}'（与 playback.ts 一致）`);
    }
  });

  test('占用回执绝不会把 lockId 写进 /state', () => {
    // 这是安全相关：/state 是人人可读的，lockId 是持锁凭证。
    assert.ok(/lockId/.test(core), '契约里要明确 lockId 的存在与"不进 /state"');
    const lockSection = host.slice(host.indexOf("rest === 'lock'"), host.indexOf("rest === 'lock'") + 2500);
    assert.ok(!/data:\s*\{[^}]*lockId/.test(lockSection), '锁叶子不得包含 lockId（它是凭证，不能放进人人可读的 /state）');
  });
});
