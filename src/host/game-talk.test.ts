/**
 * 回看提示词（哥哥 m31134：识图回看也要知道「这是哪个窗口」，别让它猜）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDetailPrompt, DEFAULT_DETAIL_PROMPT } from './game-talk.ts';

test('回看提示词带上窗口名', () => {
  const prompt = buildDetailPrompt('这个报错说的什么', undefined, 'Visual Studio Code');
  assert.match(prompt, /只回答这一件事：这个报错说的什么/u);
  assert.match(prompt, /他在看的是：Visual Studio Code/u);
});

test('拿不到窗口名就别编，写「不知道」', () => {
  const prompt = buildDetailPrompt('左上角写的是什么');
  assert.match(prompt, /他在看的是：不知道/u);
});

test('自定义模板不吃 {{window}} 也不会露出占位符', () => {
  const prompt = buildDetailPrompt('多少字', '只回答：{{question}}', '记事本');
  assert.equal(prompt.includes('{{'), false);
  assert.equal(prompt, '只回答：多少字');
});

test('默认模板里确实有 {{window}} 这一行', () => {
  assert.match(DEFAULT_DETAIL_PROMPT, /他在看的是：\{\{window\}\}/u);
});
