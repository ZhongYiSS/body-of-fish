/**
 * 设置页「模型后端」「表情包抽卡池」的源码守卫。
 *
 * 为什么读源码而不是跑组件：client 侧的设置页是 DSH 的 `__ModuleLoader__` 单文件形态，
 * 组件要注入 `h`/`useState` 才能渲染，没有可直接 import 的纯函数入口；而这几条一旦漏掉，
 * 症状都是「界面看着正常、功能静默不生效」（状态不刷新 / 保存丢池子 / 清空 key），
 * 正是最该钉住、又最难靠人工点出来的那类。断言选取的都是**不可替代的标识**：
 * 接口路径、保存 body 的键、防清空标记，改实现就得同步改测试——这就是它的价值。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('./settings.ts', import.meta.url)), 'utf8');

describe('设置页 · 模型后端', () => {
  test('状态接口（GET /model）与测试接口（POST /model/test）都接上了', () => {
    // 「刷新状态 / 首次加载」读的是归一化后的配置 + 每个能力的就绪状态
    assert.match(src, /\/dsh-pet-7340\/model\?pet=main/);
    // 「测一下」必须真的打到宿主，不能只在本地做形状校验
    assert.match(src, /\/dsh-pet-7340\/model\/test\?pet=main/);
    // 测试请求要带 capability，否则宿主只会 400（提示接上的是"能点但永远失败"的假接口）
    assert.match(src, /capability:\s*cap/);
  });

  test('保存 body 提交 model 段（不是只改本地 state）', () => {
    // 只改本地状态不写盘 = 用户改完点保存，后端配置纹丝不动——这条守卫盯住接进 body
    assert.match(src, /model:\s*modelSectionFor\('save'\)/);
  });

  test('走 apiKeyTouched 机制：没动过不提交 key，清空也不会抹掉磁盘上的 key', () => {
    assert.match(src, /apiKeyTouched/);
    // 编辑 key 的那一刻就要置标记；只在保存时读标记、编辑时不置 = 永远 false = 换 key 永远不生效
    assert.match(src, /apiKeyTouched:\s*true/);
    // 提交条件必须同时要求「动过」且「非空」：只判非空的话，明文回填的 key 会每次都被提交
    assert.match(src, /apiKeyTouched\s*&&[^\n]*apiKey\.trim\(\)\s*!==\s*''/);
  });
});

describe('设置页 · 表情包抽卡池', () => {
  test('保存 body 里含 memePool，且按 memes 原顺序过滤（不按勾选先后）', () => {
    assert.match(src, /memePool:/);
    // 顺序即优先级：写成 [...勾选顺序] 会悄悄改掉用户的优先级配置，所以必须是 memes.filter
    assert.match(src, /memePool:\s*memes\.filter\(/);
  });

  test('抽卡池读的是 memes 的键，预览图走宿主图片路由', () => {
    assert.match(src, /Object\.keys\(mm/);
    assert.match(src, /\/dsh-pet-7340\/pic\/memes\/main\//);
    // 名称可能带空格 / 中文 / #，不编码路由会 404
    assert.match(src, /encodeURIComponent\(name\)/);
  });

  test('图片加载失败要藏起来，不能留破图图标', () => {
    assert.match(src, /onError:/);
    assert.match(src, /style\.display\s*=\s*'none'/);
  });
});

describe('设置页 · 文案', () => {
  test('新卡片的中英文案两份都加了（少一份会显示成 key 本身）', () => {
    // zh 与 en 是同一文件里的两份字典，每份一条 → 至少出现两次
    for (const key of ['modelBackendTitle', 'memePoolTitle', 'modelReady', 'memePoolAll']) {
      const hits = src.match(new RegExp('\\b' + key + ':', 'g'))?.length ?? 0;
      assert.ok(hits >= 2, `${key} 只出现 ${hits} 次，中英双语少了一份`);
    }
  });
});
