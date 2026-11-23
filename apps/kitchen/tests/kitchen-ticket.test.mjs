import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  composition,
  cookModifiers,
  kitchenTicket,
  modifierKind,
  stopwatch,
} from '../dist/kitchen-ticket.js';

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

test('cook ticket: number, dish, live timer; no drinks, sauces or menu description', () => {
  const combo = task(PREP, 'Finger Combo', {
    modifiers: [
      mod('drink', 'Напиток на выбор', 'Coca-Cola 0.5 л'),
      mod('sauce', 'Соус на выбор', 'Фирменный соус'),
      mod('taste', 'Вкус', 'Острый'),
    ],
  });
  const o = order([combo, task(ASM, 'Fuse Tea Персик')]);
  const html = render(o, PREP);
  assert.match(html, /class="number">27</);
  assert.match(html, /Finger Combo/);
  assert.match(html, /Острый/);
  assert.match(html, /data-since="2026-11-22T10:00:00.000Z"[^>]*>4:35</);
  for (const hidden of ['Coca-Cola', 'Фирменный соус', 'Fuse Tea', 'сочных', 'На других'])
    assert.doesNotMatch(html, new RegExp(hidden), hidden);
  assert.equal(cookModifiers(combo).length, 1);
});

test('assembly ticket: whole order with drinks and sauces, quantities multiplied', () => {
  const combo = task(PREP, 'Finger Combo', {
    quantity: 2,
    modifiers: [mod('drink', 'Напиток на выбор', 'Coca-Cola 0.5 л')],
  });
  combo.state = 'done';
  const o = order([combo, task(ASM, 'Сырный соус 60 г')]);
  const html = render(o, ASM, Date.parse('2026-11-22T10:13:00Z'), [
    { action: 'complete_station', expectedVersion: 3, stationId: ASM },
  ]);
  assert.match(html, /С кухни/);
  assert.match(html, /✓ всё готово/);
  assert.match(html, /Finger Combo/);
  assert.match(html, /2×<\/span><div class="line-info"><h3>Coca-Cola 0.5 л/);
  assert.match(html, /Сырный соус 60 г/);
  assert.match(html, /Заказ собран/);
  assert.match(html, /wait-late/);
  assert.doesNotMatch(html, /сочных/);
});

test('a ready order keeps its timer but loses the wait colour', () => {
  const o = order([task(ASM, 'Sprite')], { state: 'ready' });
  const html = render(o, ASM, Date.parse('2026-11-22T10:30:00Z'));
  assert.match(html, /data-still=""/);
  assert.doesNotMatch(html, /wait-late/);
  assert.match(html, /Готов к выдаче/);
});

test('combo contents for the cook: by slug or cashier name, times quantity, no drinks', () => {
  const bySlug = task(PREP, 'Finger Combo', { productId: 'pick-combo', quantity: 2 });
  assert.deepEqual(composition(bySlug), [
    { name: 'Фингерсы', count: 8 },
    { name: 'Фри', count: 2 },
    { name: 'Тост', count: 2 },
    { name: 'Коулслоу', count: 2 },
  ]);
  const cashier = task(PREP, 'Master Combo', { productId: 'a1b2c3d4-hashed' });
  assert.equal(composition(cashier).find((p) => p.name === 'Фингерсы').count, 6);
  assert.deepEqual(composition(task(PREP, 'Pick Burger')), []);
  for (const t of [bySlug, cashier])
    assert.ok(composition(t).every((p) => !/напит|соус/i.test(p.name)));
  const html = render(order([bySlug]), PREP);
  assert.match(html, /<li><strong>8<\/strong> Фингерсы<\/li>/);
  const duo = task(PREP, 'Finger Duo', { productId: 'finger-duo' });
  assert.match(render(order([duo]), PREP), /<strong>1,5<\/strong> Фри/);
});

test('all day: combo contents and single items summed for the station, drinks left out', async () => {
  const { allDay, allDayStrip } = await import('../dist/kitchen-ticket.js');
  const a = order([
    task(PREP, 'Finger Combo', { productId: 'pick-combo', quantity: 2 }),
    task(ASM, 'Sprite 0.5 л'),
  ]);
  const b = order([
    task(PREP, 'Фингерс 1 шт', { productId: 'f0f0-hashed', quantity: 3 }),
    task(PREP, 'Pick Burger'),
    task(PREP, 'Новый ролл'),
  ]);
  const done = task(PREP, 'Master Combo');
  done.state = 'done';
  const c = order([done]);
  const ready = order([task(PREP, 'Solo Combo')], { state: 'ready' });
  assert.deepEqual(allDay([a, b, c, ready], PREP), [
    { name: 'Фингерсы', count: 11 },
    { name: 'Фри', count: 2 },
    { name: 'Тост', count: 2 },
    { name: 'Коулслоу', count: 2 },
    { name: 'Pick Burger', count: 1 },
    { name: 'Новый ролл', count: 1 },
  ]);
  assert.match(allDayStrip([a], PREP), /Всего в работе.*<strong>8<\/strong> Фингерсы/);
  assert.match(allDayStrip([], PREP), /ничего/);
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

test('dish changes are shouted: red for a removal, orange otherwise', () => {
  const html = render(
    order([
      task(PREP, 'Pick Burger', {
        modifiers: [mod('x1', 'Изменения', 'Без лука'), mod('taste', 'Вкус', 'Острый')],
      }),
    ]),
    PREP,
  );
  assert.match(html, /<span class="change change-minus">Без лука<\/span>/);
  assert.match(html, /<span class="change">Острый<\/span>/);
});

test('expanded combo from the back office: parts under the combo, grams, drink once', async () => {
  const { groupTasks, allDay } = await import('../dist/kitchen-ticket.js');
  const lineId = randomUUID();
  const drink = mod('drink', 'Напиток на выбор', 'Coca-Cola 0.5 л');
  const part = (title, productId, quantity, extra = {}) =>
    task(PREP, title, {
      lineId,
      productId,
      parentTitle: 'Finger Combo',
      quantity,
      modifiers: [drink, mod('taste', 'Вкус', 'Острый')],
      ...extra,
    });
  const parts = [
    part('Фингерс 1 шт', 'fingers', 8, { weightG: 30, lineQuantity: 2 }),
    part('Картофельные дольки', 'wedges', 2, { weightG: 150, lineQuantity: 2 }),
    part('Тост 1 шт', 'toast', 2, { lineQuantity: 2 }),
  ];
  const groups = groupTasks(parts);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].quantity, 2);
  const o = order(parts);
  const cook = render(o, PREP);
  assert.match(cook, /2×<\/span><div class="line-info"><h3>Finger Combo<\/h3>/);
  assert.match(cook, /<li><strong>8<\/strong> Фингерсы<small class="grams">30 г<\/small><\/li>/);
  assert.match(cook, /<li><strong>2<\/strong> Фри<small class="grams">150 г<\/small><\/li>/);
  assert.match(cook, /<li><strong>2<\/strong> Тост<\/li>/);
  assert.equal(cook.match(/Острый/g).length, 1);
  assert.doesNotMatch(cook, /Coca-Cola|Фингерс 1 шт/);
  const asm = render(o, ASM);
  assert.equal(asm.match(/Coca-Cola/g).length, 1);
  assert.match(asm, /2×<\/span><div class="line-info"><h3>Coca-Cola 0.5 л/);
  assert.deepEqual(allDay([o], PREP).slice(0, 3), [
    { name: 'Фингерсы', count: 8 },
    { name: 'Фри', count: 2 },
    { name: 'Тост', count: 2 },
  ]);
  // An older edge sends no lineQuantity: the common factor of the parts.
  const old = parts.map((t) => ({ ...t, details: { ...t.details, lineQuantity: undefined } }));
  assert.equal(groupTasks(old)[0].quantity, 2);
});
