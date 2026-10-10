import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudKitchenGrants } from '../../infra/staging/cloud-kitchen-grants.mjs';

const readOnly =
  'branch_channel_modes,branch_channel_mode_changes,cloud_kitchen_stations,cloud_kitchen_routing,cloud_kitchen_config';
const appendOnly = 'cloud_kitchen_admissions,cloud_kitchen_commands';
const mutable = 'cloud_kitchen_orders,cloud_kitchen_tasks,cloud_kitchen_outbox';
const presence = 'cloud_kitchen_station_presence';
const all = [readOnly, appendOnly, mutable, presence].join(',');
const fn = 'cloud_kitchen_set_mode(uuid,text,text,text)';

test('cloud kitchen grants: config read-only, journals append-only, no delete', () => {
  const sql = cloudKitchenGrants('api_runtime', true);
  assert.equal(
    sql,
    [
      `REVOKE ALL ON ${all} FROM api_runtime;`,
      `REVOKE ALL ON FUNCTION ${fn} FROM api_runtime;`,
      `GRANT SELECT ON ${readOnly} TO api_runtime;`,
      `GRANT SELECT,INSERT ON ${appendOnly} TO api_runtime;`,
      `GRANT SELECT,INSERT,UPDATE ON ${mutable} TO api_runtime;`,
      `GRANT SELECT,INSERT,UPDATE ON ${presence} TO api_runtime;`,
      `GRANT EXECUTE ON FUNCTION ${fn} TO api_runtime;`,
    ].join('\n'),
  );
  assert.doesNotMatch(sql, /DELETE|TRUNCATE|REFERENCES|TRIGGER/);
  // Mode and routing are never written directly by the runtime.
  for (const table of readOnly.split(','))
    assert.doesNotMatch(sql, new RegExp(`INSERT[^;]*\\b${table}\\b`));
  assert.equal(
    cloudKitchenGrants('api_runtime', false),
    `REVOKE ALL ON ${all} FROM api_runtime;\nREVOKE ALL ON FUNCTION ${fn} FROM api_runtime;`,
  );
  for (const role of ['', null, 'Role', 'x;DROP ROLE api', 'a'.repeat(64), '1api'])
    assert.throws(() => cloudKitchenGrants(role, true));
  for (const enabled of [undefined, null, 'true', 1])
    assert.throws(() => cloudKitchenGrants('api', enabled));
});
