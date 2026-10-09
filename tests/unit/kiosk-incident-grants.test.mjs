import test from 'node:test';
import assert from 'node:assert/strict';
import { kioskIncidentGrants } from '../../infra/staging/kiosk-incident-grants.mjs';

test('kiosk incident grants are append-only and revoke when disabled', () => {
  const on = kioskIncidentGrants('api_runtime', true);
  assert.match(on, /REVOKE ALL ON commerce_kiosk_payment_incidents FROM api_runtime;/);
  assert.match(on, /GRANT SELECT,INSERT ON commerce_kiosk_payment_incidents TO api_runtime;/);
  assert.doesNotMatch(on, /UPDATE|DELETE|TRUNCATE/);
  assert.equal(
    kioskIncidentGrants('api_runtime', false),
    'REVOKE ALL ON commerce_kiosk_payment_incidents FROM api_runtime;',
  );
  for (const role of ['', null, 'Role', 'x;DROP ROLE api', 'a'.repeat(64), '1api'])
    assert.throws(() => kioskIncidentGrants(role, true));
  for (const enabled of [undefined, null, 'true', 1])
    assert.throws(() => kioskIncidentGrants('api', enabled));
});
