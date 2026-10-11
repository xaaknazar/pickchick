import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cloudChannelOrderGrants,
  cloudKitchenScreenGrants,
} from '../../infra/staging/cloud-kitchen-screen-grants.mjs';

const screens = 'cloud_kitchen_screens,cloud_kitchen_pairing_codes,cloud_kitchen_screen_events';

test('screen grants: column UPDATE only, append-only journal, never delete', () => {
  assert.equal(
    cloudKitchenScreenGrants('api_runtime', true),
    [
      `REVOKE ALL ON ${screens} FROM api_runtime;`,
      `GRANT SELECT,INSERT ON ${screens} TO api_runtime;`,
      'GRANT UPDATE(generation,key_hash,key_issued_at,revoked_at,revoked_by,revoked_reason,last_seen_at) ON cloud_kitchen_screens TO api_runtime;',
      'GRANT UPDATE(failed_attempts,used_at,burned_at) ON cloud_kitchen_pairing_codes TO api_runtime;',
      'GRANT SELECT ON cloud_channel_orders TO api_runtime;',
    ].join('\n'),
  );
  const sql = cloudKitchenScreenGrants('api_runtime', true);
  assert.doesNotMatch(sql, /DELETE|TRUNCATE|REFERENCES|TRIGGER/);
  // Identity, stations and code secrets are never updated.
  assert.doesNotMatch(sql, /UPDATE\([^)]*(station_ids|role|branch_id|code_hash|salt|selector)/);
  assert.doesNotMatch(sql, /UPDATE[^;]*cloud_kitchen_screen_events/);
  assert.equal(
    cloudKitchenScreenGrants('api_runtime', false),
    `REVOKE ALL ON ${screens} FROM api_runtime;`,
  );
});

test('cloud channel order grants: register and read only', () => {
  assert.equal(
    cloudChannelOrderGrants('commerce', true),
    [
      'REVOKE ALL ON cloud_channel_orders FROM commerce;',
      'GRANT SELECT,INSERT ON cloud_channel_orders TO commerce;',
      'GRANT SELECT ON branch_channel_modes,channel_number_ranges,channel_number_holds TO commerce;',
    ].join('\n'),
  );
  assert.doesNotMatch(cloudChannelOrderGrants('commerce', true), /UPDATE|DELETE|TRUNCATE/);
  assert.equal(
    cloudChannelOrderGrants('commerce', false),
    'REVOKE ALL ON cloud_channel_orders FROM commerce;',
  );
  for (const grants of [cloudKitchenScreenGrants, cloudChannelOrderGrants]) {
    for (const role of ['', null, 'Role', 'x;DROP ROLE api', 'a'.repeat(64), '1api'])
      assert.throws(() => grants(role, true));
    for (const enabled of [undefined, null, 'true', 1]) assert.throws(() => grants('api', enabled));
  }
});
