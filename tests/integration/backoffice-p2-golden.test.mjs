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

test('the comparison can fail: the stock reports flag changes exactly the reads and the movement', () =>
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
    // Five reads per set gain capabilities.stock_reports (false without stock v2), and where
    // stock v2 runs view=movement gains its turnover after all its bo-ui keys (step 4). Nothing
    // else changes: every other view and command keeps the bo-ui answer.
    const v2 = (set) => set !== 'all off';
    assert.deepEqual(
      differing,
      Object.keys(expected).flatMap((set) =>
        Object.keys(expected[set])
          .filter((name) => name.startsWith('read ') || (v2(set) && name === 'ops stock movement'))
          .map((name) => `${set}: ${name}`),
      ),
    );
    for (const set of Object.keys(expected)) {
      const read = ours[set]['read manager day'].ok;
      assert.equal(Object.keys(read.capabilities).at(-1), 'stock_reports');
      assert.equal(read.capabilities.stock_reports, v2(set), set);
      delete read.capabilities.stock_reports;
      assert.deepStrictEqual(read, expected[set]['read manager day'].ok);
      if (!v2(set)) continue;
      const movement = ours[set]['ops stock movement'].ok;
      assert.deepEqual(Object.keys(movement).slice(-2), ['turnover', 'consumption'], set);
      delete movement.turnover;
      delete movement.consumption;
      assert.deepStrictEqual(movement, expected[set]['ops stock movement'].ok, set);
    }
  }));

test('the comparison can fail: the staff assignment flag changes exactly the reads and its views', () =>
  withSyncDatabases(async (c) => {
    const expected = await golden();
    const ours = await goldenOutputs(
      lane,
      c,
      lane.backofficeP2Options({ backofficeStaffAssignmentEnabled: true }),
    );
    const differing = [];
    for (const set of Object.keys(expected))
      for (const name of Object.keys(expected[set]))
        if (JSON.stringify(ours[set][name]) !== JSON.stringify(expected[set][name]))
          differing.push(`${set}: ${name}`);
    // Step 5: five reads per set gain capabilities.staff_assignment (false without the staff
    // positions), ops/staff-assignments answers (NOT_READY without the positions), and where the
    // manager shift runs with the positions its view gains the check and the closing item. The
    // commands of the golden carry the step 1 proposal bodies (an instant instead of the business
    // day and the time), so they stay unknown commands.
    const full = (set) => set === 'bo-ui flags';
    assert.deepEqual(
      differing,
      Object.keys(expected).flatMap((set) =>
        Object.keys(expected[set])
          .filter(
            (name) =>
              name.startsWith('read ') ||
              name === 'ops staff-assignments' ||
              name === 'ops shift manager staff-assignments' ||
              (full(set) && name === 'ops manager-shifts'),
          )
          .map((name) => `${set}: ${name}`),
      ),
    );
    for (const set of Object.keys(expected)) {
      const read = ours[set]['read manager day'].ok;
      assert.equal(Object.keys(read.capabilities).at(-1), 'staff_assignment');
      assert.equal(read.capabilities.staff_assignment, full(set), set);
      delete read.capabilities.staff_assignment;
      if (full(set)) {
        // With roles on the manager also lists the two rights, after every other one.
        assert.deepEqual(read.permissions.slice(-2), ['staff.assign', 'staff.assign_override']);
        read.permissions.splice(-2);
      }
      assert.deepStrictEqual(read, expected[set]['read manager day'].ok, set);
      for (const view of ['ops staff-assignments', 'ops shift manager staff-assignments'])
        if (full(set))
          assert.equal(ours[set][view].ok.view, 'staff-assignments', `${set}: ${view}`);
        else assert.deepEqual(ours[set][view], { error: { code: 'NOT_READY', reason: null } });
      if (!full(set)) continue;
      const shifts = ours[set]['ops manager-shifts'].ok;
      assert.deepEqual(Object.keys(shifts).slice(-2), ['checks', 'extra_items'], set);
      assert.equal(Object.keys(shifts.checks).at(-1), 'staff_assignment');
      delete shifts.extra_items;
      delete shifts.checks.staff_assignment;
      assert.deepStrictEqual(shifts, expected[set]['ops manager-shifts'].ok, set);
    }
  }));
