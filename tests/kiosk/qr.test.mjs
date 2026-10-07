import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentQrSvg, visiblePaymentQr } from '../../apps/kiosk/src/qr.ts';

test('QR visibility requires pending bank payload and unexpired bounded lifetime', () => {
  const now = Date.parse('2026-10-07T00:00:00Z');
  const payment = {
    state: 'pending',
    qrPayload: 'https://qr.kaspi.kz/fixture',
    expiresAt: '2026-10-07T00:01:00Z',
  };
  assert.equal(visiblePaymentQr(payment, false, now), payment.qrPayload);
  assert.equal(visiblePaymentQr(payment, true, now), null);
  for (const change of [
    { expiresAt: null },
    { expiresAt: 'invalid' },
    { expiresAt: '2026-10-07T00:00:00Z' },
    { qrPayload: null },
    { state: 'checking' },
    { state: 'paid' },
  ])
    assert.equal(visiblePaymentQr({ ...payment, ...change }, false, now), null);
});

test('QR encoder emits local vector modules with quiet zone and no remote image URL', () => {
  const svg = paymentQrSvg('https://qr.kaspi.kz/fixture');
  assert.match(svg, /<svg/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /M4 4h1v1h-1z/);
  assert.equal(svg.includes('qr.kaspi.kz'), false);
  assert.equal(paymentQrSvg(''), null);
  assert.equal(paymentQrSvg('x'.repeat(4097)), null);
});

test('kiosk presentation labels order numbers and keeps scan instructions concise', async () => {
  const { kioskOrderNumber, qrScanInstructions } =
    await import('../../apps/kiosk/src/presentation.ts');
  assert.equal(kioskOrderNumber('12'), '№12');
  assert.equal(kioskOrderNumber('№12'), '№12');
  assert.equal(kioskOrderNumber(null), '-');
  assert.equal(kioskOrderNumber('-'), '-');
  assert.equal(qrScanInstructions('ru').includes('Не оплачивайте повторно'), false);
  assert.equal(qrScanInstructions('kk').includes('Қайта төлемеңіз'), false);
  assert.match(qrScanInstructions('ru'), /отсканируйте QR/);
});
