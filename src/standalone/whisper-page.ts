/**
 * 「碎碎念间隔」小窗：右键菜单「碎碎念 → 自定义间隔…」打开的独立小页。
 *
 * 为什么单独一页：右键菜单本身只能点 label、没法输入数字；而哥哥要的是"菜单里就能手填秒数"。
 * 菜单项一点 → 宿主用浏览器打开这页（带令牌）→ 填秒数保存 → 写 `eventsRefreshSec.whisper`。
 * 与菜单里的四档预设、以及设置页（已按哥哥要求删掉碎碎念）写的是**同一个字段**。
 */
export const whisperPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>碎碎念间隔</title><link rel="stylesheet" href="/standalone-pet/whisper.css">
<script src="/standalone-pet/whisper.js" defer></script></head><body>
<main><header><span class="fish" aria-hidden="true">🐾</span><p class="local">独立桌宠 / 碎碎念</p>
<h1>多久自己说一句</h1><p class="intro">只从本机「碎碎念池」里抽一句，不联网、不花钱。<br>填好后点保存，右键菜单那张 ✓ 会跟着变。</p></header>
<form id="whisper">
<label for="seconds">间隔（秒）</label>
<input id="seconds" type="number" min="30" max="86400" step="1" required>
<p class="hint" id="current">正在读取当前间隔…</p>
<p class="hint">范围 30–86400 秒（半分钟到 24 小时）。实际触发会前后浮动约 20%，不会整点打卡。</p>
<footer><button id="save" type="submit">保存</button><p id="status" role="status" aria-live="polite"></p></footer>
</form></main></body></html>
`;

export const whisperStyle = `:root{--blue:#1b5f8a;--blue-soft:#edf5fa;--ink:#22313b;--muted:#6d7f8b;--line:#d8e3ea;--bg:#f6fafc}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif}
main{max-width:460px;margin:32px auto;padding:0 18px}
.fish{font-size:24px;display:block;margin-bottom:6px}.local{margin:0;color:var(--muted);font-size:13px}
h1{margin:4px 0 8px;font-size:24px;color:var(--blue)}.intro{margin:0 0 16px;color:var(--muted);font-size:14px}
form{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 20px 18px;box-shadow:0 2px 10px rgba(27,95,138,.05)}
label{display:block;margin:4px 0;font-size:13px;color:var(--muted)}
input{width:100%;min-height:38px;padding:6px 10px;border:1px solid var(--line);border-radius:6px;font-size:16px}
input:focus{outline:2px solid var(--blue-soft);border-color:var(--blue)}
.hint{color:var(--muted);font-size:12.5px;margin:10px 0 0}
footer{display:flex;align-items:center;gap:14px;margin-top:16px}
#save{background:var(--blue);color:#fff;border:0;min-height:38px;padding:7px 22px;font-size:15px;border-radius:6px;cursor:pointer;font-weight:600}
#save:disabled{opacity:.6;cursor:wait}#status{margin:0;font-size:13px;color:var(--muted);flex:1}
#status[data-error=true]{color:#a13b30}#status[data-ok=true]{color:#1a7f37;font-weight:600}
`;

export const whisperScript = `
'use strict';
(() => {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token') || '';
  // 【本鱼 · 11-02】同一个输入小窗也服务「陪伴：自定义…」：?target=companion 时改填分钟数
  const companion =
    params.get('target') === 'companion' || new URLSearchParams(location.search).get('target') === 'companion';
  history.replaceState(null, '', location.pathname);
  const get = (id) => document.getElementById(id);
  const form = get('whisper');
  const save = get('save');
  const status = get('status');
  const field = get('seconds');
  const current = get('current');
  function message(text, kind) { status.textContent = text; status.dataset.error = String(kind === 'error'); status.dataset.ok = String(kind === 'ok'); }
  async function request(method, body) {
    const response = await fetch('/standalone-pet/settings', {
      method, credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'X-DSH-Pet-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      if (response.status === 403) throw new Error('打开凭据已失效。请从桌宠菜单重新打开一次。');
      if (response.status === 429) throw new Error('保存过于频繁，请稍等一分钟再试。');
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || '保存失败，请稍后再试');
    }
    return response.json();
  }
  if (companion) {
    document.title = '陪伴间隔';
    const h1 = document.querySelector('h1'); if (h1) h1.textContent = '陪伴隔多久看一眼';
    const label = document.querySelector('label'); if (label) label.textContent = '间隔（分钟）';
    field.min = '1'; field.max = '1440';
    const intro = document.querySelector('.intro'); if (intro) intro.textContent = '陪伴开着时按这个间隔截图看一眼，画面变了才说话。';
  }
  async function load() {
    if (!token) throw new Error(companion ? '请从桌宠右键菜单「陪伴 → 自定义…」打开。' : '请从桌宠右键菜单「碎碎念 → 自定义间隔…」打开。');
    const data = await request('GET');
    if (companion) {
      const minutes = Math.max(1, Math.round(Number(data.companionIntervalMin) || 1));
      field.value = String(minutes);
      current.textContent = '当前：每 ' + minutes + ' 分钟';
      message('', null);
      return;
    }
    const seconds = Math.max(30, Math.round(Number(data.whisperIntervalSec) || 60));
    field.value = String(seconds);
    current.textContent = '当前：每 ' + seconds + ' 秒（约 ' + (Math.round((seconds / 60) * 10) / 10) + ' 分钟）';
    message('', null);
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    save.disabled = true;
    message('正在保存…', null);
    try {
      if (companion) {
        const data = await request('POST', { companionIntervalMin: Number(field.value) });
        const minutes = Math.max(1, Math.round(Number(data.companionIntervalMin) || Number(field.value)));
        field.value = String(minutes);
        current.textContent = '当前：每 ' + minutes + ' 分钟';
        message('已保存，下一次陪伴按新间隔走', 'ok');
        return;
      }
      const data = await request('POST', { whisperIntervalSec: Number(field.value) });
      const seconds = Math.max(30, Math.round(Number(data.whisperIntervalSec) || Number(field.value)));
      field.value = String(seconds);
      current.textContent = '当前：每 ' + seconds + ' 秒';
      message('已保存', 'ok');
    } catch (error) { message(error instanceof Error ? error.message : String(error), 'error'); }
    finally { save.disabled = false; }
  });
  load().catch((error) => message(error instanceof Error ? error.message : String(error), 'error'));
})();
`;
