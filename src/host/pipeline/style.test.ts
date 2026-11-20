import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { renderTemplate } from '../game-talk.ts';
import { SAY_MAX_CHARS, STYLE_RULES } from './style.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = join(here, '..');
const read = (name: string): string => readFileSync(join(hostDir, name), 'utf8');

describe('说话规矩：一句 20 字、学会闲聊不复述（哥哥 m26171）', () => {
  it('长度就是一个数，改口径只改这一处', () => {
    assert.equal(SAY_MAX_CHARS, 20);
    assert.match(STYLE_RULES, /20 字以内/u);
  });

  it('规矩里必须写明「闲聊不复述」这条重点', () => {
    assert.match(STYLE_RULES, /闲聊/u);
    assert.match(STYLE_RULES, /不是复述/u);
    assert.match(STYLE_RULES, /不列一二三/u);
  });

  it('陪伴提示词渲染后不留 {{style}} 占位符', () => {
    const out = renderTemplate('前\n{{style}}\n后', { style: STYLE_RULES });
    assert.equal(out.includes('{{style}}'), false);
    assert.equal(out.includes('闲聊'), true);
  });
});

describe('说话规矩：两处共用，聊天不再没有规矩', () => {
  it('聊天 system 拼上了 STYLE_RULES', () => {
    const src = read('index.ts');
    // m31144：规矩后面还接「他这会儿」公共块；m33631 又在中间插了「这轮为什么开口」
    assert.match(src, /const baseSystem =[\s\S]{0,160}petSystemPrompt\(found\)/u);
    assert.match(src, /memoryBlock[\s\S]{0,160}STYLE_RULES/u);
    assert.match(src, /STYLE_RULES \+[\s\S]{0,200}contextBlock\(live\.line\)/u);
  });

  it('陪伴提示词用 {{style}} 而不是自己再写一套', () => {
    const src = read('game-talk.ts');
    assert.equal(src.includes("{{style}}"), true);
    assert.equal(src.includes('怎么说话——像人，不像复述'), false);
    assert.match(src, /style: STYLE_RULES,/u);
  });

  it('识图问句不再问「窗口标题是什么」（念文件名的源头）', () => {
    const src = read('index.ts');
    const start = src.indexOf('const LOOK_DETAIL_PROMPT =');
    const end = src.indexOf('const lookOnce = async', start);
    const body = src.slice(start, end);
    assert.equal(body.includes('窗口标题'), false);
    assert.match(body, /不要念文件名和路径/u);
  });
});