import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { approvedEndpoint } from '../../apps/kiosk/src/photobooth/endpoint.ts';

test('an explicitly deferred printer rejects old pairing and any new network endpoint', () => {
  const helper = readFileSync(
    new URL('../../scripts/mobile/ios_release.py', import.meta.url),
    'utf8',
  );
  const disabled = helper.match(/^KIOSK_PHOTO_DISABLED = "([^"]+)"/m)?.[1];
  assert.ok(disabled);
  for (const endpoint of [
    'https://192.168.1.20:13440',
    'https://printer.pickchick.kz:13440',
    'http://192.168.1.20:13440',
    disabled,
  ]) {
    assert.equal(approvedEndpoint(endpoint, disabled), false);
  }
  assert.equal(approvedEndpoint(disabled, 'https://printer.pickchick.kz:13440'), false);
});
