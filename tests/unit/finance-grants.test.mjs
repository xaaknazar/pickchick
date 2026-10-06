import test from 'node:test';
import assert from 'node:assert/strict';
import { backofficeGrants } from '../../infra/staging/backoffice-grants.mjs';
test('finance privileges are migration-aware, append-only and disableable', () => {
  const enabled = backofficeGrants('synthetic_api', true),
    disabled = backofficeGrants('synthetic_api', false);
  assert.match(enabled, /to_regclass\('bo_finance_entries'\) IS NOT NULL/);
  assert.match(enabled, /GRANT SELECT,INSERT ON bo_finance_accounts/);
  assert.match(enabled, /GRANT UPDATE\(closed,revision\) ON bo_finance_periods/);
  assert.doesNotMatch(enabled, /GRANT (?:ALL|DELETE|UPDATE) ON bo_finance/);
  assert.doesNotMatch(disabled, /GRANT SELECT,INSERT ON bo_finance/);
  assert.match(disabled, /REVOKE ALL ON bo_finance_accounts/);
  assert.throws(() => backofficeGrants('x;DROP TABLE y', true));
});
