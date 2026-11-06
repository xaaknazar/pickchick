// Cutover lane kds (contracts section 2.3): the six KDS stations and their deterministic ids.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { KDS_FUNCTION_KIND, KdsFunctionSchema, UuidSchema } from '@pickchick/contracts';
import { localCatalogId } from '@pickchick/menu-sync';
import { KDS_STATIONS, kdsStationId } from '../dist/index.js';

test('kdsStationId is localCatalogId(branchId, "kds-station", fn), stable and per branch', () => {
  for (const branch of ['10000000-0000-4000-8000-000000000003', randomUUID()])
    for (const fn of KdsFunctionSchema.options) {
      const id = kdsStationId(branch, fn);
      assert.equal(id, localCatalogId(branch, 'kds-station', fn));
      assert.equal(id, kdsStationId(branch, fn));
      assert.ok(UuidSchema.safeParse(id).success, id);
    }
  // Pinned value: a change would orphan the installed stations, grants and layouts.
  assert.equal(
    kdsStationId('10000000-0000-4000-8000-000000000003', 'issue'),
    'ad396eda-4a39-8357-a2ab-f2c8ba9b405d',
  );
  const branch = randomUUID();
  const ids = KdsFunctionSchema.options.map((fn) => kdsStationId(branch, fn));
  assert.equal(new Set(ids).size, ids.length);
  assert.notEqual(kdsStationId(randomUUID(), 'issue'), kdsStationId(branch, 'issue'));
  for (const bad of [
    ['not-a-uuid', 'issue'],
    [branch, 'assembly_burgers'],
    [branch, 'Issue'],
  ])
    assert.throws(() => kdsStationId(...bad), { code: 'INVALID' });
});

test('station table matches contracts section 2.3', () => {
  assert.deepEqual(
    KDS_STATIONS.map((s) => s.function),
    ['breading', 'toasts', 'assembly_hall', 'assembly_delivery', 'issue', 'delivery_handover'],
  );
  assert.deepEqual(
    [...KdsFunctionSchema.options].sort(),
    KDS_STATIONS.map((s) => s.function).sort(),
  );
  for (const station of KDS_STATIONS) {
    assert.equal(station.kind, KDS_FUNCTION_KIND[station.function]);
    assert.ok(station.name.length >= 1 && station.name.length <= 100);
    // UI rule: plain hyphen only.
    assert.doesNotMatch(station.name, /[\u2012-\u2015\u2212]/);
  }
  assert.deepEqual(
    KDS_STATIONS.map((s) => s.name),
    [
      'Панировка (6)',
      'Тосты и бургеры (5)',
      'Сборка - зал (стол 1)',
      'Сборка - доставка (стол 2)',
      'Выдача (2)',
      'Выдача доставки (3)',
    ],
  );
  assert.ok(Object.isFrozen(KDS_STATIONS) && KDS_STATIONS.every(Object.isFrozen));
});
