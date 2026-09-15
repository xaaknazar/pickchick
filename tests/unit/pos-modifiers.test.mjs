import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MenuSnapshotSchema, QuoteSchema } from '@pickchick/contracts';
import { hashJson } from '@pickchick/menu-sync';
import { priceCart } from '@pickchick/local-orders';
import { fixtureMenu } from '@pickchick/test-fixtures';

const groupId = randomUUID(),
  optionA = randomUUID(),
  optionB = randomUUID();
const group = {
  id: groupId,
  name: { ru: 'Добавки', kk: 'Қоспалар' },
  min_selected: 1,
  max_selected: 3,
  options: [
    {
      id: optionA,
      name: { ru: 'Сыр', kk: 'Ірімшік' },
      price_minor: '100',
      max_quantity: 3,
      default_quantity: 1,
    },
    { id: optionB, name: { ru: 'Соус', kk: 'Тұздық' }, price_minor: '250', available: false },
  ],
};
const menu = {
  ...fixtureMenu,
  items: [{ ...fixtureMenu.items[0], price_minor: '9007199254740993', modifier_groups: [group] }],
};
const selection = (quantity = 1) => ({ group_id: groupId, option_id: optionA, quantity });
const cart = (modifiers = [selection(2)]) => ({
  release_id: menu.release_id,
  service_mode: 'takeaway',
  items: [{ variant_id: menu.items[0].variant_id, quantity: 2, modifiers }],
});

test('legacy menu and quote parsing adds no fields or checksum changes', () => {
  assert.deepEqual(MenuSnapshotSchema.parse(fixtureMenu), fixtureMenu);
  assert.equal(hashJson(MenuSnapshotSchema.parse(fixtureMenu)), hashJson(fixtureMenu));
  const old = {
    ...priceCart(fixtureMenu, {
      release_id: fixtureMenu.release_id,
      service_mode: 'takeaway',
      items: [{ variant_id: fixtureMenu.items[0].variant_id, quantity: 1 }],
    }),
    quote_id: randomUUID(),
    branch_id: fixtureMenu.branch_id,
    release_id: fixtureMenu.release_id,
    menu_version: 1,
    service_mode: 'takeaway',
    channel: 'pos',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300000).toISOString(),
  };
  assert.deepEqual(QuoteSchema.parse(old), old);
  assert.equal('modifiers' in old.lines[0], false);
});

test('quantities and modifier prices use exact bigint arithmetic and server names', () => {
  const result = priceCart(menu, cart());
  assert.equal(result.lines[0].unit_price_minor, '9007199254741193');
  assert.equal(result.total_minor, '18014398509482386');
  assert.deepEqual(result.lines[0].modifiers, [
    { ...selection(2), group_name: group.name, name: group.options[0].name, price_minor: '100' },
  ]);
});

test('min/max uses summed quantities and server rejects unknown/unavailable/duplicate/tampered options', () => {
  for (const modifiers of [
    [],
    [selection(4)],
    [selection(), selection()],
    [{ ...selection(), option_id: optionB }],
    [{ ...selection(), group_id: randomUUID() }],
    [{ ...selection(), option_id: randomUUID() }],
    [{ ...selection(), quantity: 0 }],
    [{ ...selection(), quantity: 1.5 }],
    [{ ...selection(), price_minor: '0' }],
  ])
    assert.throws(() => priceCart(menu, cart(modifiers)), undefined, JSON.stringify(modifiers));
  const limited = {
    ...menu,
    items: [{ ...menu.items[0], modifier_groups: [{ ...group, max_selected: 1 }] }],
  };
  assert.throws(() => priceCart(limited, cart([selection(2)])));
});

test('same variant different quantities/selections is distinct; omitted quantity equals one', () => {
  const input = cart([selection()]);
  input.items.push({ ...input.items[0], modifiers: [selection(2)] });
  assert.equal(priceCart(menu, input).lines.length, 2);
  input.items[1].modifiers = [{ group_id: groupId, option_id: optionA }];
  assert.throws(() => priceCart(menu, input));
});

test('catalog duplicate IDs, invalid defaults, fractional price and overflowing modifier totals fail', () => {
  for (const changed of [
    { ...group, options: [...group.options, group.options[0]] },
    { ...group, min_selected: 4 },
    { ...group, options: [{ ...group.options[0], default_quantity: 4 }] },
    { ...group, options: [{ ...group.options[0], available: false }] },
    { ...group, options: [{ ...group.options[0], price_minor: '1.5' }] },
  ])
    assert.equal(
      MenuSnapshotSchema.safeParse({
        ...menu,
        items: [{ ...menu.items[0], modifier_groups: [changed] }],
      }).success,
      false,
    );
  assert.throws(() =>
    priceCart(
      { ...menu, items: [{ ...menu.items[0], price_minor: '9223372036854775807' }] },
      cart(),
    ),
  );
});

test('oversized modifier snapshots fail before they can create an undeliverable order event', () => {
  const name = { ru: 'Ж'.repeat(300), kk: 'Қ'.repeat(300) };
  const largeGroup = {
    id: randomUUID(),
    name,
    min_selected: 20,
    max_selected: 20,
    options: Array.from({ length: 20 }, () => ({ id: randomUUID(), name, price_minor: '0' })),
  };
  const items = [1, 2].map(() => ({
    ...fixtureMenu.items[0],
    variant_id: randomUUID(),
    name,
    modifier_groups: [largeGroup],
  }));
  const input = {
    release_id: fixtureMenu.release_id,
    service_mode: 'takeaway',
    items: items.map((item) => ({
      variant_id: item.variant_id,
      quantity: 1,
      modifiers: largeGroup.options.map((option) => ({
        group_id: largeGroup.id,
        option_id: option.id,
      })),
    })),
  };
  assert.throws(
    () => priceCart({ ...fixtureMenu, items }, input),
    (error) => error.code === 'INVALID_REQUEST',
  );
});
