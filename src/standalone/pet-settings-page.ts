/** 独立模式的设置页（**一页到底**：不用联网的和要联网的都在这里，不再分两页）。外部同源资源，CSP 不含 unsafe-inline。 */
export const petSettingsPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>桌宠设置</title><link rel="stylesheet" href="/standalone-pet/pet.css">
<script src="/standalone-pet/pet.js" defer></script></head><body>
<main><header><span class="fish" aria-hidden="true">🐾</span><p class="local">独立桌宠 / 本机设置</p>
<h1>桌宠设置</h1><p class="intro">一页改完：外观、位置、手感、人格、对话模型、看图与声音。<br>带「联网」标注的才需要网络，其余都是本地生效。</p></header>
<form id="settings">
<fieldset><legend>这只宠物</legend>
<div class="pair"><label for="name">名字</label><input id="name" name="name" type="text" maxlength="24" required></div>
<div class="pair"><label for="size">大小（像素）</label><input id="size" name="size" type="number" min="80" max="1200" step="10" required></div>
<label class="check"><input id="desktopVisible" type="checkbox"> 在桌面上显示这只桌宠</label>
<label class="check"><input id="fixedEnabled" type="checkbox"> 固定不动（不掷骰随机走向，只播待机）</label>
<div class="pair"><label for="corner">贴边角落</label><select id="corner" name="corner">
<option value="top-right">右上</option><option value="top-left">左上</option><option value="bottom-right">右下</option><option value="bottom-left">左下</option></select></div>
<div class="pair"><label for="marginX">左右边距（像素）</label><input id="marginX" type="number" min="0" max="4000" step="1" required></div>
<div class="pair"><label for="marginY">上下边距（像素）</label><input id="marginY" type="number" min="0" max="4000" step="1" required></div>
<label class="check"><input id="confineToScreen" type="checkbox"> 锁定在当前屏幕（不让它跑到别的显示器）</label>
</fieldset>
<fieldset><legend>人格（它是谁）</legend>
<label for="persona">人设提示词</label>
<textarea id="persona" rows="6" maxlength="4000" placeholder="留空则使用自带的默认人设。"></textarea>
<p class="hint">这段话就是它的"性格和说话方式"：碎碎念、看一眼、对话共用这一份（写清它是什么身份、怎么称呼你、说话什么调子就够）。清空保存 = 恢复默认人设。</p>
</fieldset>
<fieldset><legend>气泡字体</legend>
<div class="pair"><label for="fontFamily">字体</label><select id="fontFamily" name="fontFamily">
<option value="system">系统默认</option><option value="yahei">微软雅黑</option><option value="youyuan">幼圆</option>
<option value="kaiti">楷体</option><option value="simsun">宋体</option><option value="candy">圆体（candy）</option><option value="comic">Comic Sans</option></select></div>
<div class="pair"><label for="fontSize">字号（像素）</label><input id="fontSize" type="number" min="4" max="200" step="1" required></div>
<label class="check"><input id="followPet" type="checkbox"> 字号跟着宠物大小走</label>
</fieldset>
<fieldset><legend>手感（拖拽与下落）</legend>
<div class="pair"><label for="gravity">重力</label><input id="gravity" type="number" min="0" max="8000" step="50" required></div>
<div class="pair"><label for="restitution">弹性（0–1）</label><input id="restitution" type="number" min="0" max="1" step="0.01" required></div>
<div class="pair"><label for="groundFriction">地面摩擦</label><input id="groundFriction" type="number" min="0" max="50" step="0.1" required></div>
<div class="pair"><label for="throwPower">投掷力度</label><input id="throwPower" type="number" min="0.05" max="5" step="0.05" required></div>
<label class="check"><input id="ceilingBounce" type="checkbox"> 碰到屏幕顶部会弹</label>
</fieldset>
<fieldset><legend>对话模型（联网）</legend>
<div class="pair"><label for="protocol">接口协议</label><select id="protocol" name="protocol"><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></div>
<div class="pair"><label for="maxTokens">单次输出上限（tokens）</label><input id="maxTokens" type="number" min="128" max="4096" step="1" value="1024" required></div>
<label for="baseUrl">接口地址（Base URL）</label><input id="baseUrl" type="url" placeholder="https://example.com/v1" maxlength="2048" spellcheck="false">
<label for="model">模型名称</label><input id="model" type="text" maxlength="200" placeholder="例如 deepseek-chat" spellcheck="false">
<label for="apiKey">API 密钥 <span id="key-state" class="hint">尚未读取</span></label>
<input id="apiKey" type="password" autocomplete="new-password" maxlength="8192" placeholder="留空保留已保存的密钥">
<label class="check"><input id="enabled" type="checkbox"> 启用 AI 对话</label>
<label class="check"><input id="clearApiKey" type="checkbox"> 清除已保存的密钥，并关闭 AI</label>
<div class="test-row"><button id="test-btn" type="button">测试连接</button><span id="test-result" class="test-result" role="status" aria-live="polite"></span></div>
<p class="hint">没接对话模型时，「陪伴」和「看一眼」会直接提示「未接入聊天模型」——它们必须让模型过一遍人格才说话，不念识图原文。</p>
</fieldset>
<fieldset><legend>看图（识图，联网）</legend>
<div class="pair"><label for="visionMode">后端</label><select id="visionMode">
<option value="off">关（陪伴、看一眼都不可用）</option><option value="local">本地</option><option value="remote">云端</option></select></div>
<div class="pair"><label for="visionEndpoint">本地地址</label><input id="visionEndpoint" type="text" maxlength="512" placeholder="http://127.0.0.1:1234/v1"></div>
<label for="visionModel">模型名</label><input id="visionModel" type="text" maxlength="200" placeholder="例如 qwen2-vl-7b-instruct / gpt-4o-mini">
<div class="pair"><label for="visionBaseUrl">云端接口地址（留空 = 沿用对话模型）</label><input id="visionBaseUrl" type="url" maxlength="2048" placeholder="https://example.com/v1" spellcheck="false"></div>
<label for="visionApiKey">云端 API 密钥 <span id="vision-key-state" class="hint">尚未读取</span></label>
<input id="visionApiKey" type="password" autocomplete="new-password" maxlength="8192" placeholder="留空保留已保存的密钥">
<label class="check"><input id="clearVisionApiKey" type="checkbox"> 清除识图自己的密钥（回落对话模型那把）</label>
<p class="hint">本地 = 本机开着的识图服务（LM Studio、ollama 之类）；云端 = 可以单独填地址与密钥，两栏留空就沿用上面「对话模型」那一份。</p>
</fieldset>
<fieldset><legend>声音（朗读，联网）</legend>
<div class="pair"><label for="voiceMode">后端</label><select id="voiceMode">
<option value="off">关</option><option value="local">本地</option><option value="remote">云端</option></select></div>
<div class="pair"><label for="voiceProtocol">发声协议</label><select id="voiceProtocol">
<option value="openai">标准接口（/audio/speech）</option><option value="sovits">GPT-SoVITS（/tts）</option><option value="system">Windows 自带（离线免费）</option><option value="edge">Edge 在线（免费，要联网）</option></select></div>
<label for="voiceEndpoint">本地地址</label><input id="voiceEndpoint" type="text" maxlength="512" placeholder="http://127.0.0.1:9880">
<label for="voiceModel">模型名 / 音色</label><input id="voiceModel" type="text" maxlength="200" placeholder="留空用服务端默认">
<div class="pair"><label for="voiceBaseUrl">云端接口地址（留空 = 沿用对话模型）</label><input id="voiceBaseUrl" type="url" maxlength="2048" placeholder="https://example.com/v1" spellcheck="false"></div>
<label for="voiceApiKey">云端 API 密钥 <span id="voice-key-state" class="hint">尚未读取</span></label>
<input id="voiceApiKey" type="password" autocomplete="new-password" maxlength="8192" placeholder="留空保留已保存的密钥">
<label class="check"><input id="clearVoiceApiKey" type="checkbox"> 清除声音自己的密钥（回落对话模型那把）</label>
<div class="pair"><label for="voiceRefAudio">参考音（绝对路径）</label><input id="voiceRefAudio" type="text" maxlength="512" placeholder="D:\\\\AI\\\\GPT-SoVITS\\\\_ref.wav"></div>
<div class="pair"><label for="voicePromptText">参考音说的话</label><input id="voicePromptText" type="text" maxlength="500" placeholder="与参考音逐字一致"></div>
<p class="hint">GPT-SoVITS 靠「参考音 + 它说的那句话」定音色，两个都要填、且必须对得上；标准接口不用管这两栏。「Windows 自带」离线免费、是机器音；「Edge 在线」不用填地址和 key、要联网。云端时接口地址与密钥可以单独填，留空就沿用对话模型那一份。</p>
</fieldset>
<fieldset><legend>全局快捷键</legend>
<div class="pair"><label for="earHotkey">按住说话</label><input id="earHotkey" type="text" maxlength="32" placeholder="留空 = Alt+T"></div>
<div class="pair"><label for="peekHotkey">看一眼屏幕</label><input id="peekHotkey" type="text" maxlength="32" placeholder="留空 = Alt+G"></div>
<div class="pair"><label for="sayHotkey">说一句</label><input id="sayHotkey" type="text" maxlength="32" placeholder="留空 = Alt+S"></div>
<p class="hint">写成 <code>Alt+T</code> 这种形状（修饰键加主键，可多个修饰键）。留空就用默认；改完保存，桌面壳会自己跟上，不用重启。被别的软件占用时会注册失败，换一个组合试试。</p>
</fieldset>
<p class="hint">改完保存会重启桌面小窗（约一秒），网页里的形象不受影响。</p>
<footer><button id="save" type="submit">保存设置</button><p id="status" role="status" aria-live="polite">正在读取设置…</p></footer>
</form></main></body></html>
`;

export const petSettingsStyle = `:root{--blue:#1b5f8a;--blue-soft:#edf5fa;--ink:#22313b;--muted:#6d7f8b;--line:#d8e3ea;--bg:#f6fafc}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif}
main{max-width:760px;margin:28px auto;padding:0 18px 36px}header{padding:0 8px 16px}
.fish{font-size:26px;display:block;margin-bottom:8px}.local{margin:0;color:var(--muted);font-size:13px;letter-spacing:.04em}
h1{margin:4px 0 8px;font-size:27px;color:var(--blue)}.intro{margin:0;color:var(--muted);font-size:14px}
a{color:var(--blue)}form{background:#fff;border:1px solid var(--line);border-radius:12px;padding:6px 22px 16px;box-shadow:0 2px 10px rgba(27,95,138,.05)}
fieldset{border:0;border-top:1px solid var(--line);margin:0;padding:14px 0 6px}fieldset:first-of-type{border-top:0}
legend{font-weight:700;color:var(--blue);padding:0 0 2px}
label{display:block;margin:8px 0 3px;font-size:13px;color:var(--muted)}
input[type=text],input[type=number],input[type=url],input[type=password],textarea,select{width:100%;min-height:34px;padding:5px 9px;border:1px solid var(--line);border-radius:6px;font-size:14px;color:var(--ink);background:#fff}
textarea{min-height:110px;resize:vertical;font-family:inherit;line-height:1.55}
input:focus,select:focus{outline:2px solid var(--blue-soft);border-color:var(--blue)}
.pair{display:inline-block;width:calc(50% - 8px);vertical-align:top;margin-right:12px}
.pair:nth-of-type(even){margin-right:0}
label.check{display:flex;align-items:center;gap:8px;margin:10px 0 2px;color:var(--ink);font-size:14px}
label.check input{width:16px;height:16px}
.hint{color:var(--muted);font-size:12.5px;margin:10px 0 0;line-height:1.55}
.test-row{display:flex;align-items:center;gap:12px;margin:10px 0 2px;flex-wrap:wrap}
#test-btn{background:#fff;color:var(--blue);border:1.5px solid var(--blue);min-height:34px;padding:4px 16px;font-size:13.5px;border-radius:6px;cursor:pointer;font-weight:600}
.test-result{font-size:13px;flex:1 1 180px;min-height:20px}.test-success{color:#1a7f37;font-weight:600}.test-error{color:#cf222e}
footer{display:flex;align-items:center;gap:16px;margin-top:18px;flex-wrap:wrap}
#save{background:var(--blue);color:#fff;border:0;min-height:38px;padding:7px 24px;font-size:15px;border-radius:6px;cursor:pointer;font-weight:600}
#save:disabled{opacity:.6;cursor:wait}#status{margin:0;font-size:13px;color:var(--muted);flex:1 1 200px}
#status[data-error=true]{color:#a13b30}#status[data-ok=true]{color:#1a7f37;font-weight:600}
@media(max-width:560px){main{margin:18px auto}.pair{width:100%;margin-right:0}footer{flex-direction:column;align-items:stretch}#save{width:100%}}
`;

export const petSettingsScript = `
'use strict';
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  history.replaceState(null, '', location.pathname);
  const get = (id) => document.getElementById(id);
  const form = get('settings');
  const save = get('save');
  const status = get('status');
  const testBtn = get('test-btn');
  const testResult = get('test-result');
  const PET = '/standalone-pet/settings';
  const AI = '/standalone-ai/settings';
  // 本地后端参数备忘（哥哥 11-03 报：本地 → 云端 → 再切回本地，地址和模型都被清空要重填）。
  // 服务端一次只存一种后端，切到云端后本地那份就从配置里消失了；页面这边切走前记一份、
  // 切回来时补回空栏即可。存在 localStorage，关掉设置页再打开也还在。
  const MEMO_KEY = 'body-of-fish.local-backend.memo';
  const memo = (() => {
    try { const raw = JSON.parse(localStorage.getItem(MEMO_KEY) || '{}'); return raw && typeof raw === 'object' ? raw : {}; }
    catch { return {}; }
  })();
  const saveMemo = () => { try { localStorage.setItem(MEMO_KEY, JSON.stringify(memo)); } catch { /* 无痕模式写不了，忽略 */ } };
  function message(text, kind) { status.textContent = text; status.dataset.error = String(kind === 'error'); status.dataset.ok = String(kind === 'ok'); }
  async function request(path, method, body) {
    const response = await fetch(path, {
      method, credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'X-DSH-Pet-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      if (response.status === 403) throw new Error('打开凭据已失效。请从桌宠菜单重新打开设置。');
      if (response.status === 429) throw new Error('保存过于频繁，请稍等一分钟再试。');
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || '保存失败，请稍后再试');
    }
    return response.json();
  }
  // 一页到底，但配置还是两份：外观/人格/看图/声音在宠物配置里，对话模型在 AI 设置里。
  // 页面是一次提交，脚本替用户分两次写——任何一步失败都明确报出来，不假装"都保存好了"。
  const texts = ['name', 'fontFamily', 'corner', 'persona', 'protocol', 'baseUrl', 'model',
    'visionMode', 'visionEndpoint', 'visionModel', 'voiceMode', 'voiceProtocol', 'voiceEndpoint',
    'voiceModel', 'voiceRefAudio', 'voicePromptText'];
  const numbers = ['size', 'marginX', 'marginY', 'fontSize', 'gravity', 'restitution', 'groundFriction',
    'throwPower', 'maxTokens'];
  const flags = ['desktopVisible', 'fixedEnabled', 'confineToScreen', 'followPet', 'ceilingBounce', 'enabled'];
  function fillPet(data) {
    for (const id of ['name', 'fontFamily', 'corner', 'persona', 'visionMode', 'visionEndpoint', 'visionModel',
      'visionBaseUrl', 'voiceMode', 'voiceProtocol', 'voiceEndpoint', 'voiceModel', 'voiceBaseUrl',
      'voiceRefAudio', 'voicePromptText',
      'earHotkey', 'peekHotkey', 'sayHotkey']) {
      const el = get(id); if (el && data[id] !== undefined) el.value = String(data[id]);
    }
    // 密钥不回显：只报「有没有」，输入框清空，勾选框复位
    for (const cap of ['vision', 'voice']) {
      const state = get(cap + '-key-state');
      if (state) state.textContent = data['has' + cap[0].toUpperCase() + cap.slice(1) + 'Key'] ? '已保存 · 不回显' : '沿用对话模型';
      const input = get(cap + 'ApiKey'); if (input) input.value = '';
      const clear = get('clear' + cap[0].toUpperCase() + cap.slice(1) + 'ApiKey'); if (clear) clear.checked = false;
    }
    for (const id of ['size', 'marginX', 'marginY', 'fontSize', 'gravity', 'restitution', 'groundFriction', 'throwPower']) {
      const el = get(id); if (el && data[id] !== undefined) el.value = String(data[id]);
    }
    for (const id of ['desktopVisible', 'fixedEnabled', 'confineToScreen', 'followPet', 'ceilingBounce']) {
      const el = get(id); if (el) el.checked = data[id] === true;
    }
  }
  function fillAi(ai) {
    for (const id of ['protocol', 'baseUrl', 'model', 'maxTokens']) {
      if (ai[id] !== undefined) get(id).value = String(ai[id]);
    }
    get('enabled').checked = ai.enabled === true;
    get('key-state').textContent = ai.hasKey ? '已保存 · 不回显' : '尚未设置';
    get('apiKey').value = '';
    get('clearApiKey').checked = false;
  }
  // 本地后端参数备忘：从本地切到云端前记下「本地地址 / 模型名」，切回本地时补回空栏
  function wireLocalMemo() {
    for (const cap of ['vision', 'voice']) {
      const mode = get(cap + 'Mode'); const endpoint = get(cap + 'Endpoint'); const model = get(cap + 'Model');
      if (!mode || !endpoint || !model) continue;
      const remember = () => {
        const saved = memo[cap] || {};
        memo[cap] = {
          endpoint: endpoint.value.trim() || saved.endpoint || '',
          model: model.value.trim() || saved.model || '',
        };
        saveMemo();
      };
      const restore = () => {
        const saved = memo[cap] || {};
        if (endpoint.value.trim() === '' && saved.endpoint) endpoint.value = saved.endpoint;
        if (model.value.trim() === '' && saved.model) model.value = saved.model;
      };
      let last = mode.value;
      if (last === 'local') remember(); // 页面一打开就是本地：先把现有值记一份
      mode.addEventListener('change', () => {
        if (last === 'local' && mode.value !== 'local') remember();
        if (mode.value === 'local') restore();
        last = mode.value;
      });
    }
  }
  function petBody() {
    const body = {
      name: get('name').value.trim(), size: Number(get('size').value),
      desktopVisible: get('desktopVisible').checked, fixedEnabled: get('fixedEnabled').checked,
      corner: get('corner').value, marginX: Number(get('marginX').value), marginY: Number(get('marginY').value),
      confineToScreen: get('confineToScreen').checked, fontFamily: get('fontFamily').value,
      fontSize: Number(get('fontSize').value), followPet: get('followPet').checked,
      gravity: Number(get('gravity').value), restitution: Number(get('restitution').value),
      groundFriction: Number(get('groundFriction').value), throwPower: Number(get('throwPower').value),
      ceilingBounce: get('ceilingBounce').checked, persona: get('persona').value.trim(),
      visionMode: get('visionMode').value, visionEndpoint: get('visionEndpoint').value.trim(),
      visionModel: get('visionModel').value.trim(), voiceMode: get('voiceMode').value,
      visionBaseUrl: get('visionBaseUrl').value.trim(), clearVisionApiKey: get('clearVisionApiKey').checked,
      voiceProtocol: get('voiceProtocol').value, voiceEndpoint: get('voiceEndpoint').value.trim(),
      voiceModel: get('voiceModel').value.trim(), voiceRefAudio: get('voiceRefAudio').value.trim(),
      voicePromptText: get('voicePromptText').value.trim(),
      voiceBaseUrl: get('voiceBaseUrl').value.trim(), clearVoiceApiKey: get('clearVoiceApiKey').checked,
      // 快捷键：留空 = 用默认（Alt+T / Alt+G / Alt+S），写成空串交给后端删键
      earHotkey: get('earHotkey').value.trim(), peekHotkey: get('peekHotkey').value.trim(),
      sayHotkey: get('sayHotkey').value.trim(),
    };
    // 密钥只在非空时提交（空 = 保留已保存的那把）
    const visionKey = get('visionApiKey').value; if (visionKey) body.visionApiKey = visionKey;
    const voiceKey = get('voiceApiKey').value; if (voiceKey) body.voiceApiKey = voiceKey;
    return body;
  }
  function aiBody() {
    return {
      protocol: get('protocol').value, baseUrl: get('baseUrl').value.trim(), model: get('model').value.trim(),
      apiKey: get('apiKey').value, clearApiKey: get('clearApiKey').checked,
      enabled: get('enabled').checked, maxTokens: Number(get('maxTokens').value),
    };
  }
  get('clearApiKey').addEventListener('change', () => {
    get('apiKey').disabled = get('clearApiKey').checked;
    if (get('clearApiKey').checked) { get('apiKey').value = ''; get('enabled').checked = false; }
  });
  if (testBtn && testResult) {
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testResult.className = 'test-result';
      testResult.textContent = '正在测试连接，请稍候…';
      try {
        const response = await fetch('/standalone-ai/test', {
          method: 'POST', credentials: 'omit', cache: 'no-store',
          headers: { 'X-DSH-Pet-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ protocol: get('protocol').value, baseUrl: get('baseUrl').value.trim(),
            model: get('model').value.trim(), apiKey: get('apiKey').value.trim() }),
        });
        const data = await response.json();
        if (data.ok) {
          testResult.className = 'test-result test-success';
          testResult.textContent = '✓ ' + data.message + (data.reply ? '（回复：' + data.reply + '）' : '');
        } else {
          testResult.className = 'test-result test-error';
          testResult.textContent = '✗ ' + (data.message || data.error || '测试失败');
        }
      } catch (error) {
        testResult.className = 'test-result test-error';
        testResult.textContent = '✗ 请求异常：' + (error && error.message ? error.message : String(error));
      } finally { testBtn.disabled = false; }
    });
  }
  async function load() {
    if (!token) throw new Error('请从桌宠菜单或本机启动器打开设置，以获得本次运行的访问凭据。');
    const [ai, pet] = await Promise.all([request(AI, 'GET'), request(PET, 'GET').catch(() => ({}))]);
    fillPet(pet);
    fillAi(ai);
    message('设置只在本机保存。', null);
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    save.disabled = true;
    message('正在保存…', null);
    const pet = petBody();
    const ai = aiBody();
    get('apiKey').value = '';
    try {
      // 两次写：宠物配置（外观/人格/看图/声音）与 AI 设置（对话模型）。失败就明说哪一步。
      const savedPet = await request(PET, 'POST', pet);
      try {
        const savedAi = await request(AI, 'POST', ai);
        fillPet(savedPet); fillAi(savedAi);
      } catch (error) {
        fillPet(savedPet);
        throw new Error('外观等已保存，但对话模型没存上：' + (error && error.message ? error.message : String(error)));
      }
      get('apiKey').disabled = false;
      message('已保存，桌面小窗正在重开', 'ok');
    } catch (error) { message(error instanceof Error ? error.message : String(error), 'error'); }
    finally { save.disabled = false; }
  });
  wireLocalMemo();
  load().catch((error) => message(error instanceof Error ? error.message : String(error), 'error'));
})();
`;
