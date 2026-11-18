import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { petSettingsPage, petSettingsScript, petSettingsStyle } from './pet-settings-page.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyPatch, createPetSettingsService, validatePetSettings, viewOf } from './pet-settings.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-pet-settings-'));
}

test('viewOf：空配置回落到默认值', () => {
  const view = viewOf({});
  assert.equal(view.name, '蓝色大肥鱼');
  assert.equal(view.size, 580);
  assert.equal(view.display, 'both');
  assert.equal(view.corner, 'top-right');
  assert.equal(view.marginX, 24);
  assert.equal(view.marginY, 100);
  assert.equal(view.fontFamily, 'system');
  assert.equal(view.fontSize, 21);
  assert.equal(view.followPet, true);
  assert.equal(view.gravity, 1400);
  assert.equal(view.restitution, 0.78);
  assert.equal(view.groundFriction, 2.5);
  assert.equal(view.ceilingBounce, true);
  assert.equal(view.throwPower, 1);
});

test('viewOf：读得出嵌套字段，非法枚举/数字回落到默认', () => {
  const view = viewOf({
    pets: [{ id: 'main', name: '小蓝', size: 400, display: 'desktop', fixedEnabled: true, position: { corner: 'bottom-left', marginX: 0, marginY: 12 } }],
    confineToScreen: true,
    font: { family: 'kaiti', size: 30, followPet: false },
    physics: { gravity: 900, restitution: 0.5, groundFriction: 1, ceilingBounce: false, throwPower: 2 },
  });
  assert.equal(view.name, '小蓝');
  assert.equal(view.size, 400);
  assert.equal(view.display, 'desktop');
  assert.equal(view.corner, 'bottom-left');
  assert.equal(view.marginX, 0);
  assert.equal(view.confineToScreen, true);
  assert.equal(view.fontFamily, 'kaiti');
  assert.equal(view.fontSize, 30);
  assert.equal(view.followPet, false);

  const broken = viewOf({
    pets: [{ name: '   ', size: 'big', display: 'everywhere', position: { corner: 'middle' } }],
    font: { family: 'comic-sans', size: 999 },
  });
  assert.equal(broken.name, '蓝色大肥鱼');
  assert.equal(broken.size, 580);
  assert.equal(broken.display, 'both');
  assert.equal(broken.corner, 'top-right');
  assert.equal(broken.fontFamily, 'system');
  assert.equal(broken.fontSize, 21);
});

test('applyPatch：只改白名单字段，其他键与其他宠物原样保留', () => {
  const before = {
    pets: [
      { id: 'main', name: '旧名字', whisperPrompt: '别动我' },
      { id: 'second', name: '第二只' },
    ],
    unknownKey: { keep: true },
  };
  const after = applyPatch(before, validatePetSettings({ name: '新名字', size: 300 }));
  assert.equal((after.pets as any[])[0].name, '新名字');
  assert.equal((after.pets as any[])[0].size, 300);
  assert.equal((after.pets as any[])[0].whisperPrompt, '别动我');
  assert.equal((after.pets as any[])[1].name, '第二只');
  assert.deepEqual(after.unknownKey, { keep: true });
  // 原对象不被就地修改
  assert.equal((before.pets as any[])[0].name, '旧名字');
});

test('whisperEnabled：默认允许，读得出也写得进（碎碎念总开关在宠物级）', () => {
  // 配置里没写 → 默认 true（与 assets/config.jsonc 的 pets[].whisperEnabled 默认一致）
  assert.equal(viewOf({}).whisperEnabled, true);
  // 用户关掉 → 页面显示关，且能原样存回去
  const off = viewOf({ pets: [{ id: 'main', whisperEnabled: false }] });
  assert.equal(off.whisperEnabled, false);
  const after = applyPatch({ pets: [{ id: 'main', whisperEnabled: true }] }, validatePetSettings({ whisperEnabled: false }));
  assert.equal((after.pets as any[])[0].whisperEnabled, false);
});

test('whisperIntervalMin：间隔只认 eventsRefreshSec.whisper 这一份（分钟进、秒出）', () => {
  // 没写 → 60 秒 = 1 分钟（和陪伴的节奏接壤，11-01 定）
  assert.equal(viewOf({}).whisperIntervalMin, 1);
  assert.equal(viewOf({ eventsRefreshSec: { whisper: 1800 } }).whisperIntervalMin, 30);
  const next = applyPatch({ eventsRefreshSec: { balance: 1800, whisper: 300 } }, validatePetSettings({ whisperIntervalMin: 15 }));
  // 写进去是秒，别的刷新周期不许被冲掉
  assert.deepEqual(next.eventsRefreshSec, { balance: 1800, whisper: 900 });
  // 越界与非整数直接拒（不让页面把配置写成 0 秒）
  for (const bad of [{ whisperIntervalMin: 0 }, { whisperIntervalMin: 1441 }, { whisperIntervalMin: 5.5 }]) {
    assert.throws(() => validatePetSettings(bad), Error, JSON.stringify(bad));
  }
});
test('persona（人格）：实例级优先 → 条目级 → 空串，写进去、清空能删掉覆盖', () => {
  // 配置里什么都没写 → 页面拿到空串（页面据此用占位符提示"留空即默认"）
  assert.equal(viewOf({}).persona, '');
  // 条目级（顶层 whisperPrompt）
  assert.equal(viewOf({ whisperPrompt: '条目级人设' }).persona, '条目级人设');
  // 实例级覆盖优先
  assert.equal(
    viewOf({ whisperPrompt: '条目级人设', pets: [{ id: 'main', whisperPrompt: '实例级人设' }] }).persona,
    '实例级人设',
  );
  // 写：落到 pets[0].whisperPrompt（宿主 petPersona 优先读它），且前后空白被去掉
  const written = applyPatch({ whisperPrompt: '旧' }, validatePetSettings({ persona: '  新的人设  ' }));
  assert.equal((written.pets as any[])[0].whisperPrompt, '新的人设');
  assert.equal(written.whisperPrompt, '旧'); // 条目级原样保留，不误伤
  // 清空 → 删掉实例级覆盖（回落到条目级/包内默认）
  const cleared = applyPatch(
    { pets: [{ id: 'main', whisperPrompt: '实例级人设' }] },
    validatePetSettings({ persona: '   ' }),
  );
  assert.equal('whisperPrompt' in ((cleared.pets as any[])[0] ?? {}), false);
});

test('validatePetSettings：人格过长被拒（不会把配置文件写成几万字）', () => {
  assert.throws(() => validatePetSettings({ persona: 'x'.repeat(4001) }), /桌宠设置无效/);
});

test('validatePetSettings：报错里点名出错的字段（11-16 m22720）', () => {
  assert.throws(() => validatePetSettings({ size: 20 }), /出错的字段：size/u);
  assert.throws(() => validatePetSettings({ nope: 1 }), /出错的字段：nope/u);
});

test('validatePetSettings：气泡偏移量是小数也收，写盘时取整（11-16 m22720）', () => {
  const patch = validatePetSettings({ hintX: 12.4, hintY: -3.6, hintSize: 14.5 });
  const next = applyPatch({}, patch);
  assert.deepEqual(next.hint, { x: 12, y: -4, size: 15 });
});

test('气泡拖拽的边界必须和 schema 一致（11-16 体检 B4）', () => {
  // 老 bug：页面按预览框宽度算上限（能拖到 448），schema 只收到 400 → 拖偏一点保存必报「设置无效」。
  assert.match(petSettingsScript, /clampHint\(drag\.ox \+ \(ev\.clientX - drag\.x\), -400, 400\)/u);
  assert.match(petSettingsScript, /clampHint\(drag\.oy \+ \(ev\.clientY - drag\.y\), -400, 400\)/u);
  assert.throws(() => validatePetSettings({ hintX: 448 }), /出错的字段：hintX/u);
  assert.deepEqual(validatePetSettings({ hintX: 400, hintY: -400 }), { hintX: 400, hintY: -400 });
});

test('validatePetSettings：越界、未知键、类型错都拒绝，并给同一句可操作提示', () => {
  assert.throws(() => validatePetSettings({ size: 20 }), /桌宠设置无效/);
  assert.throws(() => validatePetSettings({ marginX: 5000 }), /桌宠设置无效/);
  assert.throws(() => validatePetSettings({ fontSize: 3 }), /桌宠设置无效/);
  assert.throws(() => validatePetSettings({ display: 'everywhere' }), /桌宠设置无效/);
  assert.throws(() => validatePetSettings({ name: '' }), /桌宠设置无效/);
  assert.throws(() => validatePetSettings({ nope: 1 }), /桌宠设置无效/);
  assert.deepEqual(validatePetSettings({ gravity: 0, throwPower: 5 }), { gravity: 0, throwPower: 5 });
});

test('createPetSettingsService：文件不存在时读默认值，保存后落盘并回调', async () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'main-config.jsonc');
    let reloads = 0;
    const service = createPetSettingsService(file, () => {
      reloads += 1;
    });
    assert.equal(service.getSettings().name, '蓝色大肥鱼');

    const saved = await service.saveSettings({ name: '小蓝鲸', size: 420, gravity: 800, corner: 'bottom-right' });
    assert.equal(saved.name, '小蓝鲸');
    assert.equal(saved.size, 420);
    assert.equal(saved.corner, 'bottom-right');
    assert.equal(reloads, 1);

    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.pets[0].id, 'main');
    assert.equal(onDisk.pets[0].name, '小蓝鲸');
    assert.equal(onDisk.pets[0].size, 420);
    assert.equal(onDisk.pets[0].position.corner, 'bottom-right');
    assert.equal(onDisk.physics.gravity, 800);
    // 再读一遍仍一致（说明写出来的东西能被自己读回）
    assert.equal(service.getSettings().name, '小蓝鲸');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createPetSettingsService：保留已有配置里的其他键，坏 JSON 时仍能打开页面', async () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'main-config.jsonc');
    writeFileSync(file, JSON.stringify({ pets: [{ id: 'main', name: '旧的', display: 'web' }], keepMe: 1 }));
    const service = createPetSettingsService(file);
    await service.saveSettings({ size: 600 });
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.keepMe, 1);
    assert.equal(onDisk.pets[0].display, 'web');
    assert.equal(onDisk.pets[0].size, 600);

    writeFileSync(file, '{ 这不是 JSON');
    assert.equal(service.getSettings().size, 580);
    await service.saveSettings({ size: 500 });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pets[0].size, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('看图/声音：三档读得出、写得进，且不动 chat 段的密钥', () => {
  const base = {
    model: {
      chat: { enabled: true, kind: 'remote', baseUrl: 'https://api.example.test/v1', model: 'chat-1', apiKey: 'sk-keep' },
      vision: { enabled: true, kind: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'qwen2-vl' },
      tts: { enabled: false, kind: 'local', endpoint: '', model: '' },
    },
  };
  const view = viewOf(base);
  assert.equal(view.visionMode, 'local');
  assert.equal(view.visionEndpoint, 'http://127.0.0.1:1234/v1');
  assert.equal(view.visionModel, 'qwen2-vl');
  assert.equal(view.voiceMode, 'off');

  const next = applyPatch(base, { visionMode: 'remote', visionModel: 'gpt-4o-mini', voiceMode: 'local', voiceEndpoint: 'http://127.0.0.1:9880/v1' });
  const model = next.model as Record<string, Record<string, unknown>>;
  assert.deepEqual(model.vision, { enabled: true, kind: 'remote', baseUrl: '', model: 'gpt-4o-mini', apiKey: '' });
  assert.deepEqual(model.tts, { enabled: true, kind: 'local', endpoint: 'http://127.0.0.1:9880/v1', model: '' });
  // chat 段必须原样（toConfigSection 会写全三项，写错就把 key 冲掉了）
  assert.deepEqual(model.chat, base.model.chat);

  // 关掉看图 → enabled false，但本地地址保留（下次选回本地不用重填）
  const off = applyPatch(next, { visionMode: 'off' });
  assert.deepEqual((off.model as Record<string, Record<string, unknown>>).vision, { enabled: false, kind: 'local', endpoint: '', model: '' });
});

test('看图/声音：模式必须是三档之一，长度有上限', () => {
  assert.throws(() => validatePetSettings({ visionMode: 'session' }));
  assert.throws(() => validatePetSettings({ visionModel: 'x'.repeat(201) }));
  assert.equal((validatePetSettings({ voiceMode: 'off' }) as { voiceMode: string }).voiceMode, 'off');
});

test('声音协议：sovits 的参考音写进 model.tts，切回 openai 就清干净', () => {
  const base: Record<string, unknown> = {
    pets: [{ id: 'main', name: '鱼' }],
    model: {
      chat: { enabled: true, kind: 'session' },
      vision: { enabled: false, kind: 'local' },
      tts: { enabled: false, kind: 'local' },
    },
  };
  const on = applyPatch(base as never, {
    voiceMode: 'local',
    voiceEndpoint: 'http://127.0.0.1:9880',
    voiceProtocol: 'sovits',
    voiceRefAudio: 'D:/AI/GPT-SoVITS/_ref.wav',
    voicePromptText: '哥哥，我是本鱼',
  });
  const tts = (on.model as Record<string, Record<string, unknown>>).tts;
  assert.equal(tts.enabled, true);
  assert.equal(tts.kind, 'local');
  assert.equal(tts.protocol, 'sovits');
  assert.equal(tts.refAudioPath, 'D:/AI/GPT-SoVITS/_ref.wav');
  assert.equal(tts.promptText, '哥哥，我是本鱼');
  assert.equal(tts.speedFactor, 1);

  // 读回来：页面要能看到刚才填的三个字段
  const view = viewOf(on as never);
  assert.equal(view.voiceProtocol, 'sovits');
  assert.equal(view.voiceRefAudio, 'D:/AI/GPT-SoVITS/_ref.wav');
  assert.equal(view.voicePromptText, '哥哥，我是本鱼');

  // 切回标准接口 → sovits 专有字段不许留在配置里
  const off = applyPatch(on as never, { voiceProtocol: 'openai' });
  const tts2 = (off.model as Record<string, Record<string, unknown>>).tts;
  assert.equal(tts2.protocol, undefined);
  assert.equal(tts2.refAudioPath, undefined);
  assert.equal(tts2.promptText, undefined);
});

test('声音协议：只认 openai / sovits，参考音有长度上限', () => {
  assert.throws(() => validatePetSettings({ voiceProtocol: 'vits' }));
  assert.throws(() => validatePetSettings({ voiceRefAudio: 'x'.repeat(513) }));
});


test('设置页：模型三页签与三个面板都在，默认打开对话', () => {
    for (const name of ['chat', 'vision', 'voice']) {
      assert.ok(petSettingsPage.includes('data-mtab="' + name + '"'), '缺页签 ' + name);
      assert.ok(petSettingsPage.includes('data-mpane="' + name + '"'), '缺面板 ' + name);
    }
    assert.ok(petSettingsPage.includes('class="mpane is-on" data-mpane="chat"'));
    assert.ok(!petSettingsPage.includes('class="mpane is-on" data-mpane="voice"'));
});

test('设置页：页签脚本和样式在，且没跟提示词页签抢类名', () => {
    assert.ok(petSettingsScript.includes('showModelTab'));
    assert.ok(petSettingsStyle.includes('.mpane.is-on'));
    assert.ok(!petSettingsPage.includes('class="tab is-on" data-tab="chat"'));
  });

test('设置页：脚本是合法 JS（写进字符串时别混进 TS 语法）', () => {
  assert.doesNotThrow(() => new Function(petSettingsScript));
});

// 【汐儿 · 11-11 m19834】B站登录信息：设置页填一次，存进宠物配置的 subtitle.sessData
test('B站 SESSDATA：回显、保存、清空', () => {
  assert.equal(viewOf({}).subtitleSessData, '');
  const saved = applyPatch({}, { subtitleSessData: ' SESSDATA=abc; bili_jct=def ' });
  const section = saved.subtitle as Record<string, unknown>;
  assert.equal(section.sessData, 'SESSDATA=abc; bili_jct=def');
  assert.equal(viewOf(saved as never).subtitleSessData, 'SESSDATA=abc; bili_jct=def');
  // 不改这块的时候别把它冲掉
  const other = applyPatch(saved as never, { name: '小蓝' });
  assert.equal((other.subtitle as Record<string, unknown>).sessData, 'SESSDATA=abc; bili_jct=def');
  const cleared = applyPatch(saved as never, { subtitleSessData: '' });
  assert.equal((cleared.subtitle as Record<string, unknown>).sessData, '');
});

// 【汐儿 · 11-15】播放音量：默认 100、存得住、不冲掉别的键
test('播放音量：默认 100，保存后读回来，不动别的键', () => {
  assert.equal(viewOf({}).voiceVolume, 100);

  const saved = applyPatch({}, { voiceVolume: 35 });
  assert.equal(viewOf(saved).voiceVolume, 35);
  assert.equal((saved.voice as Record<string, unknown>).volume, 35);

  // 0 与 100 两头都得留得住（0 是最容易被当成「没填」的那种值）
  assert.equal(viewOf(applyPatch(saved, { voiceVolume: 0 })).voiceVolume, 0);
  assert.equal(viewOf(applyPatch(saved, { voiceVolume: 100 })).voiceVolume, 100);

  // 不改这块的时候别把音量冲掉
  const other = applyPatch(saved, { name: '小蓝' });
  assert.equal(viewOf(other).voiceVolume, 35);
});

// 【汐儿 · 11-15】设置页：四个大项页签 + 音量滑杆，且默认只开一页
test('设置页：大项页签与音量滑杆都在，默认只开一页', () => {
  for (const pane of ['look', 'model', 'watch', 'more']) {
    assert.ok(petSettingsPage.includes('data-gtab="' + pane + '"'), '缺页签 ' + pane);
    assert.ok(petSettingsPage.includes('data-gpane="' + pane + '"'), '缺面板 ' + pane);
  }
  assert.ok(petSettingsPage.includes('id="voiceVolume"'));
  assert.equal((petSettingsPage.match(/class="gpane is-on"/g) ?? []).length, 1);
  assert.ok(petSettingsScript.includes('function showPane('));
});

// 【汐儿 · 11-16】只 `new Function` 编译挡不住「初始化时读未初始化的 const」这种错：
// 那次 HINT_BASE 写在 showHint() 调用点后面，脚本一加载就 ReferenceError，整页空白
// （哥哥报「我的设置全都不见了 + 字号位置不生效」）。所以这里拿假 DOM 真跑一遍。
test('设置页：脚本真跑一遍不报错，且能把值填进控件', async () => {
  const ids = [...new Set([...petSettingsPage.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]))];
  const els = new Map(
    ids.map((id) => [
      id,
      {
        id, value: '', checked: false, textContent: '', href: '', dataset: {}, style: {},
        options: [], classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
        addEventListener() {}, appendChild() {}, removeChild() {}, remove() {},
        querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, getAttribute: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), focus() {}, click() {},
      },
    ]),
  );
  const pet = { name: '小蓝', size: 560, hintX: 30, hintY: -20, hintSize: 18, voiceVolume: 40, watchMode: 'window' };
  const ai = { baseUrl: 'https://x.test', model: 'm', extraHeaders: { 'x-a': 'b' }, hasKey: true };
  const errors: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const saved = {
    document: g.document, location: g.location, history: g.history, fetch: g.fetch, localStorage: g.localStorage, window: g.window,
  };
  g.document = {
    getElementById: (id: string) => els.get(id) ?? null,
    createElement: (tag: string) => ({ ...els.get(ids[0] as string), id: 'new-' + tag, options: [], style: {} }),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { appendChild() {} },
  };
  g.location = { hash: '#token=t', pathname: '/standalone-pet/', search: '', replace() {} };
  g.history = { replaceState() {} };
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.window = g;
  const asked: string[] = [];
  g.fetch = async (url: string) => {
    asked.push(String(url));
    return {
      ok: true, status: 200,
      json: async () =>
        url.includes('/windows')
          ? { ok: true, windows: [{ hwnd: 111, title: '记事本', exe: 'notepad' }] }
          : url.includes('standalone-ai')
            ? ai
            : url.includes('profiles')
              ? { profiles: [], activeId: '' }
              : pet,
    };
  };
  try {
    new Function(petSettingsScript)();
    await new Promise((r) => setTimeout(r, 120));
  } catch (error) {
    errors.push(String(error));
  } finally {
    Object.assign(g, saved);
  }
  assert.deepEqual(errors, []);
  assert.equal(els.get('name')?.value, '小蓝');
  assert.equal(els.get('hintSize')?.value, '18');
  assert.equal(els.get('extraHeaders')?.value, 'x-a: b');
  // 【汐儿 · 11-16 m22898】窗口下拉要靠 loadWindows 现拉一次；以前路由常量写错成 ROUTE，
  // ReferenceError 被空 catch 吞掉，页面看着正常、下拉永远只有「（没选，按全屏）」一项。
  assert.ok(asked.some((url) => url.includes('/dsh-pet-7340/windows')), '必须请求过窗口列表：' + asked.join(','));
});

test('嗓子：普通保存不能抹掉本地地址与发声协议（11-16 声音丢失）', () => {
  const base = {
    model: {
      tts: {
        enabled: true,
        kind: 'local',
        endpoint: 'http://127.0.0.1:9880',
        model: '希儿-社区版',
        protocol: 'system',
      },
    },
  };
  // 页面回显成空串（切过「关/本地/云端」之后框里是空的）→ 空串只算"没填"，不能覆盖已有地址
  const next = applyPatch(base as never, {
    name: '小蓝',
    voiceMode: 'local',
    voiceEndpoint: '',
    voiceModel: '希儿-社区版',
  } as never);
  const tts = (next.model as Record<string, unknown>).tts as Record<string, unknown>;
  assert.equal(tts.endpoint, 'http://127.0.0.1:9880', '空串不能把本地地址抹成空');
  assert.equal(tts.protocol, 'system', '普通保存要把旧协议带过来，否则嗓子被判"没配好"');
  assert.equal(tts.model, '希儿-社区版');

  // 显式换协议照写
  const edge = applyPatch(base as never, { voiceProtocol: 'edge' } as never);
  const edgeTts = (edge.model as Record<string, unknown>).tts as Record<string, unknown>;
  assert.equal(edgeTts.protocol, 'edge');
  assert.equal(edgeTts.endpoint, 'http://127.0.0.1:9880');

  // 显式写 openai 才是"不要协议"
  const openai = applyPatch(base as never, { voiceProtocol: 'openai' } as never);
  const openTts = (openai.model as Record<string, unknown>).tts as Record<string, unknown>;
  assert.equal(openTts.protocol, undefined);

  // 本地后端：原来没地址、这次填了 → 照填
  const fill = applyPatch({ model: { tts: { enabled: true, kind: 'local', endpoint: '' } } } as never, {
    voiceEndpoint: 'http://127.0.0.1:9880',
  } as never);
  const fillTts = (fill.model as Record<string, unknown>).tts as Record<string, unknown>;
  assert.equal(fillTts.endpoint, 'http://127.0.0.1:9880');
});

test('换卷字数 / 卡片注入 / 嘴边队列：回显、保存、越界夹取（11-18 文档 9.13）', () => {
  const view = viewOf({ context: { rollChars: 8000, cardInject: 8 }, mouth: { queueMax: 6 } });
  assert.equal(view.contextRollChars, 8000);
  assert.equal(view.contextCardInject, 8);
  assert.equal(view.mouthQueueMax, 6);

  // 没配过就是默认 5000 / 5 / 3
  const empty = viewOf({});
  assert.equal(empty.contextRollChars, 5000);
  assert.equal(empty.contextCardInject, 5);
  assert.equal(empty.mouthQueueMax, 3);

  // 越界由 schema 直接拒（页面滑杆之外手改 jsonc 也不会写进坏值）
  assert.throws(() => validatePetSettings({ contextRollChars: 100 }), /出错的字段：contextRollChars/u);
  assert.throws(() => validatePetSettings({ mouthQueueMax: 99 }), /出错的字段：mouthQueueMax/u);

  // 写进去只动这两段，别的段原样
  const next = applyPatch({ model: { chat: { enabled: true, kind: 'local', endpoint: 'http://x' } } }, {
    contextRollChars: 12000,
    contextCardInject: 3,
    mouthQueueMax: 8,
  });
  assert.deepEqual((next as Record<string, Record<string, unknown>>).context, { rollChars: 12000, cardInject: 3 });
  assert.deepEqual((next as Record<string, Record<string, unknown>>).mouth, { queueMax: 8 });
  assert.deepEqual((next as Record<string, Record<string, unknown>>).model, {
    chat: { enabled: true, kind: 'local', endpoint: 'http://x' },
  });
});

test('设置页里有这三个控件，且都在「其他」页签', () => {
  for (const id of ['contextRollChars', 'contextCardInject', 'mouthQueueMax']) {
    assert.ok(petSettingsPage.includes(`id="${id}"`), `页面缺控件 ${id}`);
    assert.ok(petSettingsScript.includes(`'${id}'`), `回填名单缺 ${id}`);
    assert.ok(petSettingsScript.includes(`${id}: Number(get('${id}').value)`), `提交体缺 ${id}`);
  }
  const more = petSettingsPage.indexOf('data-gpane="more"');
  assert.ok(more >= 0);
  assert.ok(petSettingsPage.indexOf('id="contextRollChars"') > more, '这三个控件要落在「其他」页签里');
});

// 【汐儿 · 11-19 全量测试】以前非法地址返回 200 却静默不保存，用户以为存上了；现在直接报错点名。
test('地址字段写错要报错点名，别静默丢', () => {
  for (const key of ['visionEndpoint', 'voiceEndpoint', 'visionBaseUrl', 'voiceBaseUrl']) {
    assert.throws(
      () => validatePetSettings({ [key]: 'QA 测试值' }),
      new RegExp(`出错的字段：${key}`, 'u'),
      `${key} 应该被拒`,
    );
    assert.throws(() => validatePetSettings({ [key]: 'api.deepseek.com' }), /出错的字段/u, `${key} 缺协议头也要拒`);
    // 空串是「不填 / 沿用」，必须放行
    assert.doesNotThrow(() => validatePetSettings({ [key]: '' }));
    // 正常地址必须放行（含端口和路径）
    assert.doesNotThrow(() => validatePetSettings({ [key]: 'http://127.0.0.1:9880/tts' }));
    assert.doesNotThrow(() => validatePetSettings({ [key]: 'https://api.deepseek.com/v1' }));
  }
});

// 【汐儿 · 11-19】mergeLook 是假功能留下的死键（陪伴本来就是一次调用），schema 已删。
test('mergeLook 死键已删掉（再传就是未知字段）', () => {
  assert.throws(() => validatePetSettings({ mergeLook: true }), /出错的字段：mergeLook/u);
  assert.ok(!petSettingsPage.includes("get('mergeLook')"), '页面不该再读 mergeLook');
});
