import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stockQuantity,
  stockMoney,
  stockPreview,
  stockFilter,
  inventoryCsv,
} from '../../apps/backoffice/dist/inventory-model.js';
const row = (id, q = '1000', v = '10000', unit = 'g') => ({
  id,
  quantity: q,
  value_minor: v,
  revision: 3,
  payload: { name: 'Сыр ' + id, unit, minimum: '2000', active: true },
});
test('exact mass/volume conversion refuses silent rounding and cross-dimensional conversion', () => {
  assert.equal(stockQuantity('1,234', 'kg', 'g'), '1234');
  assert.equal(stockQuantity('0.001', 'l', 'ml'), '1');
  assert.equal(stockMoney('12,05'), '1205');
  for (const [v, u, b] of [
    ['1.0001', 'kg', 'g'],
    ['1.1', 'pcs', 'pcs'],
    ['2', 'l', 'g'],
    ['', 'g', 'g'],
    ['-2', 'g', 'g'],
    ['1e3', 'g', 'g'],
  ])
    assert.throws(() => stockQuantity(v, u, b));
});
test('count preview distinguishes blank from zero; preserves exact full depletion cost and revisions', () => {
  const b = row('a', '3000', '10000');
  const l = { ingredient_id: 'a', quantity: '0', unit: 'kg', cost: '' };
  const [p] = stockPreview('count', [l], [b]);
  assert.equal(p.delta, '-3000');
  assert.equal(p.value_delta, '-10000');
  assert.equal(p.command.expected_revision, 3);
  assert.throws(() => stockPreview('count', [{ ...l, quantity: '' }], [b]));
});
test('first counted stock requires explicit valuation, duplicates and insufficient stock cannot be posted', () => {
  const b = row('a', '0', '0'),
    l = { ingredient_id: 'a', quantity: '1.5', unit: 'kg', cost: '' };
  assert.throws(() => stockPreview('count', [l], [b]));
  assert.equal(stockPreview('count', [{ ...l, cost: '1500' }], [b])[0].value_delta, '150000');
  assert.throws(() =>
    stockPreview(
      'receipt',
      [
        { ...l, cost: '1' },
        { ...l, cost: '1' },
      ],
      [b],
    ),
  );
  assert.throws(() => stockPreview('waste', [l], [b]));
});
test('low stock filters use active items and CSV protects formula-like product names', () => {
  const all = [row('a'), { ...row('b'), payload: { ...row('b').payload, active: false } }];
  assert.equal(stockFilter(all, 'сыр', 'low').length, 1);
  assert.equal(stockFilter(all, '', 'all').length, 2);
  assert.match(inventoryCsv([['=1+1', 'Обычное']]), /"'=1\+1"/);
});

test('document drilldown retains original movement after later stock changes', async () => {
  const { withCatalog } = await import('./helpers.mjs');
  const { randomUUID } = await import('node:crypto');
  await withCatalog(async (c) => {
    const id = randomUUID();
    const command = (command) =>
      c.backoffice.command(c.manager.token, c.branch, {
        request_id: randomUUID(),
        reason: 'Synthetic inventory check',
        command,
      });
    await command({
      type: 'save',
      kind: 'ingredient',
      id,
      expected_revision: 0,
      payload: { name: 'Synthetic flour', unit: 'g', minimum: '1000', active: true },
    });
    const start = await c.backoffice.read(c.manager.token, c.branch);
    const revision = Number(start.stock.find((v) => v.id === id).revision);
    const receipt = await command({
      type: 'stock',
      kind: 'receipt',
      reference: 'SYN-1',
      lines: [
        { ingredient_id: id, quantity: '2000', value_minor: '100000', expected_revision: revision },
      ],
    });
    await command({
      type: 'stock',
      kind: 'waste',
      reference: 'SYN-2',
      lines: [
        { ingredient_id: id, quantity: '500', value_minor: '0', expected_revision: revision + 1 },
      ],
    });
    const result = await c.backoffice.read(c.manager.token, c.branch);
    const doc = result.documents.find((d) => d.id === receipt.id);
    assert.equal(doc.actor_id, c.manager.actor_id);
    assert.equal(doc.lines[0].quantity_delta, '2000');
    assert.equal(doc.lines[0].balance_after, '2000');
    assert.equal(doc.lines[0].value_delta_minor, '100000');
    assert.equal(result.stock.find((v) => v.id === id).quantity, '1500');
    assert.equal(doc.lines[0].unit, 'g');
    assert.ok(doc.actor_name);
  });
});
