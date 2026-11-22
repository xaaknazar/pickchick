import test from 'node:test';
import assert from 'node:assert/strict';
import { cookModifiers, kitchenTicket, modifierKind, stopwatch } from '../dist/kitchen-ticket.js';

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
  taskId: crypto.randomUUID(),
  stationId,
  version: 1,
  state: 'queued',
  kind: stationId === PREP ? 'prep' : 'assembly_item',
  details: {
    lineId: crypto.randomUUID(),
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
  orderId: crypto.randomUUID(),
  branchId: crypto.randomUUID(),
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
