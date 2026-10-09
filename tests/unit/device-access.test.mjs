import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_REGISTRY_ACL,
  deviceRegistryGrants,
} from '../../infra/staging/device-registry-grants.mjs';

/** Expands GRANT statements into [table, column|null, privilege] triples. */
function granted(sql) {
  const out = [];
  for (const [, privileges, tables] of sql.matchAll(/GRANT (.+?) ON ([a-z_,]+) TO [a-z_]+;/g)) {
    const items = [];
    for (const m of privileges.matchAll(
      /(SELECT|INSERT|UPDATE|DELETE|TRUNCATE)(?:\(([a-z_,]+)\))?/g,
    ))
      items.push([m[1], m[2] ? m[2].split(',') : [null]]);
    for (const table of tables.split(','))
      for (const [privilege, columns] of items)
        for (const column of columns) out.push([table, column, privilege]);
  }
  return out;
}
const key = (rows) => rows.map((r) => r.join('|')).sort();

test('device registry grants are exactly the documented ACL', () => {
  const sql = deviceRegistryGrants('api_runtime', true);
  assert.deepEqual(key(granted(sql)), key(DEVICE_REGISTRY_ACL));
  assert.equal(new Set(key(DEVICE_REGISTRY_ACL)).size, DEVICE_REGISTRY_ACL.length);
  // Append-only journal and codes: never DELETE/TRUNCATE, never an unrestricted UPDATE.
  assert.doesNotMatch(sql, /GRANT[^;]*(DELETE|TRUNCATE|ALL)/);
  assert.doesNotMatch(sql, /GRANT[^;]*UPDATE ON/);
  // Credentials: only identity and expiry, never the token hash.
  assert.doesNotMatch(sql, /token_hash/);
  assert.match(sql, /GRANT SELECT\(device_id,expires_at\) ON device_credentials TO api_runtime;/);
  // The edge-only device fields are not writable by the back office.
  for (const column of ['kind', 'branch_id', 'organization_id', 'kiosk_device_id', 'role'])
    assert.ok(
      !DEVICE_REGISTRY_ACL.some(([t, c, p]) => t === 'devices' && c === column && p === 'UPDATE'),
    );
});

test('disabled registry revokes only privileges this helper alone owns', () => {
  const off = deviceRegistryGrants('api_runtime', false);
  assert.doesNotMatch(off, /GRANT/);
  assert.match(off, /REVOKE ALL ON device_pairing_codes,device_events FROM api_runtime;/);
  // backofficeGrants owns UPDATE(status) ON devices; kiosk release owns alias exchange columns.
  assert.doesNotMatch(off, /status/);
  assert.doesNotMatch(off, /request_id|failed_attempts|locked_until/);
  assert.doesNotMatch(off, /REVOKE ALL ON [^;]*(devices|kiosk_)/);
  assert.ok(deviceRegistryGrants('api_runtime', true).startsWith(off));
});

test('invalid role or flag is refused', () => {
  for (const role of ['', null, 'Role', 'x;DROP ROLE api', 'a'.repeat(64), '1api'])
    assert.throws(() => deviceRegistryGrants(role, true));
  for (const enabled of [undefined, null, 'true', 1])
    assert.throws(() => deviceRegistryGrants('api', enabled));
});
