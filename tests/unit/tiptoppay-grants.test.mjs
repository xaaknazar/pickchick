import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tipTopPayCheckoutGrants,
  tipTopPayObservationGrants,
} from '../../infra/payments/tiptoppay-grants.mjs';
test('TipTop role names cannot inject SQL; all features default to revoked', () => {
  for (const grant of [tipTopPayCheckoutGrants, tipTopPayObservationGrants]) {
    for (const role of ['public', 'a;DROP TABLE x', 'a"', 'a b']) {
      assert.throws(() => grant(role, true));
    }
    assert.throws(() => grant('runtime', 'true'));
    assert.doesNotMatch(grant('runtime', false), /GRANT /);
  }
});
test('checkout authority does not grant bank observations or fiscal completion', () => {
  const sql = tipTopPayCheckoutGrants('checkout_runtime', true);
  assert.doesNotMatch(sql, /commerce_captures|commerce_provider_inbox|commerce_fiscal_documents/);
  assert.match(sql, /UPDATE\(token_hash,opened_at\)/);
  const bank = tipTopPayObservationGrants('tiptop_runtime', true);
  assert.doesNotMatch(
    bank,
    /GRANT (?:ALL|DELETE)|UPDATE[^;]*commerce_provider_accounts|UPDATE[^;]*commerce_fiscal_documents/,
  );
});
