import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cloudChannelAvailabilityGrants,
  cloudChannelStopGrants,
} from '../../infra/staging/cloud-channel-stop-grants.mjs';

const own = 'cloud_channel_stops,cloud_channel_stop_events,cloud_stale_stop_overrides';
const kitchen = 'branch_channel_modes,cloud_kitchen_stations,cloud_kitchen_station_presence';

test('cloud channel stop grants: append-only audit, column UPDATE only, no delete', () => {
  assert.equal(
    cloudChannelStopGrants('bo_runtime', true),
    [
      `REVOKE ALL ON ${own} FROM bo_runtime;`,
      `GRANT SELECT,INSERT ON ${own} TO bo_runtime;`,
      'GRANT UPDATE(stopped,duration,reason,version,actor_id,actor_label) ON cloud_channel_stops TO bo_runtime;',
      `GRANT SELECT ON ${kitchen} TO bo_runtime;`,
    ].join('\n'),
  );
  const sql = cloudChannelStopGrants('bo_runtime', true);
  assert.doesNotMatch(sql, /DELETE|TRUNCATE|REFERENCES|TRIGGER/);
  // Server clock and expiry are trigger-owned; the 054 mode is never written here.
  assert.doesNotMatch(sql, /updated_at|expires_at|organization_id|branch_id,|variant_id/);
  assert.doesNotMatch(sql, /(INSERT|UPDATE)[^;]*branch_channel_modes/);
  assert.equal(
    cloudChannelStopGrants('bo_runtime', false),
    `REVOKE ALL ON ${own} FROM bo_runtime;`,
  );
});

test('cloud channel availability grants are read-only', () => {
  assert.equal(
    cloudChannelAvailabilityGrants('api_runtime', true),
    [
      `REVOKE ALL ON ${own} FROM api_runtime;`,
      'GRANT SELECT ON cloud_channel_stops,cloud_stale_stop_overrides TO api_runtime;',
      `GRANT SELECT ON ${kitchen} TO api_runtime;`,
    ].join('\n'),
  );
  assert.doesNotMatch(cloudChannelAvailabilityGrants('api_runtime', true), /INSERT|UPDATE|DELETE/);
  assert.equal(
    cloudChannelAvailabilityGrants('api_runtime', false),
    `REVOKE ALL ON ${own} FROM api_runtime;`,
  );
  for (const grants of [cloudChannelStopGrants, cloudChannelAvailabilityGrants]) {
    for (const role of ['', null, 'Role', 'x;DROP ROLE api', 'a'.repeat(64), '1api'])
      assert.throws(() => grants(role, true));
    for (const enabled of [undefined, null, 'true', 1]) assert.throws(() => grants('api', enabled));
  }
});
