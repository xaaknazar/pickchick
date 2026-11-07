// Flag-off identity of lane bo-ui2 against the bo-ui result itself (the method of review BOUI-R4).
// fixtures/backoffice-bo-ui-golden.json holds the outputs of the reviewed bo-ui build aff89ce6 on
// a synthetic seed (recorded by fixtures/backoffice-bo-ui-golden.mjs from that build, on the
// bo-ui schema up to 075): read() of four roles, the order cards, every ops view of the cloud
// lane and bo-ui, the views and commands the second wave plans, a strict save and a write, with
// every bo-ui flag off, with the cloud lane flags, and with every bo-ui flag on. With the three
// second-wave flags off this lane must give the same outputs, key order included, on the full
// schema (076) and on the bo-ui schema (075). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withSyncDatabases } from '../helpers/sync.mjs';
import * as lane from '../../packages/backoffice-core/dist/index.js';
import {
  BO_UI_LAST_MIGRATION,
  GOLDEN_FILE,
  goldenOutputs,
  migrationsUpTo,
} from './fixtures/backoffice-bo-ui-golden.mjs';

const golden = async () => JSON.parse(await readFile(GOLDEN_FILE, 'utf8'));
async function sameAsGolden(c) {
  const expected = await golden();
  const ours = await goldenOutputs(lane, c, lane.backofficeP2Options({}));
  for (const set of Object.keys(expected))
    for (const name of Object.keys(expected[set]))
      assert.deepStrictEqual(ours[set]?.[name], expected[set][name], `${set}: ${name}`);
  assert.deepStrictEqual(Object.keys(ours), Object.keys(expected));
  for (const set of Object.keys(expected))
    assert.deepStrictEqual(Object.keys(ours[set]), Object.keys(expected[set]), set);
  // deepStrictEqual ignores key order; the payloads must also be the same bytes.
  assert.equal(JSON.stringify(ours), JSON.stringify(expected));
}

test('every second-wave flag off on the full schema (076): the outputs of the bo-ui build aff89ce6', () =>
  withSyncDatabases(sameAsGolden));

test('every second-wave flag off on the bo-ui schema (075): the same outputs', () =>
  migrationsUpTo(BO_UI_LAST_MIGRATION, (directory) =>
    withSyncDatabases(sameAsGolden, { cloudMigrationDirectory: directory }),
  ));

test('the comparison can fail: a second-wave flag that is on changes exactly the reads', () =>
  withSyncDatabases(async (c) => {
    const expected = await golden();
    const ours = await goldenOutputs(
      lane,
      c,
      lane.backofficeP2Options({ backofficeStockReportsEnabled: true }),
    );
    const differing = [];
    for (const set of Object.keys(expected))
      for (const name of Object.keys(expected[set]))
        if (JSON.stringify(ours[set][name]) !== JSON.stringify(expected[set][name]))
          differing.push(`${set}: ${name}`);
    // Five reads per set gain capabilities.stock_reports; nothing else changes yet (the views of
    // the second wave come with their steps).
    assert.deepEqual(
      differing,
      Object.keys(expected).flatMap((set) =>
        Object.keys(expected[set])
          .filter((name) => name.startsWith('read '))
          .map((name) => `${set}: ${name}`),
      ),
    );
    for (const set of Object.keys(expected)) {
      const read = ours[set]['read manager day'].ok;
      assert.equal(Object.keys(read.capabilities).at(-1), 'stock_reports');
      delete read.capabilities.stock_reports;
      assert.deepStrictEqual(read, expected[set]['read manager day'].ok);
    }
  }));
