// Audit 19.10, finding 7.3 (kiosk part): the API origin comes from the build config. Production
// builds use https://api.pickchick.kz; staging and development keep the nip.io host.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KIOSK_PRODUCTION_API_URL,
  KIOSK_STAGING_API_URL,
  kioskApiUrl,
} from '../../apps/kiosk/src/api.ts';

test('production builds use the production domain whatever else is configured', () => {
  assert.equal(KIOSK_PRODUCTION_API_URL, 'https://api.pickchick.kz');
  assert.equal(kioskApiUrl({ profile: 'production' }), 'https://api.pickchick.kz');
  assert.equal(
    kioskApiUrl({ profile: 'production', url: KIOSK_STAGING_API_URL }),
    'https://api.pickchick.kz',
  );
});

test('other builds read an explicit origin, otherwise keep the staging host', () => {
  assert.equal(kioskApiUrl({}), KIOSK_STAGING_API_URL);
  assert.equal(kioskApiUrl({ profile: 'staging' }), KIOSK_STAGING_API_URL);
  assert.equal(kioskApiUrl({ url: 'https://staging.example.kz/' }), 'https://staging.example.kz');
  assert.equal(kioskApiUrl({ url: 'http://127.0.0.1:9' }), 'http://127.0.0.1:9');
  for (const url of [
    'http://api.pickchick.kz',
    'https://user:pw@api.pickchick.kz',
    'https://api.pickchick.kz/v1',
    'https://api.pickchick.kz?x=1',
    'not a url',
  ])
    assert.equal(kioskApiUrl({ url }), KIOSK_STAGING_API_URL, url);
});

test('only the release id format pinned by ios_release.py is reported', async () => {
  const { kioskReleaseId } = await import('../../apps/kiosk/src/api.ts');
  assert.equal(kioskReleaseId('pk-0123456789abcdef'), 'pk-0123456789abcdef');
  for (const value of [undefined, '', 'pk-XYZ', 'pk-0123456789abcdef0', 'release 1'])
    assert.equal(kioskReleaseId(value), null, String(value));
});
