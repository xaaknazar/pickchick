import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KioskKaspiQrBridgeClient,
  qrStatusOutcome,
} from '../../packages/commerce-core/dist/kiosk-kaspi-qr.js';

const config = {
  bridgeUrl: 'http://127.0.0.1:1',
  requestTimeoutMs: 1000,
  session: { tokenSN: 'synthetic', vtokenSecret: 'synthetic', profileId: 'synthetic' },
};
const sale = {
  Id: 123,
  Amount: ' 110 ₸',
  OperationType: 0,
  OperationMethod: 0,
  SaleType: 'Dynamic',
};
const row = { operation_id: '123', amount_minor: '11000', expires_at: new Date(0) };
function fixture(status, details = sale, code = 0) {
  const calls = [];
  const client = new KioskKaspiQrBridgeClient(config, async (url, options) => {
    calls.push({ url, options });
    return new Response(
      JSON.stringify({
        StatusCode: calls.length === 1 ? 0 : code,
        Data: calls.length === 1 ? status : details,
      }),
    );
  });
  return { client, calls };
}
test('Processed without amount requires the same signed bank sale details and exact money', async () => {
  const f = fixture({ Id: 123, Status: 'Processed' }),
    answer = await f.client.status('123');
  assert.equal(answer.kind, 'ok');
  assert.equal(qrStatusOutcome(answer.data, row, new Date()), 'paid');
  assert.deepEqual(
    f.calls.map((c) => new URL(c.url).pathname),
    ['/api/qr/status', '/api/history/details'],
  );
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { id: '123', operationMethod: 0 });
  assert.equal(f.calls[1].options.redirect, 'error');
});
test('foreign, refund, unknown method, malformed or missing bank details never confirm money', async () => {
  for (const patch of [
    { Id: 124 },
    { QrOperationId: 124 },
    { OperationType: 1 },
    { OperationMethod: 1 },
    { SaleType: 'Remote' },
    { Amount: '-110 ₸' },
    { Amount: 0 },
    { Amount: null },
    { Amount: '110 USD' },
    { Amount: '1 10 ₸' },
  ]) {
    const f = fixture({ Id: 123, Status: 'Processed' }, { ...sale, ...patch });
    assert.equal((await f.client.status('123')).kind, 'uncertain');
  }
});
test('different real bank amount remains unknown in the payment state machine', async () => {
  const f = fixture({ Id: 123, Status: 'Processed' }, { ...sale, Amount: '111 ₸' }),
    answer = await f.client.status('123');
  assert.equal(answer.kind, 'ok');
  assert.equal(qrStatusOutcome(answer.data, row, new Date()), 'unknown');
});
test('explicit amount and mismatched identities are never overwritten with details', async () => {
  for (const status of [
    { Id: 123, Status: 'Processed', Amount: 0 },
    { Id: 123, Status: 'Processed', Amount: 111 },
    { Id: 124, Status: 'Processed' },
    { Id: 123, QrOperationId: 124, Status: 'Processed' },
    { Id: 123, Status: 'Wait' },
    { Id: 123, Status: 'Expired' },
  ]) {
    const f = fixture(status),
      answer = await f.client.status('123');
    assert.deepEqual(answer, { kind: 'ok', data: status });
    assert.equal(f.calls.length, 1);
  }
});
test('unsupported details envelope cannot fabricate an amount', async () => {
  const f = fixture({ Id: 123, Status: 'Processed' }, sale, 99);
  assert.equal((await f.client.status('123')).kind, 'uncertain');
});
