import { rmSync, writeFileSync } from 'node:fs';

import { createVoicePlayer } from './src/host/core/voice-player.ts';

const file = 'D:/AI/存档/临时/probe/long.wav';
const player = createVoicePlayer();
player.warm();
await new Promise((r) => setTimeout(r, 1800));
console.log('ready =', player.ready);

// 第一句
let t = Date.now();
let playAt = 0;
let r1 = await player.play(file, 90, () => {
  playAt = Date.now() - t;
});
console.log('第一句：起播', playAt, 'ms，总', Date.now() - t, 'ms ok', r1.ok, 'faded', r1.faded);

// 第二句（同样的文件）
t = Date.now();
playAt = 0;
r1 = await player.play(file, 90, () => {
  playAt = Date.now() - t;
});
console.log('第二句：起播', playAt, 'ms，总', Date.now() - t, 'ms ok', r1.ok);

// 第三句：播到一半停（淡出）
t = Date.now();
const p3 = player.play(file, 90);
setTimeout(() => {
  const at = Date.now();
  player.stop();
  console.log('写 STOP 于', at - t, 'ms');
}, 900);
const r3 = await p3;
console.log('第三句结果：ok', r3.ok, 'faded', r3.faded, '总', Date.now() - t, 'ms');

player.dispose();
rmSync(`${file}.stop`, { force: true });
writeFileSync('D:/AI/存档/临时/probe/daemon-done.txt', 'ok');
