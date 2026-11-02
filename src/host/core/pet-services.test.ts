/**
 * 对外服务契约守卫 —— 嘴、眼、气泡是"别人来调桌宠"的那一面，不能被各写一份。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { EXTERNAL_BUBBLE_MS, canReplace, isEmptyBubble } from './pet-services.ts';

const file = readFileSync(join(import.meta.dirname, 'pet-services.ts'), 'utf8');

describe('对外服务契约', () => {
  it('不许 import src/shared', () => {
    assert.ok(!/from\s+['"][^'"]*\/shared\//.test(file));
  });

  it('三件对外能力齐全：气泡 / 嘴 / 眼', () => {
    for (const need of ['bubble:', 'voice:', 'eyes:', 'snapshot(']) assert.ok(file.includes(need), need);
  });

  it('声音和识图必须复用网关，不许自己写一套后端', () => {
    assert.ok(/import type \{[^}]*ModelStatus[^}]*\} from '\.\/model-gateway\.ts'/.test(file));
    assert.ok(file.includes('ModelGateway.tts'), '声音要说明走网关');
    assert.ok(file.includes('ModelGateway.vision'), '识图要说明走网关');
    assert.ok(!file.includes('127.0.0.1:') && !file.includes('https://'), '对外契约里不许写死后端地址');
  });

  it('气泡必须有 id 才让人 clear，且 sticky 不能被闲聊顶掉', () => {
    const sticky = { id: 'a', text: '记住喝水', sticky: true, at: 1 };
    const chat = { id: 'b', text: '咕噜', sticky: false, at: 2 };
    assert.equal(canReplace(null, { sticky: false }), true);
    assert.equal(canReplace(sticky, { sticky: false }), false, '重要提示不能被碎碎念盖掉');
    assert.equal(canReplace(sticky, { sticky: true }), true);
    assert.equal(canReplace(chat, { sticky: false }), true);
  });

  it('空气泡直接拒：没字也没图', () => {
    assert.equal(isEmptyBubble({ text: '   ' }), true);
    assert.equal(isEmptyBubble({ text: '在的' }), false);
    assert.equal(isEmptyBubble({ text: '', image: 'D:/a.png' }), false);
  });

  it('外部气泡默认时长是短的（8 秒），不把桌宠变弹幕机', () => {
    assert.equal(EXTERNAL_BUBBLE_MS, 8000);
  });
});
