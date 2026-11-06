// Review BOUI-R4: proof against the cloud lane result itself. backoffice-p1-flags.test.mjs
// compares this lane with every P1 flag off against the same runtime; this test compares it with
// the committed outputs of the cloud lane build 43806cf4 on the same synthetic seed
// (fixtures/backoffice-cloud-lane-golden.json, recorded by fixtures/backoffice-cloud-lane-golden.mjs
// from a build of that commit): read() of the manager and the analyst for a day and a week, the
// POS and app order cards, every ops view, the unknown P1 commands, a strict save and a write.
// With every flag off, and with the cloud lane's roles and sales report on, both must be equal,
// key order included. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withSyncDatabases } from '../helpers/sync.mjs';
import * as lane from '../../packages/backoffice-core/dist/index.js';
import { GOLDEN_FILE, goldenOutputs } from './fixtures/backoffice-cloud-lane-golden.mjs';

test('every P1 flag off: the outputs of the cloud lane build 43806cf4, key order included', () =>
  withSyncDatabases(async (c) => {
    const golden = JSON.parse(await readFile(GOLDEN_FILE, 'utf8'));
    const ours = await goldenOutputs(lane, c, lane.backofficeP1Options({}));
    for (const set of Object.keys(golden))
      for (const name of Object.keys(golden[set]))
        assert.deepStrictEqual(ours[set]?.[name], golden[set][name], `${set}: ${name}`);
    assert.deepStrictEqual(Object.keys(ours), Object.keys(golden));
    // deepStrictEqual ignores key order; the payloads must also be the same bytes.
    assert.equal(JSON.stringify(ours), JSON.stringify(golden));
  }));
