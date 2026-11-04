/* global require, module */
/* eslint @typescript-eslint/no-require-imports: "off" */
/**
 * Android release settings that app.json cannot express (lane android, 05.11.2026).
 *
 * 1. 2GIS: on Android 11+ package visibility hides other apps, so
 *    `Linking.canOpenURL('dgis://...')` is false without a `<queries>` entry and the restaurant
 *    card always fell back to the web page (components/Restaurants.tsx openIn2Gis).
 * 2. Backups: `android.allowBackup: false` (app.json) stops cloud backup, but on Android 12+ it
 *    does not stop device-to-device transfer. Session tokens live in expo-secure-store, whose
 *    Keystore keys never leave the phone, while AsyncStorage holds the cart, the saved payment
 *    intent and settings. A partial copy on a new phone (intent without its session) is worse
 *    than a clean start, so nothing is extracted: every domain is excluded from both cloud
 *    backup and device transfer. The customer signs in again with the phone number.
 * 3. Release signing: Expo's template signs `release` with the debug keystore. The release build
 *    type now uses a `release` signing config filled only from Gradle properties
 *    (`pickchickUpload*`, which scripts/mobile/android_release.py passes as ORG_GRADLE_PROJECT_*
 *    environment entries); without them the bundle is left unsigned, never debug-signed.
 *    (AGP's `android.injected.signing.*` properties from the environment were ignored by
 *    bundleRelease in the container build of 05.11.2026: the AAB came out debug-signed.)
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
} = require('expo/config-plugins');

const DGIS_SCHEME = 'dgis';
const RULES_NAME = 'pickchick_data_extraction_rules';
const RULES_RESOURCE = `@xml/${RULES_NAME}`;
const DOMAINS = ['root', 'file', 'database', 'sharedpref', 'external'];
const UPLOAD_PROPERTIES = [
  'pickchickUploadStoreFile',
  'pickchickUploadStorePassword',
  'pickchickUploadKeyAlias',
  'pickchickUploadKeyPassword',
];
const RELEASE_SIGNING = `
        release {
            // PickChick upload key (plugins/android-release.js): Gradle properties only, never a file.
            if (findProperty('pickchickUploadStoreFile')) {
                storeFile file(findProperty('pickchickUploadStoreFile'))
                storePassword findProperty('pickchickUploadStorePassword')
                keyAlias findProperty('pickchickUploadKeyAlias')
                keyPassword findProperty('pickchickUploadKeyPassword')
            }
        }`;
const RELEASE_SIGNING_USE =
  "signingConfig findProperty('pickchickUploadStoreFile') ? signingConfigs.release : null";

/** app/build.gradle: a release signing config from properties; release never uses debug's. */
function setReleaseSigning(gradle) {
  if (gradle.includes('pickchickUploadStoreFile')) return gradle;
  const debugConfig = /(signingConfigs \{\n(\s*)debug \{[\s\S]*?\n\2\})/;
  const releaseUse =
    /(buildTypes \{[\s\S]*?\brelease \{[\s\S]*?)signingConfig signingConfigs\.debug/;
  if (!debugConfig.test(gradle) || !releaseUse.test(gradle))
    throw new Error(
      'android-release: the app/build.gradle signing blocks changed; update the plugin',
    );
  return gradle
    .replace(debugConfig, `$1${RELEASE_SIGNING}`)
    .replace(releaseUse, `$1${RELEASE_SIGNING_USE}`);
}

/** Adds `<queries><intent>VIEW dgis:</intent></queries>` once; other queries stay. */
function addAppQueries(manifest) {
  const root = manifest.manifest;
  const queries = (root.queries = root.queries ?? [{}]);
  const query = queries[0];
  query.intent = query.intent ?? [];
  const present = query.intent.some((intent) =>
    (intent.data ?? []).some((data) => data.$?.['android:scheme'] === DGIS_SCHEME),
  );
  if (!present)
    query.intent.push({
      action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
      data: [{ $: { 'android:scheme': DGIS_SCHEME } }],
    });
  return manifest;
}

/** The application refers to the rules below; the legacy backup attribute is not needed. */
function setDataExtractionRules(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  application.$['android:dataExtractionRules'] = RULES_RESOURCE;
  delete application.$['android:fullBackupContent'];
  return manifest;
}

function dataExtractionRulesXml() {
  const excludes = DOMAINS.map((domain) => `    <exclude domain="${domain}" path="." />`).join(
    '\n',
  );
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- PickChick: no cloud backup and no device-to-device copy of app data (plugins/android-release.js). -->',
    '<data-extraction-rules>',
    '  <cloud-backup>',
    excludes,
    '  </cloud-backup>',
    '  <device-transfer>',
    excludes,
    '  </device-transfer>',
    '</data-extraction-rules>',
    '',
  ].join('\n');
}

function withAndroidRelease(config) {
  config = withAppBuildGradle(config, (next) => {
    next.modResults.contents = setReleaseSigning(next.modResults.contents);
    return next;
  });
  config = withAndroidManifest(config, (next) => {
    next.modResults = setDataExtractionRules(addAppQueries(next.modResults));
    return next;
  });
  return withDangerousMod(config, [
    'android',
    async (next) => {
      const directory = path.join(next.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, `${RULES_NAME}.xml`), dataExtractionRulesXml());
      return next;
    },
  ]);
}

module.exports = withAndroidRelease;
module.exports.addAppQueries = addAppQueries;
module.exports.setDataExtractionRules = setDataExtractionRules;
module.exports.dataExtractionRulesXml = dataExtractionRulesXml;
module.exports.RULES_RESOURCE = RULES_RESOURCE;
module.exports.setReleaseSigning = setReleaseSigning;
module.exports.UPLOAD_PROPERTIES = UPLOAD_PROPERTIES;
