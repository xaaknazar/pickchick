// Stage 2 (24.10.2026), lane kln: the Single App Mode (AppLock) profile template for supervised
// restaurant iPads and its renderer. Keys are checked against Apple's published schema
// (github.com/apple/device-management, mdm/profiles/com.apple.app.lock.yaml and TopLevel.yaml);
// the rendered file is parsed by Python's plistlib, a real plist parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KIOSK_BUNDLE_ID,
  PROFILE_TEMPLATE,
  renderKioskProfile,
} from '../../scripts/mobile/kiosk-applock-profile.mjs';

const script = fileURLToPath(
  new URL('../../scripts/mobile/kiosk-applock-profile.mjs', import.meta.url),
);
const template = readFileSync(PROFILE_TEMPLATE, 'utf8');
// Apple schema, iOS keys only (tvOS-only keys are not offered by the template).
const OPTIONS = [
  'DisableTouch',
  'DisableDeviceRotation',
  'DisableVolumeButtons',
  'DisableRingerSwitch',
  'DisableSleepWakeButton',
  'DisableAutoLock',
  'EnableVoiceOver',
  'EnableZoom',
  'EnableInvertColors',
  'EnableAssistiveTouch',
  'EnableSpeakSelection',
  'EnableMonoAudio',
  'EnableVoiceControl',
];
const USER_OPTIONS = ['VoiceOver', 'Zoom', 'InvertColors', 'AssistiveTouch', 'VoiceControl'];
const TOP_LEVEL = [
  'PayloadType',
  'PayloadVersion',
  'PayloadIdentifier',
  'PayloadUUID',
  'PayloadDisplayName',
  'PayloadDescription',
  'PayloadOrganization',
  'PayloadContent',
];
const APPLOCK = [
  'PayloadType',
  'PayloadVersion',
  'PayloadIdentifier',
  'PayloadUUID',
  'PayloadDisplayName',
  'App',
];

/** Parses a plist with Python's plistlib; booleans and integers keep their plist types. */
function plist(text) {
  const result = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      'import json, plistlib, sys; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))',
    ],
    { input: text, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `plistlib rejected the profile: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
const uuids = ['0f8a43c6-0d4a-4c51-9a8e-5d7f3e1c2b10', '7e1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'];
const fixedUuid = () => {
  let n = 0;
  return () => uuids[n++];
};

test('the template holds the kiosk bundle id and placeholders only, no secret or extra payload', () => {
  for (const placeholder of ['__PROFILE_UUID__', '__APPLOCK_UUID__', '__ORGANIZATION__'])
    assert.equal(template.split(placeholder).length, 2, placeholder);
  assert.deepEqual(template.match(/__[A-Z_]+__/g).sort(), [
    '__APPLOCK_UUID__',
    '__ORGANIZATION__',
    '__PROFILE_UUID__',
  ]);
  const profile = plist(template);
  assert.deepEqual(Object.keys(profile).sort(), [...TOP_LEVEL].sort());
  assert.equal(profile.PayloadType, 'Configuration');
  assert.equal(profile.PayloadVersion, 1);
  // A newer rendering replaces an installed one: the identifier never changes.
  assert.equal(profile.PayloadIdentifier, 'kz.pickchick.configuration.kiosk');
  assert.equal(profile.PayloadContent.length, 1);
  const lock = profile.PayloadContent[0];
  assert.deepEqual(Object.keys(lock).sort(), [...APPLOCK].sort());
  assert.equal(lock.PayloadType, 'com.apple.app.lock');
  assert.equal(lock.PayloadVersion, 1);
  assert.equal(lock.App.Identifier, KIOSK_BUNDLE_ID);
  assert.equal(KIOSK_BUNDLE_ID, 'kz.pickchick.kiosk');
  for (const key of Object.keys(lock.App.Options)) assert.ok(OPTIONS.includes(key), key);
  for (const key of Object.keys(lock.App.UserEnabledOptions))
    assert.ok(USER_OPTIONS.includes(key), key);
  for (const value of [
    ...Object.values(lock.App.Options),
    ...Object.values(lock.App.UserEnabledOptions),
  ])
    assert.equal(typeof value, 'boolean');
  // Touch stays on (a kiosk); rotation, sleep/wake and auto-lock are locked; accessibility stays.
  assert.deepEqual(lock.App.Options, {
    DisableTouch: false,
    DisableDeviceRotation: true,
    DisableSleepWakeButton: true,
    DisableAutoLock: true,
  });
  assert.deepEqual(lock.App.UserEnabledOptions, { VoiceOver: true, Zoom: true });
  assert.doesNotMatch(
    template,
    /Password|Passcode|PayloadCertificate|com\.apple\.wifi|com\.apple\.mdm|SSID|https?:\/\/(?!www\.apple\.com\/DTDs)|[–—]/i,
  );
});

test('rendering fills fresh payload UUIDs and an escaped organization name', () => {
  const organization = 'ТОО "Пик & Чик" <касса> $& $1';
  const text = renderKioskProfile(template, { organization, uuid: fixedUuid() });
  assert.doesNotMatch(text, /__[A-Z_]+__/);
  const profile = plist(text);
  assert.equal(profile.PayloadOrganization, organization);
  assert.equal(profile.PayloadUUID, uuids[0].toUpperCase());
  assert.equal(profile.PayloadContent[0].PayloadUUID, uuids[1].toUpperCase());
  assert.equal(profile.PayloadContent[0].App.Identifier, 'kz.pickchick.kiosk');
  // Random UUIDs by default, never the same twice.
  const a = plist(renderKioskProfile(template, { organization: 'PickChick' }));
  const b = plist(renderKioskProfile(template, { organization: 'PickChick' }));
  assert.notEqual(a.PayloadUUID, b.PayloadUUID);
  assert.notEqual(a.PayloadUUID, a.PayloadContent[0].PayloadUUID);
  assert.match(
    a.PayloadUUID,
    /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/,
  );
});

test('rendering refuses a missing or placeholder organization and a tampered template', () => {
  for (const organization of [
    undefined,
    '',
    '   ',
    '<название организации>',
    '__ORGANIZATION__',
    'Pick\nChick',
    'x'.repeat(121),
  ])
    assert.throws(() => renderKioskProfile(template, { organization }), /organization/i);
  assert.throws(
    () => renderKioskProfile(template.replace('__APPLOCK_UUID__', ''), { organization: 'A' }),
    /__APPLOCK_UUID__/,
  );
  assert.throws(
    () =>
      renderKioskProfile(template.replace('kz.pickchick.kiosk<', 'kz.example.other<'), {
        organization: 'A',
      }),
    /bundle id/,
  );
  assert.throws(
    () => renderKioskProfile(template, { organization: 'A', uuid: () => 'not-a-uuid' }),
    /UUID/,
  );
  const same = () => uuids[0];
  assert.throws(() => renderKioskProfile(template, { organization: 'A', uuid: same }), /UUID/);
});

test('the command writes the rendered profile and refuses to run without an organization', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosk-applock-'));
  try {
    const out = join(dir, 'kiosk.mobileconfig');
    const done = spawnSync(
      process.execPath,
      [script, '--organization', 'PickChick Test', '--out', out],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /kz\.pickchick\.kiosk/);
    const profile = plist(readFileSync(out));
    assert.equal(profile.PayloadOrganization, 'PickChick Test');
    const refused = spawnSync(process.execPath, [script, '--out', join(dir, 'x.mobileconfig')], {
      encoding: 'utf8',
    });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /organization/i);
    const unknown = spawnSync(process.execPath, [script, '--organization', 'A', '--force-all'], {
      encoding: 'utf8',
    });
    assert.notEqual(unknown.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
