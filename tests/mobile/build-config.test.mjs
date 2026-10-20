import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BUILD_PROFILES,
  PRODUCTION_API_URL,
  STAGING_API_URL,
  resolveBuildConfig,
  supportLink,
} from '../../apps/mobile/src/build-config.ts';
import mobileConfig from '../../apps/mobile/app.config.ts';

// Audit 2.2 / 7.3: the API host is chosen by the build profile instead of being compiled in.
const appRoot = fileURLToPath(new URL('../../apps/mobile/', import.meta.url));
const { expo: base } = JSON.parse(readFileSync(`${appRoot}/app.json`, 'utf8'));

function withEnv(values, run) {
  const keys = Object.keys(values);
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys)
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    return run();
  } finally {
    for (const key of keys)
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
  }
}
const resolveApp = (values) =>
  withEnv(values, () => mobileConfig({ config: JSON.parse(JSON.stringify(base)) }));

test('staging stays the default; production selects the owned domain', () => {
  assert.equal(STAGING_API_URL, 'https://pickchick.185.129.51.103.nip.io');
  assert.equal(PRODUCTION_API_URL, 'https://api.pickchick.kz');
  assert.deepEqual(resolveBuildConfig({}), {
    environment: 'staging',
    apiUrl: STAGING_API_URL,
    supportUrl: null,
  });
  assert.equal(resolveBuildConfig({ environment: 'staging' }).apiUrl, STAGING_API_URL);
  assert.deepEqual(resolveBuildConfig({ environment: 'production' }), {
    environment: 'production',
    apiUrl: PRODUCTION_API_URL,
    supportUrl: null,
  });
  assert.deepEqual(Object.keys(BUILD_PROFILES).sort(), ['production', 'staging']);
});

test('an explicit API origin is accepted only as a bare HTTPS origin', () => {
  assert.equal(
    resolveBuildConfig({ environment: 'production', apiUrl: 'https://api2.pickchick.kz/' }).apiUrl,
    'https://api2.pickchick.kz',
  );
  for (const apiUrl of [
    'http://api.pickchick.kz',
    'https://user:pass@api.pickchick.kz',
    'https://api.pickchick.kz/v1',
    'https://api.pickchick.kz?x=1',
    'https://api.pickchick.kz#x',
    'not a url',
  ])
    assert.throws(() => resolveBuildConfig({ apiUrl }), /EXPO_PUBLIC_API_URL/, apiUrl);
  for (const environment of ['prod', 'Production', 'dev', ' '])
    assert.throws(() => resolveBuildConfig({ environment }), /EXPO_PUBLIC_PICKCHICK_ENV/);
});

test('support contact accepts a web page, phone or e-mail and nothing else', () => {
  for (const [value, expected] of [
    ['https://pickchick.kz/support', 'https://pickchick.kz/support'],
    ['https://wa.me/77000000000', 'https://wa.me/77000000000'],
    ['tel:+77000000000', 'tel:+77000000000'],
    ['mailto:support@pickchick.kz', 'mailto:support@pickchick.kz'],
  ])
    assert.equal(resolveBuildConfig({ supportUrl: value }).supportUrl, expected);
  for (const value of [
    'http://pickchick.kz',
    'javascript:alert(1)',
    'tel:12',
    'mailto:nobody',
    'https://a:b@pickchick.kz',
  ])
    assert.throws(() => resolveBuildConfig({ supportUrl: value }), /EXPO_PUBLIC_SUPPORT_URL/);
  assert.equal(resolveBuildConfig({ supportUrl: '' }).supportUrl, null);
  assert.equal(supportLink(null), null);
  assert.deepEqual(supportLink('tel:+77000000000'), {
    url: 'tel:+77000000000',
    label: 'Позвонить в поддержку',
  });
  assert.equal(supportLink('mailto:support@pickchick.kz').label, 'Написать в поддержку');
  assert.equal(supportLink('https://pickchick.kz/support').label, 'Связаться с поддержкой');
});

test('Expo config records the same environment and API as the JS bundle', () => {
  const staging = resolveApp({
    EXPO_PUBLIC_PICKCHICK_ENV: undefined,
    EXPO_PUBLIC_API_URL: undefined,
  });
  assert.deepEqual(staging.extra, base.extra);
  const production = resolveApp({
    EXPO_PUBLIC_PICKCHICK_ENV: 'production',
    EXPO_PUBLIC_API_URL: undefined,
  });
  assert.equal(production.extra.environment, 'production');
  assert.equal(production.extra.apiUrl, PRODUCTION_API_URL);
  assert.equal(production.extra.customerOperationsEnabled, false);
  // Identity never depends on the backend profile.
  assert.equal(production.ios.bundleIdentifier, 'kz.pickchick.app');
  assert.throws(
    () => resolveApp({ EXPO_PUBLIC_PICKCHICK_ENV: 'prod', EXPO_PUBLIC_API_URL: undefined }),
    /EXPO_PUBLIC_PICKCHICK_ENV/,
  );
});
