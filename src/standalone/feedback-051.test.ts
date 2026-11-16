// 11-16 装完 0.5.0 之后哥哥报的三件事（m23786）——防止再被改回去：
//   ①「一眼看」的间隔要 20–600 秒（原来按分钟、最小 1 分钟，和提示里的秒数对不上）
//   ②第二次双击要看到「已经开着一个了」（宿主进程自己弹框，不再靠 CLI spawn 的 PowerShell）
//   ③没开一眼看/陪伴时不该挂着「本鱼正在偷看…」（成功之后必须撤掉）
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyPatch, validatePetSettings, viewOf } from './pet-settings.ts';
import { whisperPage, whisperScript } from './whisper-page.ts';

function read(rel: string): string {
  return readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
}

test('一眼看间隔：秒为单位，20–600', () => {
  const view = viewOf({});
  assert.equal(view.companionIntervalSec, 60, '默认 1 分钟 = 60 秒');

  assert.equal(validatePetSettings({ companionIntervalSec: 20 }).companionIntervalSec, 20);
  assert.equal(validatePetSettings({ companionIntervalSec: 600 }).companionIntervalSec, 600);
  assert.throws(() => validatePetSettings({ companionIntervalSec: 10 }), /出错的字段：companionIntervalSec/u);
  assert.throws(() => validatePetSettings({ companionIntervalSec: 900 }), /出错的字段：companionIntervalSec/u);
  assert.throws(() => validatePetSettings({ companionIntervalMin: 1 }), /companionIntervalMin/u, '分钟字段已经下线');

  const saved = applyPatch({}, { companionIntervalSec: 45 }).companion as Record<string, unknown> | undefined;
  assert.equal(saved?.intervalMs, 45_000, '落盘还是毫秒');
  // 回显：5 分钟（菜单里填的 300 秒）不能被截成别的数
  assert.equal(viewOf({ companion: { intervalMs: 300_000 } }).companionIntervalSec, 300);
  // 老配置里的小时级数值要夹回 600 秒，别让界面显示 3600
  assert.equal(viewOf({ companion: { intervalMs: 3_600_000 } }).companionIntervalSec, 600);
  assert.equal(viewOf({ companion: { intervalMs: 1000 } }).companionIntervalSec, 20);
});

test('一眼看小窗：填的是秒，范围写在控件和提示里', () => {
  assert.ok(whisperPage.includes('id="range"'), '范围提示要有 id，切到看一眼时要能改字');
  assert.ok(whisperScript.includes("field.min = '20'"), '最小值 20 秒');
  assert.ok(whisperScript.includes("field.max = '600'"), '最大值 600 秒');
  assert.ok(whisperScript.includes("label.textContent = '间隔（秒）'"), '标签要写秒，别再写分钟');
  assert.ok(whisperScript.includes('companionIntervalSec'), '提交/回显都走秒字段');
  assert.ok(!whisperScript.includes('companionIntervalMin'), '分钟字段已经下线');
});

test('「正在偷看」不再往主气泡写：状态只走副气泡【在看】', () => {
  const source = read('src/host/index.ts');
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
  // 11-17 m24756：主气泡只装她说的话。「本鱼正在偷看…」是状态，已删除，
  // 改由 watchSheet 里的 pushHint('watch', '【在看】', 'task') 表达。
  assert.ok(!code.includes("statusBubble('本鱼正在偷看…'"), '主气泡不许再写「正在偷看」');
  assert.ok(code.includes("pushHint('watch', '【在看】', 'task')"), '状态要落到副气泡');
  assert.ok(code.includes("dropHint('watch')"), '看完要及时撤');
  assert.ok(code.includes("dropHint('status')"), '失败提示（识图失败这类）仍要能撤');
});

test('第二次双击：宿主自己看锁、自己弹框，被挡下就别留在后台', () => {
  const source = read('packaging/electron-main.cjs');
  assert.ok(source.includes('showMessageBoxSync'), '要弹原生框（不再靠 CLI spawn PowerShell）');
  assert.ok(source.includes("'standalone.lock'"), '先读锁文件');
  assert.ok(source.includes('本鱼已经开着一个了'), '文案要和菜单里那句一致');
  assert.ok(!source.includes('改为在宿主进程内直接加载独立版 CLI'), '不许再留幽灵进程');
  assert.ok(source.includes('app.quit()'), '拦下或 CLI 退出都要收工');
});