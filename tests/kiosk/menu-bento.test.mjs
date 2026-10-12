// Bento menu rule (kiosk redesign 2026-10-13, README section 3): pure layout and hit choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTION_HITS,
  badgeOf,
  bentoGeometry,
  bentoLayout,
  fitTitle,
  sectionHit,
} from '../../apps/kiosk/src/menu-presentation.ts';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';

const cells = (layout) =>
  layout.cards.map(({ item, row, col, rowSpan, colSpan, size }) => [
    item,
    row,
    col,
    rowSpan,
    colSpan,
    size,
  ]);

test('three products: two columns, rows 0.8fr 1.25fr, two tall cards under the hit', () => {
  const layout = bentoLayout(3);
  assert.equal(layout.columns, 2);
  assert.deepEqual(layout.rows, [0.8, 1.25]);
  assert.deepEqual(cells(layout), [
    [0, 1, 0, 1, 1, 'large'],
    [1, 1, 1, 1, 1, 'large'],
  ]);
});

test('four products: a tall card over two rows on the left, two cards on the right', () => {
  const layout = bentoLayout(4);
  assert.equal(layout.columns, 2);
  assert.deepEqual(layout.rows, [1, 1, 1]);
  assert.deepEqual(cells(layout), [
    [0, 1, 0, 2, 1, 'large'],
    [1, 1, 1, 1, 1, 'medium'],
    [2, 2, 1, 1, 1, 'medium'],
  ]);
});

test('five and more: three columns, 0.85fr + 1fr per row, the last card fills its row', () => {
  // Extras (7): two full rows of three, nothing stretches.
  const extras = bentoLayout(7);
  assert.equal(extras.columns, 3);
  assert.deepEqual(extras.rows, [0.85, 1, 1]);
  assert.ok(extras.cards.every((c) => c.size === 'small' && c.colSpan === 1));
  // Drinks (6): the fifth card spans the two free columns and turns horizontal.
  const drinks = bentoLayout(6);
  assert.deepEqual(drinks.rows, [0.85, 1, 1]);
  assert.deepEqual(cells(drinks).at(-1), [4, 2, 1, 1, 2, 'wide']);
  assert.equal(drinks.cards.filter((c) => c.size === 'wide').length, 1);
  // Five: a full row then one card across all three columns.
  assert.deepEqual(cells(bentoLayout(5)).at(-1), [3, 2, 0, 1, 3, 'wide']);
  // The live catalog grows to 19 drinks: ceil(18 / 3) = 6 rows of cards, all full.
  const many = bentoLayout(19);
  assert.deepEqual(many.rows, [0.85, 1, 1, 1, 1, 1, 1]);
  assert.equal(many.cards.length, 18);
  assert.ok(many.cards.every((c) => c.size === 'small'));
  for (let n = 5; n <= 40; n++) {
    const layout = bentoLayout(n);
    assert.equal(layout.cards.length, n - 1, `${n}: every product but the hit has a card`);
    assert.equal(layout.rows.length, 1 + Math.ceil((n - 1) / 3), `${n}: rows`);
    // Every cell of every card row is covered exactly once.
    const covered = new Map();
    for (const c of layout.cards)
      for (let col = c.col; col < c.col + c.colSpan; col++) {
        const key = c.row + ':' + col;
        assert.ok(!covered.has(key), `${n}: ${key} covered twice`);
        covered.set(key, c.item);
      }
    assert.equal(covered.size, (layout.rows.length - 1) * 3, `${n}: no empty cell`);
  }
});

test('one or two products and an empty section stay drawable', () => {
  assert.deepEqual(bentoLayout(0), { columns: 1, rows: [], cards: [] });
  assert.deepEqual(bentoLayout(1).cards, []);
  assert.deepEqual(cells(bentoLayout(2)), [[0, 1, 0, 1, 2, 'wide']]);
});

test('geometry stretches rows by fr and scrolls instead of squeezing a long section', () => {
  // 1024 x 1366 grid area: 806 x 1082, gap 16.
  const extras = bentoGeometry(bentoLayout(7), 806, 1082, 16, 250, 260);
  assert.equal(extras.height, 1082, 'fits exactly: the grid ends above the checkout panel');
  assert.equal(extras.hit.height, Math.round(0.85 * (1050 / 2.85)));
  const [first, second, third] = extras.cards;
  assert.equal(first.width, second.width);
  assert.equal(third.x + third.width, 806);
  assert.equal(second.x, first.width + 16);
  const combo = bentoGeometry(bentoLayout(4), 806, 1082, 16, 250, 260);
  assert.equal(combo.cards[0].height, combo.cards[1].height * 2 + 16, 'tall card spans 2 rows');
  assert.equal(combo.cards[2].y, combo.cards[1].y + combo.cards[1].height + 16);
  const wide = bentoGeometry(bentoLayout(6), 806, 1082, 16, 250, 260).cards.at(-1);
  assert.equal(wide.x + wide.width, 806);
  // 19 drinks: rows keep their minimum height and the section becomes scrollable.
  const drinks = bentoGeometry(bentoLayout(19), 806, 1082, 16, 250, 260);
  assert.ok(drinks.height > 1082);
  assert.ok(drinks.cards.every((c) => c.height >= 250));
  assert.ok(drinks.hit.height >= 260);
  // Three rows of cards (up to ten products) still fit; a longer section scrolls with roomy rows.
  assert.equal(bentoGeometry(bentoLayout(10), 806, 1082, 16, 250, 260, 320).height, 1082);
  const scrolling = bentoGeometry(bentoLayout(19), 806, 1082, 16, 250, 260, 320);
  assert.ok(scrolling.cards.every((c) => c.height === 320));
  assert.equal(scrolling.hit.height, 272, '0.85 of a roomy row');
  // The same rule on the 11-inch and mini iPads (scale 0.8).
  for (const [w, h] of [
    [645, 953],
    [645, 906],
  ]) {
    const g = bentoGeometry(bentoLayout(7), w, h, 13, 200, 208);
    assert.equal(g.height, h, `${w}x${h} fits`);
  }
});

test('hits follow the owner table and fall back while the configured one is stopped', () => {
  const products = testCompleteCatalog.products;
  const section = (category) => products.filter((p) => p.category === category);
  const named = { combo: 'Комбо', duo: 'На двоих', sets: 'На компанию', drinks: 'Напитки' };
  for (const [key, category] of Object.entries(named))
    assert.equal(sectionHit(section(category), key).id, SECTION_HITS[key].productId, key);
  assert.equal(sectionHit(section('Допы'), 'extras').id, 'burger');
  const stopped = section('Напитки').map((p) =>
    p.id === 'lemonade' ? { ...p, available: false } : p,
  );
  assert.equal(sectionHit(stopped, 'drinks').id, 'cola', 'first product still on sale');
  const allStopped = stopped.map((p) => ({ ...p, available: false }));
  assert.equal(sectionHit(allStopped, 'drinks').id, 'lemonade', 'configured hit, shown stopped');
  assert.equal(
    sectionHit(
      section('Напитки').filter((p) => p.id !== 'lemonade'),
      'drinks',
    ).id,
    'cola',
    'configured hit missing from the catalog',
  );
  assert.equal(sectionHit([], 'combo'), null);
});

test('badges come from the presentation config by product id', () => {
  assert.equal(badgeOf('pick-combo'), 'hit');
  assert.equal(badgeOf('solo-combo'), 'new');
  assert.equal(badgeOf('sauce-hot'), 'spicy');
  assert.equal(badgeOf('iced-tea'), 'recipe');
  assert.equal(badgeOf('cola'), undefined);
  assert.equal(badgeOf('toString'), undefined);
});

test('names step down instead of breaking a word or losing a line to an ellipsis', () => {
  // Wide enough: the design size.
  assert.deepEqual(fitTitle('Burger Combo', 360, 27, 22), { size: 27, lines: 2 });
  assert.deepEqual(fitTitle('Pick Combo', 0, 24, 19), { size: 24, lines: 2 });
  // «Картофельные» must not break mid-word in a 144 pt column (mini iPad, 3 columns).
  const potato = fitTitle('Картофельные дольки, 90 г', 144, 19, 15);
  assert.ok(12 * potato.size * 0.74 <= 144, `longest word fits at ${potato.size}`);
  assert.equal(potato.lines, 2);
  // A long name keeps two lines while it can, then gets a third line at the smallest size.
  const lemonade = fitTitle('Фирменный лимонад 0.5 л', 144, 19, 15);
  assert.ok(lemonade.size >= 15 && lemonade.size <= 19);
  assert.ok(lemonade.lines <= 3);
  const long = fitTitle('Fuse Tea Персик 0.5 л без сахара', 144, 19, 15);
  assert.equal(long.size, 15);
  assert.equal(long.lines, 3);
  // A single word wider than the column at the minimum still shrinks to fit.
  assert.ok(fitTitle('Суперфингерсы', 100, 24, 19).size * 13 * 0.74 <= 100);
});
