import assert from 'node:assert/strict';
import test from 'node:test';
import { tipTopPayTestGrants } from '../../infra/staging/tiptoppay-test-grants.mjs';

test('TEST role receives only permissions for separate sandbox observations', () => {
  assert.equal(
    tipTopPayTestGrants('pickchick_app', true),
    'GRANT SELECT,INSERT,UPDATE ON commerce_tiptoppay_test_payments TO pickchick_app;',
  );
  assert.equal(
    tipTopPayTestGrants('pickchick_app', false),
    'REVOKE ALL ON commerce_tiptoppay_test_payments FROM pickchick_app;',
  );
  for (const role of ['public', 'pickchick_owner', 'pickchick_kaspi_worker', 'other'])
    assert.throws(() => tipTopPayTestGrants(role, true));
  assert.throws(() => tipTopPayTestGrants('pickchick_app', 'true'));
});
