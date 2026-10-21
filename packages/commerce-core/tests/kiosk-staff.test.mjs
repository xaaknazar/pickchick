// Audit 19.10 (findings 3.0, 3.3, 3.4): the kiosk staff code is verified only on the server,
// with a per-device lock. No database: the verifier comes from the environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  KIOSK_STAFF_PIN_ATTEMPTS,
  KIOSK_STAFF_PIN_LOCK_MS,
  KioskStaffPin,
  createKioskStaffPinVerifier,
  kioskStaffPinVerifier,
} from '../dist/kiosk-staff.js';

const code = (error) => error.code;

test('the verifier line stores neither the code nor a reversible form', async () => {
  const line = await createKioskStaffPinVerifier('482915');
  assert.match(line, /^scrypt1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.ok(!line.includes('482915'));
  assert.notEqual(line, await createKioskStaffPinVerifier('482915'));
  for (const bad of ['123', '123456789', '12a4', '', null])
    await assert.rejects(createKioskStaffPinVerifier(bad), { code: 'INVALID' });
  assert.equal(kioskStaffPinVerifier({}), null);
  assert.throws(() => kioskStaffPinVerifier({ KIOSK_STAFF_PIN_VERIFIER: 'plain-1234' }));
});

test('not configured means every staff action is unavailable', async () => {
  const staff = new KioskStaffPin(null);
  assert.equal(staff.configured, false);
  await assert.rejects(staff.verify(randomUUID(), { pin: '1234' }), (e) => code(e) === 'NOT_READY');
});

test('right code passes, wrong codes lock only that device and the lock expires', async () => {
  let now = 1_000_000;
  const verifier = kioskStaffPinVerifier({
    KIOSK_STAFF_PIN_VERIFIER: await createKioskStaffPinVerifier('482915'),
  });
  const staff = new KioskStaffPin(verifier, () => now);
  const device = randomUUID(),
    other = randomUUID();
  await staff.verify(device, { pin: '482915' });
  for (const body of [{}, { pin: 482915 }, { pin: '12' }, { pin: '482915', extra: 1 }, null])
    await assert.rejects(staff.verify(device, body), (e) => code(e) === 'INVALID');
  for (let i = 1; i < KIOSK_STAFF_PIN_ATTEMPTS; i++)
    await assert.rejects(
      staff.verify(device, { pin: '000000' }),
      (e) => code(e) === 'UNAUTHORIZED',
    );
  await assert.rejects(staff.verify(device, { pin: '000000' }), (e) => code(e) === 'RATE_LIMITED');
  // Locked: even the right code waits; another kiosk is not affected.
  await assert.rejects(staff.verify(device, { pin: '482915' }), (e) => code(e) === 'RATE_LIMITED');
  await staff.verify(other, { pin: '482915' });
  now += KIOSK_STAFF_PIN_LOCK_MS;
  await staff.verify(device, { pin: '482915' });
  // A success clears the count.
  await assert.rejects(staff.verify(device, { pin: '000000' }), (e) => code(e) === 'UNAUTHORIZED');
});
