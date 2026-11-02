/**
 * 老地址 `/standalone-ai/` 的收尾页：**只做跳转**。
 *
 * 为什么留着：托盘、任务栏快捷方式、哥哥的书签、能力文件里的 settingsUrl 都还可能是这个地址，
 * 直接 404 会让人以为"设置丢了"。现在设置合成一页（`/standalone-pet/`），这里负责带上令牌转过去。
 * 页面本身不含内联脚本（CSP 不允许），跳转逻辑在外部 `/standalone-ai/settings.js`。
 */
export const settingsPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>桌宠设置</title><link rel="stylesheet" href="/standalone-ai/settings.css">
<script src="/standalone-ai/settings.js" defer></script></head><body>
<main><header><span class="fish" aria-hidden="true">🐾</span><p class="local">独立桌宠 / 本机设置</p>
<h1>正在前往设置页…</h1>
<p class="intro">设置已经合成一页了（外观、人格、对话、看图、声音都在同一页）。<br>
如果没有自动跳转，点这里：<a id="pet-link" href="/standalone-pet/">打开桌宠设置</a></p></header>
</main></body></html>`;

export const settingsStyle = `
:root{color-scheme:light;--ink:#203b4b;--muted:#526a78;--blue:#12618b;--line:#cbdce5;--paper:#fff;--water:#edf5fa}
*{box-sizing:border-box}body{margin:0;background:var(--water);color:var(--ink);font:16px/1.6 "Microsoft YaHei UI","PingFang SC",sans-serif}
main{max-width:640px;margin:60px auto;padding:0 24px}header{padding:0 12px}
.fish{display:block;font:700 26px/1.3 Georgia,serif;color:var(--blue);letter-spacing:2px;margin-bottom:20px}
.local{font-size:13px;color:var(--muted);margin:0 0 10px}h1{font-size:26px;margin:0 0 14px;color:var(--blue)}
.intro{margin:0;color:var(--muted)}a{color:var(--blue)}
/* 键盘也能走到这条链接：给一个看得见的焦点圈（这页就一个可点元素，更不能只靠鼠标） */
a:focus-visible{outline:2px solid var(--blue);outline-offset:3px;border-radius:4px}
`;

/** 带上令牌转到唯一的那页设置；hash 里的令牌只有本页脚本知道，所以只能在客户端转。 */
export const settingsScript = `
'use strict';
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  const target = '/standalone-pet/' + (token ? '#token=' + encodeURIComponent(token) : '');
  const link = document.getElementById('pet-link');
  if (link) link.href = target;
  location.replace(target);
})();
`;
