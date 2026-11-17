import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_MAX,
  CARD_TEXT_MAX,
  decayCards,
  makeCard,
  normalizeCardText,
  overlapScore,
  parseRemember,
  pickCards,
  splitOverflow,
  touchCards,
} from './cards';

describe('长期卡片', () => {
  it('只认「记住：…」，且截到 60 字', () => {
    assert.equal(parseRemember('记住：他喜欢白饭'), '他喜欢白饭');
    assert.equal(parseRemember('  记得:  周五要交稿 '), '周五要交稿');
    assert.equal(parseRemember('他喜欢白饭'), undefined);
    assert.equal(parseRemember('记住：'), undefined);
    assert.equal(normalizeCardText('a'.repeat(100)).length, CARD_TEXT_MAX);
  });

  it('挑卡片：和这句话重合的优先，其次权重，再其次最近用过', () => {
    const now = 1_000_000;
    const a = { ...makeCard({ text: '他在写身体插件', by: 'pet', at: now, id: 'a' })!, weight: 2 };
    const b = { ...makeCard({ text: '他喜欢白饭', by: 'pet', at: now, id: 'b' })!, weight: 5 };
    const picked = pickCards([b, a], '身体的插件今天又炸了', 1);
    assert.equal(picked[0]?.id, 'a');
    assert.ok(overlapScore('身体的插件', a) > 0);
  });

  it('注入之后权重 +1（封顶 5）、记 lastUsedAt', () => {
    const card = { ...makeCard({ text: '白饭', by: 'user', at: 1, id: 'x' })!, weight: 5 };
    const [touched] = touchCards([card], [card], 2_000);
    assert.equal(touched?.weight, 5);
    assert.equal(touched?.lastUsedAt, 2_000);
  });

  it('30 天没用掉一点，但不低于 1', () => {
    const old = { ...makeCard({ text: '旧事', by: 'pet', at: 1, id: 'o' })!, weight: 3, lastUsedAt: 1 };
    const [decayed] = decayCards([old], 31 * 24 * 60 * 60 * 1_000);
    assert.equal(decayed?.weight, 2);
    const floor = decayCards([{ ...old, weight: 1 }], 31 * 24 * 60 * 60 * 1_000);
    assert.equal(floor[0]?.weight, 1);
  });

  it('超 400 张：把最不重要的挑出来归档，顺序不乱', () => {
    const now = 5_000;
    const cards = Array.from({ length: CARD_MAX + 2 }, (_, index) => ({
      ...makeCard({ text: `第${index}条`, by: 'pet', at: now, id: `c${index}` })!,
      weight: index === 0 || index === 1 ? 1 : 3,
      lastUsedAt: index === 0 || index === 1 ? 1 : now,
    }));
    const { keep, archive } = splitOverflow(cards, CARD_MAX);
    assert.equal(keep.length, CARD_MAX);
    assert.deepEqual(archive.map((card) => card.id).sort(), ['c0', 'c1']);
  });
});
