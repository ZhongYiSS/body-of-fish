import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MenuRegistry } from './menu.ts';
import {
  COMPANION_INTERVALS,
  PET_MENU_OWNER,
  STATE_PREFIX,
  WHISPER_INTERVALS,
  modeWord,
  nextBackendWord,
  parsePetMenuLabel,
  petMenuFeedback,
  petMenuLabels,
  petStatusText,
} from './pet-menu.ts';

// 这一组钉住的是「右键菜单能不能用」的最小契约。
// 壳侧（shared-core.js 的 buildPetMenuTree）按全角 `：` 把 label 的第一段当分支名，
// 所以 label 拼错 = 那一层消失或错位；点击回传的是**注册原文 label**，解析侧必须认同一套字符串。
//
// 哥哥 10-31 定的层级：一级 = 状态* / 看一眼 / 陪伴* / 对话 / 碎碎念* / 重载配置 / 点击穿透 / 动作 / 更多*
// 二级里状态 = 陪伴 / 嗓子 / 眼睛 / 歌词（后两个点一下循环 关→本地→云→关）。

const idle = {
  companionRunning: false,
  companionIntervalMs: 0,
  lyricRunning: false,
  vision: 'off' as const,
  voice: 'off' as const,
};

test('owner 必须是壳侧 COMPANION_OWNER，否则整层不出现', () => {
  // runtime/electron-helper/shared-core.js 的 const COMPANION_OWNER = "本鱼陪伴";
  assert.equal(PET_MENU_OWNER, '本鱼陪伴');
});

test('状态层前缀与壳侧逐字一致', () => {
  assert.equal(STATE_PREFIX, '状态：');
});

test('标签：前缀只有状态/陪伴/碎碎念，长度与条数都在上限内', () => {
  const running = petMenuLabels({
    ...idle,
    companionRunning: true,
    companionIntervalMs: 60000,
    lyricRunning: true,
    vision: 'local',
    voice: 'remote',
    companionTicks: 12,
    lookCount: 3,
  });
  for (const label of [...petMenuLabels(idle), ...running]) {
    // 只许这三种前缀：多一种就会在壳里多出一层没人排过的菜单
    assert.match(label, /^(状态|陪伴|碎碎念)：/, `前缀不在约定里：${label}`);
    // 一个标签里只能有一个分组冒号，否则会多套一层
    assert.equal(label.split('：').length - 1, 1, `多了一个分组冒号会多套一层：${label}`);
    assert.ok(label.length <= 32, `label 超过 LABEL_MAX=32：${label}`);
  }
  assert.ok(running.length <= 20, '单项 owner 最多 20 条');
  assert.equal(new Set(running).size, running.length, '同一 owner 内 label 必须唯一');
});

test('状态二级：四项齐、顺序是 陪伴/嗓子/眼睛/歌词、值跟着真实状态走', () => {
  const labels = petMenuLabels(idle);
  const stateItems = labels.filter((label) => label.startsWith(STATE_PREFIX));
  assert.deepEqual(stateItems, [
    '状态：陪伴 · 关',
    '状态：嗓子 · 关',
    '状态：眼睛 · 关',
    '状态：歌词 · 关',
  ]);

  const on = petMenuLabels({
    companionRunning: true,
    companionIntervalMs: 120000,
    lyricRunning: true,
    vision: 'local',
    voice: 'remote',
  }).filter((label) => label.startsWith(STATE_PREFIX));
  assert.deepEqual(on, [
    '状态：陪伴 · 开 2 分钟',
    '状态：嗓子 · 云',
    '状态：眼睛 · 本地',
    '状态：歌词 · 开',
  ]);
});

test('陪伴层：未启动给四档不出现关停项；启动后当前档打 ✓ 并出现关停项', () => {
  const off = petMenuLabels(idle);
  for (const interval of COMPANION_INTERVALS) {
    assert.ok(off.includes(`陪伴：开 ${interval.label}`), `缺少档位 ${interval.label}`);
  }
  assert.ok(!off.some((label) => label.startsWith('陪伴：✓')), '没开的时候不该有 ✓');
  assert.ok(!off.includes('陪伴：关陪伴'));

  const on = petMenuLabels({ ...idle, companionRunning: true, companionIntervalMs: 120000 });
  assert.ok(on.includes('陪伴：✓ 开 2 分钟'));
  assert.ok(!on.includes('陪伴：开 2 分钟'), '同一档位不能既有 ✓ 又无 ✓');
  assert.ok(on.includes('陪伴：关陪伴'));
});

test('碎碎念层：开关只留一项能点的，档位带 ✓，还留了进池子和填秒数的口', () => {
  const off = petMenuLabels({ ...idle, whisperEnabled: false, whisperIntervalSec: 300 });
  assert.ok(off.includes('碎碎念：自动开'));
  assert.ok(!off.includes('碎碎念：✓ 自动关'), '关着的时候不该出现「关掉它」那项');
  assert.ok(off.includes('碎碎念：✓ 5 分钟'), '当前间隔要打 ✓');
  assert.ok(!off.includes('碎碎念：5 分钟'));
  assert.ok(off.includes('碎碎念：打开池子'));
  // 11-01：自定义那一项后面跟的是「现在多少秒」，不是写死的省略号
  assert.ok(off.includes('碎碎念：自定义（300 秒）'), '自定义项要带上当前秒数');

  const on = petMenuLabels({ ...idle, whisperEnabled: true, whisperIntervalSec: 1800 });
  assert.ok(on.includes('碎碎念：✓ 自动关'));
  assert.ok(!on.includes('碎碎念：自动开'));
  assert.ok(on.includes('碎碎念：✓ 30 分钟'));
  // 不是四档之一时才给自定义项打 ✓，免得看着像「没设置」
  const custom = petMenuLabels({ ...idle, whisperEnabled: true, whisperIntervalSec: 420 });
  assert.ok(custom.includes('碎碎念：✓ 自定义（420 秒）'));
});

test('「说一句」不再出现在菜单里（哥哥 10-31：看一眼就能测到说话）', () => {
  for (const label of petMenuLabels({ ...idle, voice: 'local' })) {
    assert.ok(!label.startsWith('声音：'), '声音那一层已经取消');
  }
});

test('每个 label 都能解析回动作（菜单里没有点不动的项）', () => {
  const states = [
    idle,
    { ...idle, companionRunning: true, companionIntervalMs: 45000, lyricRunning: true, vision: 'local' as const, voice: 'remote' as const },
    { ...idle, companionRunning: true, companionIntervalMs: 180000, whisperEnabled: true, whisperIntervalSec: 900 },
  ];
  for (const state of states) {
    for (const label of petMenuLabels(state)) {
      assert.notEqual(parsePetMenuLabel(label), null, `菜单里出现了点不动的项：${label}`);
    }
  }
});

test('状态二级点一下就是切换：不依赖标签里写的是开还是关', () => {
  // 当前值只用来显示；点击一律"切到下一个"，这样壳回传旧标签也不会切错方向
  assert.deepEqual(parsePetMenuLabel('状态：陪伴 · 关'), { kind: 'companion-toggle' });
  assert.deepEqual(parsePetMenuLabel('状态：陪伴 · 开 2 分钟'), { kind: 'companion-toggle' });
  assert.deepEqual(parsePetMenuLabel('状态：嗓子 · 关'), { kind: 'cycle-voice' });
  assert.deepEqual(parsePetMenuLabel('状态：嗓子 · 本地'), { kind: 'cycle-voice' });
  assert.deepEqual(parsePetMenuLabel('状态：眼睛 · 云'), { kind: 'cycle-vision' });
  assert.deepEqual(parsePetMenuLabel('状态：歌词 · 开'), { kind: 'lyric-toggle' });
  assert.deepEqual(parsePetMenuLabel('状态：歌词 · 关'), { kind: 'lyric-toggle' });
});

test('陪伴/碎碎念各条都能解析', () => {
  assert.deepEqual(parsePetMenuLabel('陪伴：看一眼'), { kind: 'look' });
  assert.deepEqual(parsePetMenuLabel('陪伴：关陪伴'), { kind: 'companion-stop' });
  assert.deepEqual(parsePetMenuLabel('陪伴：✓ 开 1 分钟'), { kind: 'companion-start', intervalMs: 60000 });
  assert.deepEqual(parsePetMenuLabel('碎碎念：自动开'), { kind: 'whisper-enable' });
  assert.deepEqual(parsePetMenuLabel('碎碎念：✓ 自动关'), { kind: 'whisper-disable' });
  assert.deepEqual(parsePetMenuLabel('碎碎念：✓ 15 分钟'), { kind: 'whisper-interval', seconds: 900 });
  assert.deepEqual(parsePetMenuLabel('碎碎念：打开池子'), { kind: 'whisper-pool' });
  assert.deepEqual(parsePetMenuLabel('碎碎念：自定义（300 秒）'), { kind: 'whisper-custom' });
  assert.deepEqual(parsePetMenuLabel('碎碎念：✓ 自定义（420 秒）'), { kind: 'whisper-custom' });
  assert.deepEqual(parsePetMenuLabel('碎碎念：自定义间隔…'), { kind: 'whisper-custom' });
  for (const interval of WHISPER_INTERVALS) {
    assert.notEqual(parsePetMenuLabel(`碎碎念：${interval.label}`), null);
  }
});

test('认不出的 label 一律 null（旧版本残留/第三方项不该炸）', () => {
  for (const label of ['', '看一眼', '陪伴：', '陪伴：开 9 分钟', '陪伴：开', '本鱼陪伴：看一眼']) {
    assert.equal(parsePetMenuLabel(label), null, `不该认出来：${label}`);
  }
});

test('后端三态：词是 关/本地/云，循环是 关→本地→云→关', () => {
  assert.equal(modeWord('off'), '关');
  assert.equal(modeWord('local'), '本地');
  assert.equal(modeWord('remote'), '云');
  assert.equal(nextBackendWord('off'), 'local');
  assert.equal(nextBackendWord('local'), 'remote');
  assert.equal(nextBackendWord('remote'), 'off');
  // 转一圈要回到起点（不然点着点着就漂了）
  assert.equal(nextBackendWord(nextBackendWord(nextBackendWord('off'))), 'off');
});

test('点状态四项时：宿主用 message 里那句"切换成了什么"当气泡', () => {
  assert.equal(
    petMenuFeedback({ kind: 'cycle-voice' }, { ok: true, message: '嗓子切换为本地' }),
    '嗓子切换为本地',
  );
  assert.equal(petMenuFeedback({ kind: 'cycle-vision' }, { ok: true }), '切换好了');
  assert.equal(petMenuFeedback({ kind: 'companion-toggle' }, { ok: true, message: '陪伴开了' }), '陪伴开了');
  // 失败必须让哥哥看见真原因，不能只说「没成功」
  assert.equal(
    petMenuFeedback({ kind: 'companion-toggle' }, { ok: false, message: '未接入聊天模型' }),
    '未接入聊天模型',
  );
});

test('状态汇总气泡：四项一起报', () => {
  assert.equal(
    petStatusText({ companionRunning: false, companionIntervalMs: 0, lyricRunning: false, vision: 'off', voice: 'off' }),
    '陪伴：关｜歌词：关｜看图：关｜声音：关',
  );
  assert.equal(
    petStatusText({
      companionRunning: true,
      companionIntervalMs: 120000,
      lyricRunning: true,
      vision: 'local',
      voice: 'remote',
    }),
    '陪伴：开 2 分钟｜歌词：开｜看图：本地｜声音：云',
  );
});

test('真实 MenuRegistry：注册 → 点击 → 长轮询取回，读一次就消费掉', async () => {
  const registry = new MenuRegistry();
  assert.equal(registry.register({ owner: PET_MENU_OWNER, labels: petMenuLabels(idle) }).ok, true);

  const clicked = registry.click({ owner: PET_MENU_OWNER, label: '陪伴：开 45 秒', pet: 'main' });
  assert.deepEqual(clicked, { ok: true, delivered: true });

  const events = await registry.poll(PET_MENU_OWNER, 10);
  assert.ok(events);
  assert.equal(events['陪伴：开 45 秒'], 'main');

  const again = await registry.poll(PET_MENU_OWNER, 10);
  assert.ok(again);
  assert.equal(again['陪伴：开 45 秒'], null, '读取即消费：闩锁不是队列');
});

test('owner 被清掉后 poll 回 null —— 宿主必须重新注册', async () => {
  const registry = new MenuRegistry();
  registry.register({ owner: PET_MENU_OWNER, labels: ['陪伴：看一眼'] });
  registry.clear(PET_MENU_OWNER);
  assert.equal(await registry.poll(PET_MENU_OWNER, 5), null);
});

test('整组刷新：切档位后旧的 ✓ 不残留', () => {
  const registry = new MenuRegistry();
  registry.register({
    owner: PET_MENU_OWNER,
    labels: petMenuLabels({ ...idle, companionRunning: true, companionIntervalMs: 45000 }),
  });
  registry.register({
    owner: PET_MENU_OWNER,
    labels: petMenuLabels({ ...idle, companionRunning: true, companionIntervalMs: 60000 }),
  });
  const snapshot = registry.snapshot().filter((item) => item.owner === PET_MENU_OWNER);
  assert.ok(snapshot.some((item) => item.label === '陪伴：✓ 开 1 分钟'));
  assert.ok(!snapshot.some((item) => item.label === '陪伴：✓ 开 45 秒'), '注册是整体覆盖，旧档位必须消失');
});
