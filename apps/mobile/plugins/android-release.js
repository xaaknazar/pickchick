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
 */
const fs = require('node:fs');
const path = require('node:path');
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

const DGIS_SCHEME = 'dgis';
const RULES_NAME = 'pickchick_data_extraction_rules';
const RULES_RESOURCE = `@xml/${RULES_NAME}`;
const DOMAINS = ['root', 'file', 'database', 'sharedpref', 'external'];

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
