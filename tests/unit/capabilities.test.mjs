import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilities, capabilityNotice } from '../../services/api/dist/capabilities.js';
import { parseCapabilities } from '../../apps/mobile/src/api.ts';

const config = (extra = {}) => ({ service: 'api', environment: 'staging', ...extra });

test('the v1 gate stays exactly what installed clients accept', () => {
  for (const customerAuthEnabled of [false, true])
    for (const env of [{}, { CUSTOMER_KASPI_PILOT_ENABLED: 'true' }]) {
      const body = capabilities(config({ customerAuthEnabled }), env);
      assert.equal(body.ordering_enabled, false);
      for (const key of ['checkout', 'payments', 'fiscal', 'loyalty'])
        assert.equal(body.features[key], false, key);
      // The installed mobile parser (TestFlight build 20 source) still accepts the response.
      assert.equal(parseCapabilities(body).schema_version, 1);
    }
});

test('the pilot notice no longer claims ordering without payment while Kaspi takes money', () => {
  const live = capabilityNotice(true, { CUSTOMER_KASPI_PILOT_ENABLED: 'true' });
  assert.match(live.ru, /оплачиваются через Kaspi/);
  assert.doesNotMatch(live.ru, /без оплаты/);
  assert.match(live.kk, /Kaspi арқылы төленеді/);
  // A disabled pilot keeps the previous wording.
  assert.match(capabilityNotice(true, {}).ru, /без оплаты/);
  // The owner's sales switch (pay lane) refuses new orders and payments: never "without payment".
  const paused = capabilityNotice(true, {
    CUSTOMER_KASPI_PILOT_ENABLED: 'true',
    CUSTOMER_KASPI_SALES_ENABLED: 'false',
  });
  assert.match(paused.ru, /временно приостановлена/);
  assert.match(paused.kk, /уақытша тоқтатылды/);
  assert.doesNotMatch(paused.ru, /без оплаты/);
  assert.match(capabilityNotice(false, { CUSTOMER_KASPI_PILOT_ENABLED: 'true' }).ru, /Тестовый/);
  for (const text of [live.ru, live.kk, paused.ru, paused.kk]) assert.doesNotMatch(text, /[—–]/);
  // Every variant still passes the shared contract (CapabilitiesSchema notice limits).
  for (const env of [
    {},
    { CUSTOMER_KASPI_PILOT_ENABLED: 'true', CUSTOMER_KASPI_SALES_ENABLED: 'false' },
  ])
    assert.equal(
      parseCapabilities(capabilities(config({ customerAuthEnabled: true }), env)).schema_version,
      1,
    );
});
