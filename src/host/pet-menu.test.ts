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
    // 只许这几种前缀：多一种就会在壳里多出一层没人排过的菜单
    // 11-17 m25895：新增一级「取景」（全屏/自动/窗口/记录目录）
    assert.match(label, /^(状态|陪伴|看一眼|碎碎念|取景)(\s*·[^：]*)?：/, `前缀不在约定里：${label}`);
    // 一个标签里只能有一个分组冒号，否则会多套一层
    assert.equal(label.split('：').length - 1, 1, `多了一个分组冒号会多套一层：${label}`);
    assert.ok(label.length <= 32, `label 超过 LABEL_MAX=32：${label}`);
  }
  // 壳里 `menu.ts` 的 ITEMS_MAX 是 40；这里卡的是「一眼能翻完」的自家预算。
  // 11-09 晚「菜减量」：档位全部收进自定义小窗，时间不再一项一档 →
  // 状态 4 + 看一眼 3 + 陪伴 5 + 碎碎念 3 = 15 条（关停项只在开着时出现）。
  assert.ok(running.length <= 20, `单项 owner 最多 20 条，实际 ${running.length} 条`);
  assert.equal(new Set(running).size, running.length, '同一 owner 内 label 必须唯一');
});

test('状态二级：顺序是 嗓子/眼睛/歌词/联网查、值跟着真实状态走', () => {
  const labels = petMenuLabels(idle);
  const stateItems = labels.filter((label) => label.startsWith(STATE_PREFIX));
  assert.deepEqual(stateItems, [
    // 11-09 晚 m16044：陪伴 / 看一眼的开关挪进各自的一级分支，一级标题直接带状态，
    // 状态层只剩真正要「切换值」的四项（点一下换下一个，看当前值才知道点完是什么）。
    '状态：嗓子 · 关',
    '状态：眼睛 · 关',
    '状态：歌词 · 关',
    // 11-11 m20199：联网查资料（默认开）
    '状态：联网查 · 开',
    // 11-01 新增：装插件这一项不依赖桥是否连上（新用户第一次就靠它把插件装进 DSH）
    '状态：接入 · 装插件到 DSH…',
  ]);

  const on = petMenuLabels({
    companionRunning: true,
    companionIntervalMs: 120000,
    lyricRunning: true,
    vision: 'local',
    voice: 'remote',
    watch: { running: true, pace: 'normal' },
  }).filter((label) => label.startsWith(STATE_PREFIX));
  assert.deepEqual(on, [
    '状态：嗓子 · 云',
    '状态：眼睛 · 本地',
    '状态：歌词 · 开',
    '状态：联网查 · 开',
    '状态：接入 · 装插件到 DSH…',
  ]);
});

test('看一眼层：标题带状态 + 开关 + 现在看一眼 + 自定义时间…', () => {
  const off = petMenuLabels(idle);
  // 哥哥 11-09 晚：时长全部收进自定义小窗，菜单里不再一项一档
  assert.ok(off.includes('看一眼 · 关：开（点一下开）'), '关着的时候第一项就是打开它');
  assert.ok(off.includes('看一眼 · 关：现在看一眼'), '要能立刻看一眼');
  assert.ok(off.includes('看一眼 · 关：自定义时间…'), '要能开小窗填时间');
  assert.ok(!off.some((label) => label.startsWith('看一眼 · 关：开 ')), '不该再列具体档位');
  assert.ok(!off.some((label) => label.includes('关掉')), '没开的时候不该有关停项');

  // 11-09 晚 m16273：关着的时候一级也要报配置好的时长 / 档位
  const paused = petMenuLabels({ ...idle, companionIntervalMs: 120000, watch: { running: false, pace: 'calm' } });
  assert.ok(paused.includes('看一眼 · 关（2 分钟）：开（点一下开）'), '关着也要看见配置的时长');
  assert.ok(paused.includes('陪伴 · 关（轻）：开（点一下开）'), '关着也要看见配置的档位');
  const on = petMenuLabels({ ...idle, companionRunning: true, companionIntervalMs: 120000 });
  assert.ok(on.includes('看一眼 · 开 2 分钟：✓ 开着（点一下关）'), '开着时标题报间隔、第一项是关掉它');
  assert.ok(!on.some((label) => label.startsWith('看一眼 · 关：')), '开着时标题不该还是「关」');
});

test('陪伴层（原看护）：标题带状态 + 开关 + 三档节奏 + 出声', () => {
  const off = petMenuLabels(idle);
  assert.ok(off.includes('陪伴 · 关：开（点一下开）'), '关着的时候第一项就是打开它');
  for (const pace of ['轻', '正常', '密']) {
    // 11-09 晚起标签尾巴带「（最多 N 张/分）」，只认前缀
    assert.ok(
      off.some((label) => label.startsWith(`陪伴 · 关：${pace}（最多`)),
      `缺少节奏 ${pace}`,
    );
  }
  // 哥哥 11-09 晚：陪伴单独一个出声开关，默认关（安静只看不说）
  assert.ok(off.includes('陪伴 · 关：不出声（点一下开）'), '默认关');
  assert.ok(!off.some((label) => label.includes('关掉')), '没开的时候不该有关停项');

  const on = petMenuLabels({ ...idle, watch: { running: true, pace: 'dense', speak: true } });
  assert.ok(on.includes('陪伴 · 开（密）：✓ 开着（点一下关）'), '开着时标题报节奏、第一项是关掉它');
  assert.ok(on.includes('陪伴 · 开（密）：✓ 密（最多 7.5 张/分）'));
  assert.equal(
    on.filter((label) => /^陪伴 · [^：]*：[✓\s]*(轻|正常|密)/.test(label) && label.includes('✓')).length,
    1,
    '同一档位不能既有 ✓ 又无 ✓',
  );
  assert.ok(on.includes('陪伴 · 开（密）：✓ 会出声（点一下静音）'));
  assert.ok(!on.some((label) => label.startsWith('陪伴 · 关：')), '开着时标题不该还是「关」');
});

test('陪伴层：出声文案说清状态 + 记录目录那一行（11-09 晚 m16399）', () => {
  const off = petMenuLabels({ ...idle, watch: { running: true, pace: 'normal', speak: false } });
  assert.ok(off.includes('陪伴 · 开（正常）：不出声（点一下开）'), '没开声音要写「不出声（点一下开）」');
  assert.ok(off.includes('取景：看他看到的（记录目录）…'), '记录目录入口归到取景这一层');
  assert.deepEqual(parsePetMenuLabel('陪伴：✓ 会出声（点一下静音）'), { kind: 'watch-voice-toggle' });
  assert.deepEqual(parsePetMenuLabel('陪伴：不出声（点一下开）'), { kind: 'watch-voice-toggle' });
  assert.deepEqual(parsePetMenuLabel('陪伴：看他看到的（记录目录）…'), { kind: 'watch-open-log' });
  assert.equal(petMenuFeedback({ kind: 'watch-open-log' }, { ok: true, message: '记录在 logs' }), '记录在 logs');
});

test('碎碎念层：开关 + 间隔小窗 + 池子（三行，不再一项一档）', () => {
  const off = petMenuLabels({ ...idle, whisperEnabled: false, whisperIntervalSec: 300 });
  assert.ok(off.includes('碎碎念：自动关（点一下开）'));
  assert.ok(!off.includes('碎碎念：✓ 自动开（点一下关）'), '关着的时候不该出现「关掉它」那项');
  assert.ok(off.includes('碎碎念：间隔（300 秒）…'), '间隔那一项要带上当前秒数');
  assert.ok(!off.some((label) => label === '碎碎念：5 分钟'), '不该再列固定档位');
  assert.ok(off.includes('碎碎念：打开池子'));

  const on = petMenuLabels({ ...idle, whisperEnabled: true, whisperIntervalSec: 1800 });
  assert.ok(on.includes('碎碎念：✓ 自动开（点一下关）'));
  assert.ok(!on.includes('碎碎念：自动关（点一下开）'), '开着的时候不该出现「打开它」那项');
  assert.ok(on.includes('碎碎念：间隔（1800 秒）…'));
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
  assert.deepEqual(parsePetMenuLabel('状态：陪伴 · 关'), { kind: 'watch-toggle' });
  assert.deepEqual(parsePetMenuLabel('状态：陪伴 · 开 正常'), { kind: 'watch-toggle' });
  assert.deepEqual(parsePetMenuLabel('状态：看一眼 · 关'), { kind: 'companion-toggle' });
  assert.deepEqual(parsePetMenuLabel('状态：看一眼 · 开 2 分钟'), { kind: 'companion-toggle' });
  assert.deepEqual(parsePetMenuLabel('状态：嗓子 · 关'), { kind: 'cycle-voice' });
  assert.deepEqual(parsePetMenuLabel('状态：嗓子 · 本地'), { kind: 'cycle-voice' });
  assert.deepEqual(parsePetMenuLabel('状态：眼睛 · 云'), { kind: 'cycle-vision' });
  assert.deepEqual(parsePetMenuLabel('状态：歌词 · 开'), { kind: 'lyric-toggle' });
  assert.deepEqual(parsePetMenuLabel('状态：歌词 · 关'), { kind: 'lyric-toggle' });
});

test('带状态的分支标题也能解析（11-09 晚 m16044）', () => {
  // 壳会把整条 label 原样回传，标题里的「 · 开 2 分钟」得先剥掉
  assert.deepEqual(parsePetMenuLabel('看一眼 · 关：开（点一下开）'), { kind: 'companion-toggle' });
  assert.deepEqual(parsePetMenuLabel('看一眼 · 开 2 分钟：✓ 开着（点一下关）'), { kind: 'companion-stop' });
  assert.deepEqual(parsePetMenuLabel('看一眼 · 开 2 分钟：现在看一眼'), { kind: 'look' });
  assert.deepEqual(parsePetMenuLabel('看一眼 · 关：自定义时间…'), { kind: 'companion-custom' });
  assert.deepEqual(parsePetMenuLabel('陪伴 · 关：开（点一下开）'), { kind: 'watch-toggle' });
  assert.deepEqual(parsePetMenuLabel('陪伴 · 开 正常：✓ 开着（点一下关）'), { kind: 'watch-stop' });
  assert.deepEqual(parsePetMenuLabel('陪伴 · 开 正常：✓ 正常（最多 4 张/分）'), { kind: 'watch-start', pace: 'normal' });
  assert.deepEqual(parsePetMenuLabel('陪伴 · 关：出声（点一下开）'), { kind: 'watch-voice-toggle' });
  assert.deepEqual(parsePetMenuLabel('陪伴 · 开 密：✓ 出声（点一下关）'), { kind: 'watch-voice-toggle' });
});

test('陪伴/碎碎念各条都能解析', () => {
  // 看一眼层第一项（11-09 晚从壳的根菜单里挪进来）
  assert.deepEqual(parsePetMenuLabel('看一眼：现在看一眼'), { kind: 'look' });
  // 旧壳还会回传老标签，必须继续认
  assert.deepEqual(parsePetMenuLabel('陪伴：看一眼'), { kind: 'look' });
  assert.deepEqual(parsePetMenuLabel('看一眼：自定义时间…'), { kind: 'companion-custom' });
  assert.deepEqual(parsePetMenuLabel('看一眼：关掉'), { kind: 'companion-stop' });
  assert.deepEqual(parsePetMenuLabel('看一眼：✓ 开 1 分钟'), { kind: 'companion-start', intervalMs: 60000 });
  assert.deepEqual(parsePetMenuLabel('看一眼：自定义…'), { kind: 'companion-custom' });
  // 陪伴层（原看护）：三档 + 关掉
  assert.deepEqual(parsePetMenuLabel('陪伴：✓ 轻'), { kind: 'watch-start', pace: 'calm' });
  assert.deepEqual(parsePetMenuLabel('陪伴：正常'), { kind: 'watch-start', pace: 'normal' });
  assert.deepEqual(parsePetMenuLabel('陪伴：密'), { kind: 'watch-start', pace: 'dense' });
  // 11-09 晚起标签尾巴带「（最多 N 张/分）」，解析要认
  assert.deepEqual(parsePetMenuLabel('陪伴：✓ 轻（最多 2 张/分）'), { kind: 'watch-start', pace: 'calm' });
  assert.deepEqual(parsePetMenuLabel('陪伴：正常（最多 4 张/分）'), { kind: 'watch-start', pace: 'normal' });
  assert.deepEqual(parsePetMenuLabel('陪伴：密（最多 7.5 张/分）'), { kind: 'watch-start', pace: 'dense' });
  assert.deepEqual(parsePetMenuLabel('陪伴：关掉'), { kind: 'watch-stop' });
  assert.deepEqual(parsePetMenuLabel('陪伴：出声（点一下开）'), { kind: 'watch-voice-toggle' });
  assert.deepEqual(parsePetMenuLabel('陪伴：✓ 出声（点一下关）'), { kind: 'watch-voice-toggle' });
  // 旧壳回传的旧标签也认（改名兼容）
  assert.deepEqual(parsePetMenuLabel('陪伴：关陪伴'), { kind: 'companion-stop' });
  assert.deepEqual(parsePetMenuLabel('看护：关看护'), { kind: 'watch-stop' });
  assert.deepEqual(parsePetMenuLabel('看护：密'), { kind: 'watch-start', pace: 'dense' });
  assert.deepEqual(parsePetMenuLabel('碎碎念：自动关（点一下开）'), { kind: 'whisper-enable' });
  assert.deepEqual(parsePetMenuLabel('碎碎念：自动开'), { kind: 'whisper-enable' }, '旧文案仍可解析');
  assert.deepEqual(parsePetMenuLabel('碎碎念：✓ 自动开（点一下关）'), { kind: 'whisper-disable' });
  assert.deepEqual(parsePetMenuLabel('碎碎念：✓ 自动关'), { kind: 'whisper-disable' }, '旧文案仍可解析');
  assert.deepEqual(parsePetMenuLabel('碎碎念：✓ 15 分钟'), { kind: 'whisper-interval', seconds: 900 });
  assert.deepEqual(parsePetMenuLabel('碎碎念：打开池子'), { kind: 'whisper-pool' });
  assert.deepEqual(parsePetMenuLabel('碎碎念：自定义（300 秒）'), { kind: 'whisper-custom' });
  assert.deepEqual(parsePetMenuLabel('碎碎念：✓ 自定义（420 秒）'), { kind: 'whisper-custom' });
  assert.deepEqual(parsePetMenuLabel('碎碎念：自定义间隔…'), { kind: 'whisper-custom' });
  assert.deepEqual(parsePetMenuLabel('碎碎念：间隔（300 秒）…'), { kind: 'whisper-custom' });
  for (const interval of WHISPER_INTERVALS) {
    assert.notEqual(parsePetMenuLabel(`碎碎念：${interval.label}`), null);
  }
});

test('认不出的 label 一律 null（旧版本残留/第三方项不该炸）', () => {
  for (const label of ['', '看一眼', '陪伴：', '看一眼：开 9 分钟', '看一眼：开', '本鱼陪伴：看一眼']) {
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

test('状态汇总气泡：五项一起报', () => {
  assert.equal(
    petStatusText({ companionRunning: false, companionIntervalMs: 0, lyricRunning: false, vision: 'off', voice: 'off' }),
    '陪伴：关｜看一眼：关｜歌词：关｜看图：关｜声音：关',
  );
  assert.equal(
    petStatusText({
      companionRunning: true,
      companionIntervalMs: 120000,
      lyricRunning: true,
      vision: 'local',
      voice: 'remote',
      // 看护（11-09）：开着的时候要报节奏，哥哥一眼能看到现在是轻还是密
      watchRunning: true,
      watchPace: 'calm',
      watchSpeak: true,
    }),
    '陪伴：开 轻·出声｜看一眼：开 2 分钟｜歌词：开｜看图：本地｜声音：云',
  );
});

test('真实 MenuRegistry：注册 → 点击 → 长轮询取回，读一次就消费掉', async () => {
  const registry = new MenuRegistry();
  assert.equal(registry.register({ owner: PET_MENU_OWNER, labels: petMenuLabels(idle) }).ok, true);

  const clicked = registry.click({ owner: PET_MENU_OWNER, label: '看一眼 · 关：现在看一眼', pet: 'main' });
  assert.deepEqual(clicked, { ok: true, delivered: true });

  const events = await registry.poll(PET_MENU_OWNER, 10);
  assert.ok(events);
  assert.equal(events['看一眼 · 关：现在看一眼'], 'main');

  const again = await registry.poll(PET_MENU_OWNER, 10);
  assert.ok(again);
  assert.equal(again['看一眼 · 关：现在看一眼'], null, '读取即消费：闩锁不是队列');
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
    labels: petMenuLabels({ ...idle, watch: { running: true, pace: 'calm' } }),
  });
  registry.register({
    owner: PET_MENU_OWNER,
    labels: petMenuLabels({ ...idle, watch: { running: true, pace: 'dense' } }),
  });
  const snapshot = registry.snapshot().filter((item) => item.owner === PET_MENU_OWNER);
  assert.ok(snapshot.some((item) => item.label === '陪伴 · 开（密）：✓ 密（最多 7.5 张/分）'));
  assert.ok(!snapshot.some((item) => item.label.startsWith('陪伴 · 开（密）：✓ 轻（')), '注册是整体覆盖，旧档位必须消失');
});

test('陪伴层一级标题带模式（11-16 m21257）：陪伴 · 全屏/窗口 · 开（密）', () => {
  const on = petMenuLabels({ ...idle, watch: { running: true, pace: 'dense', mode: 'window' } });
  assert.ok(
    on.some((label) => label.startsWith('陪伴 · 开（密）：✓ 开着（点一下关）')),
    '一级标题要写明按「视频」那套盯',
  );
  assert.ok(on.includes('取景：✓ 窗口'));
  assert.ok(on.includes('取景：全屏') && on.includes('取景：自动'), '三档都在一级');
  assert.ok(!on.some((label) => label.startsWith('游戏陪伴')), '改回「陪伴 · 模式」了，旧名一行都不该剩');

  // 头里多出来的「· 模式」不影响解析：档位、模式、出声、记录都照样认
  assert.deepEqual(parsePetMenuLabel('陪伴 · 开（密）：✓ 密（最多 7.5 张/分）'), {
    kind: 'watch-start',
    pace: 'dense',
  });
  assert.deepEqual(parsePetMenuLabel('陪伴 · 开（密）：模式 ✓全屏'), { kind: 'watch-mode', mode: 'full' });
  assert.deepEqual(parsePetMenuLabel('陪伴 · 开（密）：✓ 会出声（点一下静音）'), {
    kind: 'watch-voice-toggle',
  });
  assert.deepEqual(parsePetMenuLabel('陪伴 · 开（密）：看他看到的（记录目录）…'), {
    kind: 'watch-open-log',
  });

  // 状态行在非自动模式时带上模式，一眼能看出她在按哪套规则
  const facts = {
    companionRunning: false,
    companionIntervalMs: 0,
    lyricRunning: false,
    whisperEnabled: false,
    dshBridge: undefined,
    watchRunning: true,
    watchPace: 'normal' as const,
    watchSpeak: false,
    watchMode: 'window' as const,
  };
  assert.match(petStatusText(facts as never), /陪伴：开 正常·窗口/u);
  assert.doesNotMatch(petStatusText({ ...facts, watchMode: 'auto' } as never), /·自动/u, '自动不占字');
});
