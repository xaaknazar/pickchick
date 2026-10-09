import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  PAIRING_ALPHABET,
  devicePairingPepper,
  deviceRegistryEnabled,
  generatePairingCode,
  kioskAliasCredentials,
  normalizePairingCode,
  pairingCodeHash,
  sealDeviceSecret,
  unsealDeviceSecret,
} from '../dist/device-registry.js';
import { deviceRevocable } from '../dist/model.js';

test('pairing codes are 8 Crockford characters and normalize typing mistakes', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const code = generatePairingCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(normalizePairingCode(code), code.replace('-', ''));
    assert.equal(normalizePairingCode(code.toLowerCase().replace('-', ' ')), code.replace('-', ''));
    seen.add(code);
  }
  assert.ok(seen.size > 195);
  assert.equal(PAIRING_ALPHABET.length, 32);
  assert.equal(normalizePairingCode('abcd-efgo'), 'ABCDEFG0');
  assert.equal(normalizePairingCode('IlO0-1234'), '11001234');
  for (const bad of ['', 'ABCD-EFG', 'ABCD-EFGHJ', 'ABCD-EFGU', null, 42, 'A'.repeat(40)])
    assert.equal(normalizePairingCode(bad), null);
});

test('code hash is a peppered HMAC bound to purpose; plaintext is not recoverable', () => {
  const pepper = randomBytes(32);
  const a = pairingCodeHash(pepper, 'kiosk', 'ABCD1234');
  assert.equal(a.length, 32);
  assert.deepEqual(pairingCodeHash(pepper, 'kiosk', 'ABCD1234'), a);
  assert.notDeepEqual(pairingCodeHash(pepper, 'edge_terminal', 'ABCD1234'), a);
  assert.notDeepEqual(pairingCodeHash(randomBytes(32), 'kiosk', 'ABCD1234'), a);
  assert.ok(!a.toString('latin1').includes('ABCD1234'));
  assert.throws(() => pairingCodeHash(randomBytes(16), 'kiosk', 'ABCD1234'));
});

test('pepper and opt-in come only from explicit env values', () => {
  assert.equal(devicePairingPepper({}), null);
  assert.equal(devicePairingPepper({ DEVICE_PAIRING_PEPPER: 'a'.repeat(64) }).length, 32);
  for (const bad of ['short', 'A'.repeat(64), 'g'.repeat(64)])
    assert.throws(() => devicePairingPepper({ DEVICE_PAIRING_PEPPER: bad }));
  assert.equal(deviceRegistryEnabled({}), false);
  assert.equal(deviceRegistryEnabled({ BACKOFFICE_DEVICE_REGISTRY_ENABLED: '1' }), false);
  assert.equal(deviceRegistryEnabled({ BACKOFFICE_DEVICE_REGISTRY_ENABLED: 'true' }), true);
});

test('kiosk alias credentials satisfy the cloud044 exchange format', () => {
  for (let i = 0; i < 50; i++) {
    const { login, password } = kioskAliasCredentials();
    assert.match(login, /^kiosk-[0-9a-hjkmnp-tv-z]{8}$/);
    assert.match(password, /^[0-9a-hjkmnp-tv-z]{12}$/);
  }
});

test('sealed device secret opens only with the same key and device binding', () => {
  const key = randomBytes(32),
    aad = {
      device: randomUUID(),
      kiosk: randomUUID(),
      organization: randomUUID(),
      branch: randomUUID(),
    },
    secret = randomBytes(32).toString('hex');
  const sealed = sealDeviceSecret(key, aad, secret);
  assert.equal(sealed.length, 12 + 16 + 64);
  assert.ok(!sealed.toString('latin1').includes(secret));
  assert.equal(unsealDeviceSecret(key, aad, sealed), secret);
  assert.equal(unsealDeviceSecret(randomBytes(32), aad, sealed), null);
  assert.equal(unsealDeviceSecret(key, { ...aad, branch: randomUUID() }, sealed), null);
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 1;
  assert.equal(unsealDeviceSecret(key, aad, tampered), null);
  assert.equal(unsealDeviceSecret(key, aad, Buffer.alloc(10)), null);
});

test('the branch edge is never revocable from the back office', () => {
  assert.equal(deviceRevocable('edge'), false);
  for (const kind of ['pos', 'kiosk', 'kitchen', 'display'])
    assert.equal(deviceRevocable(kind), true);
  assert.equal(deviceRevocable(undefined), false);
});
