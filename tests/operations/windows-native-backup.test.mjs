import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { rehearsalName, dropOwnedRehearsal } from '../../infra/windows/backup-native-edge.mjs';

test('rehearsal names cannot select a live or supplied database', () => {
  assert.match(rehearsalName(randomUUID()), /^pickchick_restore_[a-f0-9]{32}$/);
  for (const value of ['pickchick_edge', "a'; DROP DATABASE postgres;--", '', randomUUID() + 'x']) assert.throws(() => rehearsalName(value));
});
test('cleanup requires the generated database, exact OID, owner and run marker', async () => {
  const name = rehearsalName(randomUUID());
  const marker = 'synthetic-test-marker';
  for (const row of [undefined, { oid: 10, owner: 'other', marker }, { oid: 11, owner: 'pickchick_bootstrap', marker }, { oid: 10, owner: 'pickchick_bootstrap', marker: 'foreign' }]) {
    const calls = [];
    const admin = { query: async (sql) => { calls.push(sql); return { rows: row ? [row] : [] }; } };
    await assert.rejects(dropOwnedRehearsal(admin, name, 10, marker));
    assert.equal(calls.some((sql) => sql.startsWith('DROP DATABASE')), false);
  }
  const calls = [];
  const admin = { query: async (sql) => { calls.push(sql); return { rows: [{ oid: 10, owner: 'pickchick_bootstrap', marker }] }; } };
  await dropOwnedRehearsal(admin, name, 10, marker);
  assert.equal(calls.at(-1), `DROP DATABASE "${name}"`);
  await assert.rejects(dropOwnedRehearsal(admin, 'pickchick_edge', 10, marker));
});
