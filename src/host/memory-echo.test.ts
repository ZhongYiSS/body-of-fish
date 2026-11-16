import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  ECHO_THRESHOLD,
  containment,
  looksLikeEcho,
  normalizeForEcho,
  shingles,
} from './memory-echo.ts';

describe('屏幕复读检测（m24648）', () => {
  test('normalizeForEcho 去标点空白、统一小写', () => {
    assert.equal(normalizeForEcho('呜哇，验收 不许 冒气泡！'), '呜哇验收不许冒气泡');
    assert.equal(normalizeForEcho('ABC-def_1'), 'abcdef1');
  });

  test('shingles 短句也能出一片', () => {
    assert.deepEqual([...shingles('气泡')], ['气泡']);
    assert.equal(shingles('').size, 0);
    assert.equal(shingles('验收不许冒气泡').size, 5);
  });

  test('containment：照抄很高，自由发挥很低', () => {
    const note = '他在看「身体陪玩模式」笔记，里面验收要求跑动无横纹、按说话时右边只挂【在想】。';
    assert.ok(containment('里面验收要求跑动无横纹、按说话时右边只挂在想', note) > 0.9, '整段照抄要接近 1');
    assert.ok(containment('今晚月亮好圆，本鱼想吃白饭', note) < 0.1, '无关的话要接近 0');
  });

  test('looksLikeEcho：成段照抄才算，短句和正常点评都不算', () => {
    const notes = ['他在看「身体陪玩模式」笔记，里面验收要求跑动无横纹、按说话时右边只挂【在想】。'];
    // 照抄
    assert.equal(looksLikeEcho('里面验收要求跑动无横纹、按说话时右边只挂在想，本鱼看见了。', notes), true);
    // 正常点评（今天真实数据里 containment 0.67 那种）
    assert.equal(looksLikeEcho('lib 里确实没有 client.js，装完能跑起来吗？', notes), false);
    // 短句不判
    assert.equal(looksLikeEcho('好呀', notes), false);
    // 没笔记
    assert.equal(looksLikeEcho('里面验收要求跑动无横纹、按说话时右边只挂在想', []), false);
  });

  test('阈值是 0.6（实测口径，别随手改小）', () => {
    assert.equal(ECHO_THRESHOLD, 0.6);
  });
});