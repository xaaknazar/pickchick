// Android release (lane android, 05.11.2026): the native config Expo generates for Google Play.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../apps/mobile/', import.meta.url));
const { expo } = JSON.parse(readFileSync(`${appRoot}app.json`, 'utf8'));
const require = createRequire(import.meta.url);
const plugin = require('../../apps/mobile/plugins/android-release.js');

function png(path) {
  const bytes = readFileSync(`${appRoot}${path}`);
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG', path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

test('app.json: Play package, unchanged versionCode, adaptive icon, no backups, Back as before', () => {
  const android = expo.android;
  assert.equal(android.package, 'kz.pickchick.app');
  // Codex raises versionCode for each upload; this lane does not.
  assert.equal(android.versionCode, 7);
  assert.equal(android.allowBackup, false);
  // BackHandler keeps the classic Back path (Expo writes enableOnBackInvokedCallback=false).
  assert.equal(android.predictiveBackGestureEnabled, false);
  assert.equal(android.softwareKeyboardLayoutMode, 'resize');
  assert.match(android.adaptiveIcon.backgroundColor, /^#[0-9A-F]{6}$/);
  for (const key of ['foregroundImage', 'monochromeImage']) {
    assert.deepEqual(png(android.adaptiveIcon[key]), { width: 1024, height: 1024, colorType: 6 });
  }
  const notifications = expo.plugins.find((entry) => entry[0] === 'expo-notifications')[1];
  assert.deepEqual(png(notifications.icon), { width: 96, height: 96, colorType: 6 });
  assert.equal(notifications.defaultChannel, 'orders');
  const secureStore = expo.plugins.find((entry) => entry[0] === 'expo-secure-store');
  assert.deepEqual(secureStore[1], { configureAndroidBackup: false });
  assert.ok(expo.plugins.includes('./plugins/android-release.js'));
  for (const permission of [
    'RECORD_AUDIO',
    'CAMERA',
    'SYSTEM_ALERT_WINDOW',
    'ACCESS_FINE_LOCATION',
    'ACCESS_COARSE_LOCATION',
    'READ_EXTERNAL_STORAGE',
    'WRITE_EXTERNAL_STORAGE',
    'READ_PHONE_STATE',
  ])
    assert.ok(android.blockedPermissions.includes(`android.permission.${permission}`), permission);
  assert.ok(android.blockedPermissions.includes('com.google.android.gms.permission.AD_ID'));
  // No SDK pin: React Native 0.86 / Expo SDK 57 already compile and target API 36.
  assert.equal(
    expo.plugins.some((entry) => [entry].flat()[0] === 'expo-build-properties'),
    false,
  );
  const catalog = readFileSync(
    `${appRoot}node_modules/react-native/gradle/libs.versions.toml`,
    'utf8',
  );
  assert.match(catalog, /^targetSdk = "36"$/m);
  assert.match(catalog, /^compileSdk = "36"$/m);
});

test('android-release plugin: one dgis query, nothing backed up or transferred', () => {
  const manifest = {
    manifest: {
      queries: [{ intent: [{ data: [{ $: { 'android:scheme': 'https' } }] }] }],
      application: [
        {
          $: {
            'android:name': '.MainApplication',
            'android:fullBackupContent': '@xml/secure_store_backup_rules',
          },
        },
      ],
    },
  };
  plugin.addAppQueries(manifest);
  plugin.addAppQueries(manifest);
  const schemes = manifest.manifest.queries[0].intent.flatMap((intent) =>
    intent.data.map((data) => data.$['android:scheme']),
  );
  assert.deepEqual(schemes, ['https', 'dgis']);
  plugin.setDataExtractionRules(manifest);
  const app = manifest.manifest.application[0].$;
  assert.equal(app['android:dataExtractionRules'], plugin.RULES_RESOURCE);
  assert.equal(app['android:fullBackupContent'], undefined);
  const xml = plugin.dataExtractionRulesXml();
  for (const section of ['cloud-backup', 'device-transfer']) {
    const body = xml.split(`<${section}>`)[1].split(`</${section}>`)[0];
    for (const domain of ['root', 'file', 'database', 'sharedpref', 'external'])
      assert.match(body, new RegExp(`<exclude domain="${domain}" path="\\." />`), section);
  }
  assert.doesNotMatch(xml, /<include/);
});

test('production introspection: the manifest Expo generates for the Play build', () => {
  const output = execFileSync(
    process.execPath,
    [`${appRoot}node_modules/expo/bin/cli`, 'config', '--type', 'introspect', '--json'],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        PICKCHICK_APP_VARIANT: 'release',
        EXPO_PUBLIC_PICKCHICK_ENV: 'production',
        EXPO_NO_DOTENV: '1',
        EXPO_NO_TELEMETRY: '1',
        CI: '1',
      },
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 5_000_000,
    },
  );
  const resolved = JSON.parse(output);
  assert.equal(resolved.extra.environment, 'production');
  assert.equal(resolved.extra.apiUrl, 'https://api.pickchick.kz');
  const manifest = resolved._internal.modResults.android.manifest.manifest;
  const app = manifest.application[0].$;
  assert.equal(app['android:allowBackup'], 'false');
  assert.equal(app['android:dataExtractionRules'], '@xml/pickchick_data_extraction_rules');
  assert.equal(app['android:enableOnBackInvokedCallback'], 'false');
  assert.equal(app['android:usesCleartextTraffic'], undefined);
  const removed = new Set(
    manifest['uses-permission']
      .filter((entry) => entry.$['tools:node'] === 'remove')
      .map((entry) => entry.$['android:name']),
  );
  for (const permission of expo.android.blockedPermissions) assert.ok(removed.has(permission));
  const schemes = manifest.queries.flatMap((query) =>
    query.intent.flatMap((intent) => (intent.data ?? []).map((d) => d.$['android:scheme'])),
  );
  assert.ok(schemes.includes('dgis'));
  const activity = manifest.application[0].activity.find(
    (a) => a.$['android:name'] === '.MainActivity',
  );
  assert.equal(activity.$['android:windowSoftInputMode'], 'adjustResize');
});
