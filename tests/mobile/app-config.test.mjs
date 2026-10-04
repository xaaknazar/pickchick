import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mobileConfig from '../../apps/mobile/app.config.ts';

const appRoot = fileURLToPath(new URL('../../apps/mobile/', import.meta.url));
const { expo: base } = JSON.parse(readFileSync(`${appRoot}/app.json`, 'utf8'));

function resolveVariant(variant) {
  const previous = process.env.PICKCHICK_APP_VARIANT;
  try {
    if (variant === undefined) delete process.env.PICKCHICK_APP_VARIANT;
    else process.env.PICKCHICK_APP_VARIANT = variant;
    return mobileConfig({ config: JSON.parse(JSON.stringify(base)) });
  } finally {
    if (previous === undefined) delete process.env.PICKCHICK_APP_VARIANT;
    else process.env.PICKCHICK_APP_VARIANT = previous;
  }
}

test('default and explicit release preserve the original app identity and backend configuration', () => {
  const release = resolveVariant(undefined);
  assert.deepEqual(release, resolveVariant('release'));
  const { plugins, ...originalFields } = release;
  const { plugins: originalPlugins, ...original } = base;
  // The native binary must permit the farm route to rotate; app routes choose orientation.
  assert.deepEqual(originalFields, { ...original, orientation: 'default' });
  assert.deepEqual(plugins, [
    ...originalPlugins,
    ['expo-dev-client', { addGeneratedScheme: false }],
  ]);
  assert.equal(release.ios.bundleIdentifier, 'kz.pickchick.app');
  assert.equal(release.android.package, 'kz.pickchick.app');
  assert.equal(release.scheme, 'pickchick');
});

test('development has a separate install and deep link while preserving provider flags and API', () => {
  const dev = resolveVariant('development');
  assert.equal(dev.name, 'PickChick Dev');
  assert.equal(dev.ios.bundleIdentifier, 'kz.pickchick.app.dev');
  assert.equal(dev.android.package, 'kz.pickchick.app.dev');
  assert.equal(dev.scheme, 'pickchick-dev');
  assert.equal(dev.slug, 'pickchick-dev');
  assert.deepEqual(dev.extra, base.extra);
  assert.deepEqual(dev.ios.infoPlist, base.ios.infoPlist);
  assert.equal(dev.ios.appleTeamId, base.ios.appleTeamId);
  assert.equal(dev.extra.customerOperationsEnabled, false);
  assert.equal(dev.updates, undefined);
  assert.equal(dev.runtimeVersion, undefined);
  assert.equal(dev.extra.eas, undefined);
});

test('a misspelled variant fails before building or launching an app with the wrong identity', () => {
  for (const variant of ['dev', 'production', '', 'Development']) {
    assert.throws(() => resolveVariant(variant), /PICKCHICK_APP_VARIANT/);
  }
});

test('Expo native introspection keeps release and development URL schemes separate', () => {
  for (const variant of ['release', 'development']) {
    const output = execFileSync(
      process.execPath,
      [`${appRoot}/node_modules/expo/bin/cli`, 'config', '--type', 'introspect', '--json'],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          PICKCHICK_APP_VARIANT: variant,
          EXPO_NO_DOTENV: '1',
          EXPO_NO_TELEMETRY: '1',
          CI: '1',
        },
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 5_000_000,
      },
    );
    const resolved = JSON.parse(output);
    const expected = variant === 'development' ? 'pickchick-dev' : 'pickchick';
    const expectedId = variant === 'development' ? 'kz.pickchick.app.dev' : 'kz.pickchick.app';
    const mods = resolved._internal.modResults;
    const iosSchemes = mods.ios.infoPlist.CFBundleURLTypes.flatMap(
      (entry) => entry.CFBundleURLSchemes,
    );
    const androidSchemes = mods.android.manifest.manifest.application.flatMap((application) =>
      application.activity.flatMap((activity) =>
        (activity['intent-filter'] ?? []).flatMap((filter) =>
          (filter.data ?? []).map((data) => data.$['android:scheme']).filter(Boolean),
        ),
      ),
    );
    assert.deepEqual(iosSchemes.sort(), [expected, expectedId].sort());
    for (const orientation of [
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight',
    ]) {
      assert.ok(mods.ios.infoPlist.UISupportedInterfaceOrientations.includes(orientation));
    }
    assert.deepEqual(androidSchemes, [expected]);
    assert.deepEqual(resolved.extra, { ...base.extra, router: {} });
    assert.equal(resolved.ios.bundleIdentifier, expectedId);
    assert.equal(resolved.android.package, expectedId);
  }
});
