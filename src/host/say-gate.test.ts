/**
 * 「说」层：出不出声那一个闸（11-20 哥哥 m34789）。
 *
 * 干什么：钉住三条**结构契约**，防止以后有人把闸挪走或者挪成两处。
 *   ① 全局只有一个闸：`playAudio` 里 `voiceSpeakOn()` 在「代数过期」判断之前，且静音时不 spawn 播放器；
 *   ② 静音时也要回调 onStart，否则气泡永远等不到 show()（「没声音但字也不出来」）；
 *   ③ 配置白名单收 `voice.speak`（加键不同步 mergeEntry 就永远存不进去，11-09 踩过）。
 * 什么时候别用：想看「音色怎么选」的测试不在这（那是嗓子四块，见 voice 相关测试）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const indexPath = join(root, 'src', 'host', 'index.ts');
const configPath = join(root, 'src', 'host', 'config.ts');
const index = readFileSync(indexPath, 'utf8');
const config = readFileSync(configPath, 'utf8');

test('静音闸只有一处：playAudio 里、代数判断之前', () => {
  assert.ok(index.includes('const voiceSpeakOn = (): boolean =>'), '该有唯一的 voiceSpeakOn');
  // 播放闸只有一处（菜单那边读状态，不算第二个分支）
  assert.equal(index.split('if (!voiceSpeakOn())').length - 1, 1, '播放闸只许有一个');
  const gate = index.indexOf('if (!voiceSpeakOn()) {');
  const stale = index.indexOf('if (atEpoch !== undefined && atEpoch !== epoch) {');
  assert.ok(gate > 0 && stale > 0, '两段都该在');
  assert.ok(gate < stale, '静音要先于「先看代数」，否则过期的句子还会被记一笔 play-skip stale-epoch');
});

test('静音时照常回调 onStart（气泡不能因为没声音就不冒）', () => {
  const chunk = index.slice(index.indexOf('if (!voiceSpeakOn()) {'), index.indexOf('if (!voiceSpeakOn()) {') + 700);
  assert.ok(chunk.includes('onStart?.()'), '静音分支必须调用 onStart');
  assert.ok(chunk.includes('play-skip muted'), '静音要留一行日志，别让人以为嗓子坏了');
  assert.ok(chunk.includes('resolve()'), '静音分支要收尾，不能把 await 挂住');
});

test('配置白名单收 voice.speak（加键必须同步 mergeEntry）', () => {
  assert.match(config, /if \(typeof src\.speak === 'boolean'\) out\.speak = src\.speak;/u);
});

test('陪伴的出声项读写同一份开关（不许两处各存一份）', () => {
  const handler = index.slice(index.indexOf("case 'watch-voice-toggle': {"));
  const body = handler.slice(0, handler.indexOf("case 'say-toggle': {"));
  assert.ok(body.includes('voiceSpeakOn()'), '陪伴出声项要读全局');
  assert.ok(body.includes('raw.voice = { ...section, speak: next }'), '陪伴出声项要写全局');
  assert.ok(!body.includes('raw.watch'), '不许再写 watch.speak');
});