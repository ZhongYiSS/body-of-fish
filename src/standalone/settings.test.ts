import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSettings, publicSettings } from './settings.ts';
import { settingsPage, settingsScript, settingsStyle } from './settings-page.ts';

test('settings validation accepts explicit costs and write-only blank/clear key semantics', () => {
  const input = {
    protocol: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'model',
    apiKey: '',
    enabled: false,
    automaticWhispers: false,
    whisperIntervalSec: 300,
    maxTokens: 512,
  };
  assert.deepEqual(validateSettings(input), input);
  assert.deepEqual(validateSettings({ clearApiKey: true }), { clearApiKey: true });
  for (const input of [
    null,
    [],
    { protocol: 'other' },
    { enabled: 'true' },
    { whisperIntervalSec: 59 },
    { whisperIntervalSec: 1.5 },
    { maxTokens: 99999 },
    { apiKey: 123 },
    { hasKey: true },
    { baseUrl: 'file:///a' },
    { baseUrl: 'https://user:secret@example.test/v1' },
    { baseUrl: 'https://example.test/?key=secret' },
  ]) {
    assert.throws(() => validateSettings(input), Error, JSON.stringify(input));
  }
});
test('public settings are an allowlist even if backend accidentally includes credentials', () => {
  const actual = publicSettings({
    protocol: 'anthropic',
    apiKey: 'never expose',
    token: 'never expose',
    hasKey: true,
    model: 'x',
    enabled: false,
  });
  assert.deepEqual(actual, { protocol: 'anthropic', hasKey: true, model: 'x', enabled: false });
  assert.equal(JSON.stringify(actual).includes('never expose'), false);
});
test('老地址只做跳转：不乱存数据、不要求密码、把令牌带过去', () => {
  assert.match(settingsPage, /lang="zh-CN"/);
  // 这页没有表单了（设置合成一页），所以没有密码框、没有提交按钮
  assert.doesNotMatch(settingsPage, /type="password"/);
  assert.match(settingsPage, /id="pet-link"/);
  // 跳转脚本里不该出现任何"自己发请求/自己存令牌"的动作
  assert.doesNotMatch(settingsScript, /fetch|localStorage|sessionStorage|document\.cookie|X-DSH-Pet-Token/);
  assert.match(settingsScript, /location\.replace/);
  assert.match(settingsStyle, /focus-visible/);
});

test('跳转脚本把 hash 里的令牌原样带去 /standalone-pet/，没有令牌就不编一个', async () => {
  const { runInNewContext } = await import('node:vm');
  const run = (hash: string): { replaced: string; href: string } => {
    const state = { replaced: '', href: '' };
    const link = { href: '' };
    runInNewContext(settingsScript, {
      URLSearchParams,
      encodeURIComponent,
      location: {
        hash,
        replace: (target: string) => {
          state.replaced = target;
        },
      },
      document: { getElementById: () => link },
    });
    state.href = link.href;
    return state;
  };
  assert.equal(run('#token=abc123').replaced, '/standalone-pet/#token=abc123');
  assert.equal(run('#token=abc123').href, '/standalone-pet/#token=abc123');
  assert.equal(run('').replaced, '/standalone-pet/');
  assert.equal(run('').href, '/standalone-pet/');
});
