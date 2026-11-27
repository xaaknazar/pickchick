import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { kitchenTicket, modifierKind, stopwatch } from '../dist/kitchen-ticket.js';

const PREP = '00000000-0000-4000-8000-000000000001';
const ASM = '00000000-0000-4000-8000-000000000002';
const mod = (groupId, group, label, quantity = 1) => ({
  groupId,
  groupTitle: { ru: group, kk: '' },
  optionId: label,
  label: { ru: label, kk: '' },
  quantity,
  linkedProductId: null,
});
const task = (stationId, title, extra = {}) => ({
  taskId: randomUUID(),
  stationId,
  version: 1,
  state: 'queued',
  kind: stationId === PREP ? 'prep' : 'assembly_item',
  details: {
    lineId: randomUUID(),
    productId: title,
    title,
    parentTitle: title,
    description: '4 сочных куриных фингерса в золотистой хрустящей панировке',
    quantity: 1,
    modifiers: [],
    ...extra,
  },
});
const order = (tasks, extra = {}) => ({
  orderId: randomUUID(),
  branchId: randomUUID(),
  version: 3,
  state: 'accepted',
  displayNumber: '27',
  routingVersion: 1,
  createdAt: '2026-11-22T10:00:00.000Z',
  updatedAt: '2026-11-22T10:00:00.000Z',
  assemblyStationId: ASM,
  channel: 'kiosk',
  serviceMode: 'takeaway',
  tasks,
  ...extra,
});
const render = (o, stationId, now = Date.parse('2026-11-22T10:04:35Z'), actions = []) =>
  kitchenTicket({
    order: o,
    stationId,
    stations: [],
    actions,
    blocked: false,
    now,
    wholeTicket: true,
    actionLabel: { complete_station: 'Готово - на сборку', handoff: 'Подтвердить выдачу' },
    stateLabel: (s) => s,
  });

test('stopwatch runs in m:ss and h:mm:ss', () => {
  const t0 = '2026-11-22T10:00:00.000Z';
  assert.equal(stopwatch(t0, Date.parse(t0)), '0:00');
  assert.equal(stopwatch(t0, Date.parse(t0) + 7000), '0:07');
  assert.equal(stopwatch(t0, Date.parse(t0) + 275000), '4:35');
  assert.equal(stopwatch(t0, Date.parse(t0) + 3729000), '1:02:09');
  assert.equal(stopwatch(t0, Date.parse(t0) - 5000), '0:00');
  assert.equal(stopwatch('nope', 0), '-');
});

test('drinks and sauces are assembly modifiers by slug (cloud) and by title (cashier)', () => {
  assert.equal(modifierKind(mod('drink', 'Напиток на выбор', 'Coca-Cola')), 'drink');
  assert.equal(modifierKind(mod('drink-extra', 'Добавить напитки', 'Sprite')), 'drink');
  assert.equal(modifierKind(mod('iced-tea-sweetness', 'Сладость', 'Сладкий')), 'drink');
  assert.equal(modifierKind(mod('a1b2c3', 'Напиток на выбор', 'Coca-Cola')), 'drink');
  assert.equal(modifierKind(mod('sauce-paid-hot', 'Острый соус платно', 'x')), 'sauce');
  assert.equal(modifierKind(mod('d4e5f6', 'Соус на выбор', 'Фирменный')), 'sauce');
  assert.equal(modifierKind(mod('taste', 'Вкус', 'Острый')), 'cook');
});

// Restaurant TZ 27.11 «Отображение заказов», example: order 10, in the hall, kiosk, queued.
const tzOrder = () => {
  const meal = task(PREP, 'Chick N Roll Meal', {
    productId: 'chick-n-roll-meal-combo',
    modifiers: [
      mod('drink', 'Напиток на выбор', 'Sprite 0.5 л'),
      mod('sauce', 'Соус на выбор', 'Heinz сырный'),
    ],
  });
  const finger = task(PREP, 'Finger Combo', {
    productId: 'pick-combo',
    modifiers: [
      mod('drink', 'Напиток на выбор', 'Fuse Tea Манго-Ромашка 0.5 л'),
      mod('sauce', 'Соус на выбор', 'Острый соус Pick Chick'),
    ],
  });
  return order([meal, finger], { displayNumber: '10', serviceMode: 'dine_in' });
};
const at17 = Date.parse('2026-11-22T10:17:00Z');

test('TZ 27.11 kitchen: number, type, source, status, timer; dish and quantity only', () => {
  const html = render(tzOrder(), PREP, at17);
  assert.match(html, /class="number">10</);
  assert.match(html, /В ЗАЛЕ/);
  assert.match(html, /Киоск · <span class="order-status">accepted<\/span>/);
  assert.match(html, /data-since="2026-11-22T10:00:00.000Z"[^>]*>17:00</);
  assert.match(html, /1×<\/span><div class="line-info"><h3>Chick N Roll Meal<\/h3>/);
  assert.match(html, /1×<\/span><div class="line-info"><h3>Finger Combo<\/h3>/);
  for (const hidden of [
    'Sprite',
    'Heinz',
    'Fuse Tea',
    'Острый соус',
    'Напиток на выбор',
    'Фингерсы',
    'Фри',
    'Тост',
    'сочных',
  ])
    assert.doesNotMatch(html, new RegExp(hidden), hidden);
});

test('TZ 27.11 kitchen: other modifiers are not shown either', () => {
  const html = render(
    order([
      task(PREP, 'Pick Burger', {
        modifiers: [mod('x1', 'Изменения', 'Без лука'), mod('taste', 'Вкус', 'Острый')],
      }),
    ]),
    PREP,
  );
  assert.match(html, /Pick Burger/);
  assert.doesNotMatch(html, /Без лука|Острый/);
});

test('TZ 27.11 assembly: dish, quantity, each modifier on its own line without group titles', () => {
  const html = render(tzOrder(), ASM, at17);
  assert.match(html, /class="number">10</);
  assert.match(html, /В ЗАЛЕ/);
  assert.match(html, /Киоск · <span class="order-status">accepted<\/span>/);
  assert.match(
    html,
    /<h3>Chick N Roll Meal<\/h3><ul class="line-mods"><li class="mod-drink">– Sprite 0.5 л<\/li><li class="mod-sauce">– Heinz сырный<\/li><\/ul>/,
  );
  assert.match(
    html,
    /<h3>Finger Combo<\/h3><ul class="line-mods"><li class="mod-drink">– Fuse Tea Манго-Ромашка 0.5 л<\/li><li class="mod-sauce">– Острый соус Pick Chick<\/li><\/ul>/,
  );
  assert.ok(html.indexOf('Chick N Roll Meal') < html.indexOf('Finger Combo'), 'order of the order');
  for (const hidden of ['Напиток на выбор', 'Соус на выбор', 'Фингерсы', 'Фри', 'Тост', 'сочных'])
    assert.doesNotMatch(html, new RegExp(hidden), hidden);
});

test('assembly: kitchen readiness per line, items made here with their button, quantity', () => {
  const combo = task(PREP, 'Finger Combo', {
    quantity: 2,
    modifiers: [mod('drink', 'Напиток на выбор', 'Coca-Cola 0.5 л', 2)],
  });
  combo.state = 'done';
  const sauce = task(ASM, 'Сырный соус 60 г');
  const o = order([combo, sauce]);
  const html = render(o, ASM, Date.parse('2026-11-22T10:13:00Z'), [
    { action: 'complete_station', expectedVersion: 3, stationId: ASM },
  ]);
  assert.match(html, /2×<\/span><div class="line-info"><h3>Finger Combo/);
  assert.match(html, /– Coca-Cola 0.5 л ×2/);
  assert.match(html, /line-state done">✓/);
  assert.match(html, /Сырный соус 60 г/);
  assert.match(html, /Заказ собран/);
  assert.match(html, /wait-late/);
});

test('a ready order keeps its timer but loses the wait colour', () => {
  const o = order([task(ASM, 'Sprite')], { state: 'ready' });
  const html = render(o, ASM, Date.parse('2026-11-22T10:30:00Z'));
  assert.match(html, /data-still=""/);
  assert.doesNotMatch(html, /wait-late/);
  assert.match(html, /order-status">ready</);
});

test('all day: items counted by their own name, combos not decoded, drinks left out', async () => {
  const { allDay, allDayStrip } = await import('../dist/kitchen-ticket.js');
  const a = order([
    task(PREP, 'Finger Combo', { productId: 'pick-combo', quantity: 2 }),
    task(ASM, 'Sprite 0.5 л'),
  ]);
  const b = order([task(PREP, 'Finger Combo'), task(PREP, 'Pick Burger')]);
  const done = task(PREP, 'Master Combo');
  done.state = 'done';
  const ready = order([task(PREP, 'Solo Combo')], { state: 'ready' });
  assert.deepEqual(allDay([a, b, order([done]), ready], PREP), [
    { name: 'Finger Combo', count: 3 },
    { name: 'Pick Burger', count: 1 },
  ]);
  assert.match(allDayStrip([a], PREP), /Всего в работе.*<strong>2<\/strong> Finger Combo/);
  assert.match(allDayStrip([], PREP), /ничего/);
});

test('expanded combo from the back office stays one line under the combo, drink once', async () => {
  const { allDay } = await import('../dist/kitchen-ticket.js');
  const lineId = randomUUID();
  const drink = mod('drink', 'Напиток на выбор', 'Sprite 0.5 л');
  const part = (title, quantity, productId) =>
    task(PREP, title, {
      lineId,
      productId,
      parentTitle: 'Finger Combo',
      quantity,
      lineQuantity: 2,
      weightG: 30,
      modifiers: [drink],
    });
  const o = order([part('Фингерс 1 шт', 8, 'fingers'), part('Тост 1 шт', 2, 'toast')]);
  const cook = render(o, PREP, at17, [
    {
      action: 'start_task',
      expectedVersion: 3,
      taskId: o.tasks[0].taskId,
      expectedTaskVersion: 1,
    },
  ]);
  assert.match(cook, /2×<\/span><div class="line-info"><h3>Finger Combo<\/h3>/);
  assert.equal(cook.match(/<h3>/g).length, 1);
  assert.doesNotMatch(cook, /30 г|Sprite/);
  const asm = render(o, ASM, at17);
  assert.equal(asm.match(/– Sprite 0.5 л/g).length, 1);
  assert.deepEqual(allDay([o], PREP), [{ name: 'Finger Combo', count: 2 }]);
});

test('new orders: no ring on first load or right after opening a screen, then once per order', async () => {
  const { NewOrders, NEW_TICKET_MS } = await import('../dist/kitchen-ticket.js');
  const n = new NewOrders();
  n.enter('kitchen:p', 0);
  assert.equal(n.update('kitchen:p', ['a', 'b'], 1000), false);
  assert.equal(n.update('kitchen:p', ['a', 'b'], 5000), false);
  assert.equal(n.update('kitchen:p', ['a', 'b', 'c'], 6000), true);
  assert.equal(n.isNew('kitchen:p', 'c', 6000 + NEW_TICKET_MS - 1), true);
  assert.equal(n.isNew('kitchen:p', 'c', 6000 + NEW_TICKET_MS), false);
  assert.equal(n.isNew('kitchen:p', 'a', 6000), false);
  assert.equal(n.update('kitchen:p', ['b', 'c'], 7000), false);
});
