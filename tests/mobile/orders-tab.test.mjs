import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  activeOrderCount,
  activeSectionTitle,
  almatyClock,
  almatyDayKey,
  commerceActiveKind,
  countdownLabel,
  groupByAlmatyDay,
  historyDayLabel,
  historyMetaParts,
  itemsSummary,
  latestUnratedOrderId,
  photoTileLayout,
  progressStage,
  sortActive,
  testActiveKind,
} from '../../apps/mobile/src/orders-tab.ts';

const read = (path) =>
  readFileSync(new URL(`../../apps/mobile/src/${path}`, import.meta.url), 'utf8');

// 2026-10-12 12:00 in Almaty (UTC+5).
const NOW = Date.parse('2026-10-12T07:00:00Z');

test('days and clock follow the Almaty calendar, not the device or UTC day', () => {
  assert.equal(almatyDayKey('2026-10-11T19:30:00Z'), '2026-10-12', '00:30 next day in Almaty');
  assert.equal(almatyDayKey('2026-10-11T18:59:00Z'), '2026-10-11');
  assert.equal(almatyClock('2026-10-12T07:32:00Z'), '12:32');
  assert.equal(almatyClock('2026-10-11T19:05:00Z'), '00:05');
  assert.equal(almatyDayKey('not a date'), null);
  assert.equal(almatyClock('not a date'), '');
});

test('day labels: today, yesterday, then a genitive date with a foreign year', () => {
  assert.equal(historyDayLabel('2026-10-12', NOW), 'Сегодня');
  assert.equal(historyDayLabel('2026-10-11', NOW), 'Вчера');
  assert.equal(historyDayLabel('2026-10-02', NOW), '2 октября');
  assert.equal(historyDayLabel('2026-01-31', NOW), '31 января');
  assert.equal(historyDayLabel('2025-12-31', NOW), '31 декабря 2025');
  // Just after midnight in Almaty the previous UTC day is already «Вчера».
  const night = Date.parse('2026-10-11T19:10:00Z');
  assert.equal(historyDayLabel('2026-10-12', night), 'Сегодня');
  assert.equal(historyDayLabel('2026-10-11', night), 'Вчера');
  // Month and year boundaries.
  assert.equal(historyDayLabel('2026-02-28', Date.parse('2026-03-01T06:00:00Z')), 'Вчера');
  assert.equal(historyDayLabel('2025-12-31', Date.parse('2026-01-01T06:00:00Z')), 'Вчера');
});

test('history groups keep the sorted order and one block per Almaty day', () => {
  const orders = [
    { id: 'a', createdAt: '2026-10-12T07:32:00Z' },
    { id: 'b', createdAt: '2026-10-11T19:30:00Z' }, // 00:30 on the 12th in Almaty
    { id: 'c', createdAt: '2026-10-11T14:05:00Z' },
    { id: 'd', createdAt: '2026-10-11T08:40:00Z' },
    { id: 'e', createdAt: '2026-10-02T06:02:00Z' },
  ];
  const groups = groupByAlmatyDay(orders, (order) => order.createdAt, NOW);
  assert.deepEqual(
    groups.map((group) => [group.label, group.items.map((order) => order.id)]),
    [
      ['Сегодня', ['a', 'b']],
      ['Вчера', ['c', 'd']],
      ['2 октября', ['e']],
    ],
  );
  assert.deepEqual(
    groupByAlmatyDay([], (order) => order.createdAt, NOW),
    [],
  );
});

test('photo tile: full, halves, 2×2 with empty cells, then three photos and +N', () => {
  assert.deepEqual(photoTileLayout([]), { shape: 'single', cells: [{ kind: 'empty' }] });
  assert.deepEqual(photoTileLayout(['a']), {
    shape: 'single',
    cells: [{ kind: 'photo', productId: 'a', index: 0 }],
  });
  assert.equal(photoTileLayout(['a', 'b']).shape, 'halves');
  assert.equal(photoTileLayout(['a', 'b']).cells.length, 2);
  const three = photoTileLayout(['a', 'b', 'c']);
  assert.equal(three.shape, 'grid');
  assert.deepEqual(
    three.cells.map((cell) => cell.kind),
    ['photo', 'photo', 'photo', 'empty'],
  );
  assert.deepEqual(
    photoTileLayout(['a', 'b', 'c', 'd']).cells.map((cell) => cell.kind),
    ['photo', 'photo', 'photo', 'photo'],
  );
  const five = photoTileLayout(['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(five.cells[3], { kind: 'more', count: 2 });
  assert.deepEqual(
    five.cells.slice(0, 3).map((cell) => cell.productId),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(photoTileLayout(Array.from({ length: 11 }, (_, i) => `p${i}`)).cells[3], {
    kind: 'more',
    count: 8,
  });
});

test('history lines: items joined by comma, piece count for three or more positions', () => {
  const items = [
    { productId: 'master-combo', title: 'Master Combo', quantity: 2 },
    { productId: 'pick-combo', title: 'Pick Combo', quantity: 1 },
    { productId: 'finger-duo', title: 'Фингер Дуо', quantity: 6 },
  ];
  assert.equal(itemsSummary(items), 'Master Combo ×2, Pick Combo, Фингер Дуо ×6');
  const base = { number: '3', createdAt: '2026-10-11T08:40:00Z', serviceMode: 'dine_in' };
  assert.deepEqual(historyMetaParts({ ...base, items }), ['№ 3', '13:40', '9 шт.']);
  assert.deepEqual(historyMetaParts({ ...base, items: items.slice(0, 2) }), [
    '№ 3',
    '13:40',
    'В зале',
  ]);
  assert.deepEqual(
    historyMetaParts({ ...base, number: null, serviceMode: 'takeaway', items: items.slice(0, 1) }),
    ['13:40', 'С собой'],
  );
});

test('only the newest unrated handed-over order asks for stars', () => {
  const candidates = [
    { id: 'old', createdAt: '2026-10-01T10:00:00Z', rateable: true, rated: false },
    { id: 'cancelled', createdAt: '2026-10-12T10:00:00Z', rateable: false, rated: false },
    { id: 'new', createdAt: '2026-10-11T10:00:00Z', rateable: true, rated: false },
    { id: 'rated', createdAt: '2026-10-12T09:00:00Z', rateable: true, rated: true },
  ];
  assert.equal(latestUnratedOrderId(candidates), 'new');
  assert.equal(latestUnratedOrderId(candidates.filter((c) => c.id !== 'new')), 'old');
  assert.equal(latestUnratedOrderId(candidates.filter((c) => c.rated || !c.rateable)), null);
  assert.equal(latestUnratedOrderId([]), null);
});

test('active orders: section title and the tab counter cover everything under «Сейчас»', () => {
  assert.equal(activeSectionTitle(1), 'Сейчас');
  assert.equal(activeSectionTitle(2), 'Сейчас · 2');
  const phases = {
    awaiting_restaurant: 'payment',
    ready_to_pay: 'payment',
    sending: 'payment',
    awaiting_payment: 'payment',
    checking: 'payment',
    paid: 'progress',
    preparing: 'progress',
    ready: 'ready',
    failed: null,
    handed_over: null,
    attention: null,
  };
  for (const [phase, kind] of Object.entries(phases)) assert.equal(commerceActiveKind(phase), kind);
  assert.equal(testActiveKind('awaiting_test_payment'), 'payment');
  assert.equal(testActiveKind('preparing'), 'progress');
  assert.equal(testActiveKind('ready'), 'ready');
  assert.equal(testActiveKind('fulfilled'), null);
  assert.equal(testActiveKind('cancelled'), null);
  const orders = ['preparing', 'ready', 'fulfilled', 'awaiting_test_payment', 'cancelled'];
  assert.equal(
    activeOrderCount(orders, (state) => testActiveKind(state)),
    3,
  );
  assert.equal(activeOrderCount([], testActiveKind), 0);
  const cards = [
    { id: 'pay', kind: 'payment' },
    { id: 'cook', kind: 'progress' },
    { id: 'ready', kind: 'ready' },
    { id: 'cook2', kind: 'progress' },
  ];
  assert.deepEqual(
    sortActive(cards).map((card) => card.id),
    ['ready', 'cook', 'cook2', 'pay'],
  );
  assert.equal(cards[0].id, 'pay', 'input stays untouched');
});

test('stage badge and lit bars follow kitchen facts; countdown is m:ss', () => {
  assert.deepEqual(progressStage('cooking'), { badge: 'Готовим', bars: 1 });
  assert.deepEqual(progressStage('assembly'), { badge: 'Собираем', bars: 2 });
  assert.deepEqual(progressStage('paid'), { badge: 'Оплачен', bars: 0 });
  assert.equal(countdownLabel(252), '4:12');
  assert.equal(countdownLabel(59.9), '0:59');
  assert.equal(countdownLabel(-5), '0:00');
});

test('orders tab copy: plain hyphens, never «Оплатить в Kaspi», no «С чего начать»', () => {
  for (const file of [
    'components/OrdersTab.tsx',
    'components/OrderHistoryCard.tsx',
    'orders-tab.ts',
    'screens/ConnectedOrderScreens.tsx',
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /—/, file);
    assert.doesNotMatch(source, /Оплатить в Kaspi/, file);
    assert.doesNotMatch(source, /С чего начать/, file);
  }
  const tab = read('components/OrdersTab.tsx');
  assert.match(tab, /Фритюр уже горячий/);
  assert.match(tab, /Перейти к оплате/);
  for (const step of ['Выберите и оплатите', 'Следите, как готовим', 'Заберите по номеру'])
    assert.match(tab, new RegExp(step));
});
