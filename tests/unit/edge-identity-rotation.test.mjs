import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadConfig } from '@pickchick/platform';
import { fixtureIds } from '@pickchick/test-fixtures';
import {
  edgeIdentityAutoRotate,
  identityExpiryStatus,
  IDENTITY_RENEWAL_THRESHOLD_MS,
} from '@pickchick/fulfillment-transport';
import {
  EDGE_IDENTITY_RENEWAL_WINDOW_SECONDS,
  EDGE_IDENTITY_OVERLAP_SECONDS,
  EDGE_IDENTITY_TTL_SECONDS,
} from '@pickchick/menu-sync';
import { edgeIdentityRotationGrants } from '../../infra/staging/edge-identity-rotation-grants.mjs';
import {
  IDENTITY_ROTATION_ORIGIN,
  parseRotationArgs,
  rotationExitCode,
  rotationLogEntry,
  rotationSettings,
} from '../../infra/windows/native-identity-rotation.mjs';
import { identityExpiryReport } from '../../infra/windows/native-fulfillment-worker.mjs';

const HOUR = 3600 * 1000,
  DAY = 24 * HOUR;
const at = (ms) => ({ expires_at: new Date(Date.UTC(2026, 9, 9) + ms).toISOString() });
const now = Date.UTC(2026, 9, 9);

test('expiry status: renewal starts inside the cloud window minus skew, critical under 3 days', () => {
  assert.equal(IDENTITY_RENEWAL_THRESHOLD_MS, EDGE_IDENTITY_RENEWAL_WINDOW_SECONDS * 1000 - HOUR);
  assert.ok(EDGE_IDENTITY_OVERLAP_SECONDS * 1000 < EDGE_IDENTITY_RENEWAL_WINDOW_SECONDS * 1000);
  assert.equal(EDGE_IDENTITY_TTL_SECONDS, 30 * 24 * 3600);
  for (const [remaining, state] of [
    [30 * DAY, 'ok'],
    [10 * DAY, 'ok'],
    [10 * DAY - HOUR + 1, 'ok'],
    [10 * DAY - HOUR - 1, 'renewal_due'],
    [3 * DAY, 'renewal_due'],
    [3 * DAY - 1, 'critical'],
    [1, 'critical'],
    [0, 'expired'],
    [-DAY, 'expired'],
  ])
    assert.equal(identityExpiryStatus(at(remaining), now).state, state, String(remaining));
  assert.equal(identityExpiryStatus(at(5.5 * DAY), now).daysRemaining, 5.5);
  assert.equal(identityExpiryStatus(at(DAY / 3), now).daysRemaining, 0.33);
  assert.equal(identityExpiryStatus(at(-DAY / 2), now).daysRemaining, -0.5);
  assert.throws(() => identityExpiryStatus({ expires_at: 'soon' }, now));
});

test('EDGE_IDENTITY_AUTO_ROTATE defaults off and accepts only true/false', () => {
  assert.equal(edgeIdentityAutoRotate({}), false);
  assert.equal(edgeIdentityAutoRotate({ EDGE_IDENTITY_AUTO_ROTATE: 'false' }), false);
  assert.equal(edgeIdentityAutoRotate({ EDGE_IDENTITY_AUTO_ROTATE: 'true' }), true);
  for (const value of ['1', 'TRUE', 'yes', '', ' true'])
    assert.throws(() => edgeIdentityAutoRotate({ EDGE_IDENTITY_AUTO_ROTATE: value }));
});

test('CLOUD_EDGE_IDENTITY_ROTATION_ENABLED defaults off and belongs to the cloud API only', () => {
  const env = {
    APP_ENV: 'test',
    CLOUD_DATABASE_URL: 'postgresql://localhost/pickchick_cloud',
    EDGE_DATABASE_URL: 'postgresql://localhost/pickchick_edge',
    EDGE_BRANCH_ID: fixtureIds.branch,
    REDIS_URL: 'redis://localhost:6379',
  };
  assert.equal(loadConfig('api', env).edgeIdentityRotationEnabled, undefined);
  const off = { ...env, CLOUD_EDGE_IDENTITY_ROTATION_ENABLED: 'false' };
  assert.equal(loadConfig('api', off).edgeIdentityRotationEnabled, undefined);
  const on = { ...env, CLOUD_EDGE_IDENTITY_ROTATION_ENABLED: 'true' };
  assert.equal(loadConfig('api', on).edgeIdentityRotationEnabled, true);
  assert.throws(() => loadConfig('edge', on), /CLOUD_EDGE_IDENTITY_ROTATION_ENABLED/);
  assert.equal(loadConfig('edge', off).edgeIdentityRotationEnabled, undefined);
  for (const value of ['1', 'yes', 'TRUE', ''])
    assert.throws(() => loadConfig('api', { ...env, CLOUD_EDGE_IDENTITY_ROTATION_ENABLED: value }));
});

test('rotation grants: off revokes everything they add; on is column-scoped and never device authority', () => {
  for (const role of ['', 'Bad', 'x;drop', '1role'])
    assert.throws(() => edgeIdentityRotationGrants(role, true));
  assert.throws(() => edgeIdentityRotationGrants('pickchick_app', 'true'));
  const off = edgeIdentityRotationGrants('pickchick_app', false);
  assert.doesNotMatch(off, /\bGRANT\b/);
  assert.match(off, /REVOKE ALL ON device_identity_rotations FROM pickchick_app/);
  assert.match(
    off,
    /REVOKE UPDATE\(token_hash,expires_at,issued_at,previous_token_hash,previous_expires_at\) ON device_credentials/,
  );
  const on = edgeIdentityRotationGrants('pickchick_app', true);
  assert.ok(on.startsWith(off), 'enabled grants are applied on top of a clean revoke');
  const granted = on.slice(off.length);
  assert.match(granted, /GRANT SELECT, INSERT ON device_identity_rotations TO pickchick_app/);
  assert.match(granted, /GRANT UPDATE\(confirmed_at, replay_count\) ON device_identity_rotations/);
  assert.doesNotMatch(granted, /\bdevices\b|DELETE|TRUNCATE|device_audit|\bALL\b|status|branch_id/);
  assert.doesNotMatch(granted, /UPDATE ON|INSERT[^;]*device_credentials/);
  const provision = readFileSync(
    new URL('../../infra/staging/provision.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    provision,
    /edgeIdentityRotationGrants\('pickchick_app', config\.edgeIdentityRotationEnabled === true\)/,
  );
  const compose = readFileSync(
    new URL('../../infra/staging/compose.yaml', import.meta.url),
    'utf8',
  );
  assert.equal(
    compose.split(
      'CLOUD_EDGE_IDENTITY_ROTATION_ENABLED: ${CLOUD_EDGE_IDENTITY_ROTATION_ENABLED:-false}\n',
    ).length,
    3,
    'api and provision both default off',
  );
});

test('Windows rotation task accepts only protected identity paths, explicit scope and a log file', () => {
  const branch = randomUUID(),
    device = randomUUID();
  const primary = 'C:\\ProgramData\\PickChick\\FulfillmentWorker\\device-identity.json';
  const mirror = 'C:\\ProgramData\\PickChick\\PosSync\\service\\device-identity.json';
  const log = 'C:\\ProgramData\\PickChick\\IdentityRotation\\logs\\rotation.log';
  assert.deepEqual(parseRotationArgs([primary, branch, device, '--mirror', mirror, '--log', log]), {
    identityPath: primary,
    branchId: branch,
    deviceId: device,
    mirrors: [mirror],
    logPath: log,
  });
  assert.deepEqual(parseRotationArgs([primary, branch, device, '--log', log]).mirrors, []);
  for (const argv of [
    [primary, branch, device],
    [primary, branch, device, '--log', 'rotation.log'],
    [primary, branch, device, '--log', 'C:\\logs\\rotation.txt'],
    [primary, branch, device, '--log', log, '--log', log],
    [primary, branch, device, '--log', log, '--once'],
    [primary, branch, device, '--mirror', primary, '--log', log],
    [primary, branch, device, '--mirror', primary.toUpperCase(), '--log', log],
    [primary, branch, 'device', '--log', log],
    [primary, 'branch', device, '--log', log],
    ['C:\\ProgramData\\PickChick\\FulfillmentWorker\\identity.json', branch, device, '--log', log],
    ['device-identity.json', branch, device, '--log', log],
    ['C:\\ProgramData\\..\\device-identity.json', branch, device, '--log', log],
    ['\\\\server\\share\\device-identity.json', branch, device, '--log', log],
    ['C:\\x\\y:z\\device-identity.json', branch, device, '--log', log],
    [
      primary,
      branch,
      device,
      '--mirror',
      'D:\\a\\device-identity.json',
      '--mirror',
      'D:\\b\\device-identity.json',
      '--mirror',
      'D:\\c\\device-identity.json',
      '--mirror',
      'D:\\d\\device-identity.json',
      '--log',
      log,
    ],
  ])
    assert.throws(() => parseRotationArgs(argv), /invocation differs/, argv.join(' '));
  const flag = (env) => env.EDGE_IDENTITY_AUTO_ROTATE === 'true';
  assert.deepEqual(rotationSettings({}, flag), {
    enabled: false,
    origin: IDENTITY_ROTATION_ORIGIN,
  });
  assert.equal(rotationSettings({ EDGE_IDENTITY_AUTO_ROTATE: 'true' }, flag).enabled, true);
  for (const origin of [
    'http://127.0.0.1:3100',
    'https://api.example.invalid',
    'http://127.0.0.1:43100/',
  ])
    assert.throws(() =>
      rotationSettings(
        { EDGE_IDENTITY_AUTO_ROTATE: 'true', EDGE_IDENTITY_ROTATION_ORIGIN: origin },
        flag,
      ),
    );
});

test('rotation status lines are whitelisted and exit codes flag operator attention', () => {
  const entry = rotationLogEntry(
    {
      state: 'rotated',
      daysRemaining: 29.99,
      expiresAt: '2026-11-08T00:00:00.000Z',
      replayed: false,
      mirrors: ['replaced'],
      token: 'a'.repeat(64),
      rotation_id: randomUUID(),
      path: 'C:\\secret',
    },
    new Date(now),
  );
  assert.deepEqual(entry, {
    event: 'edge_identity_rotation',
    at: '2026-10-09T00:00:00.000Z',
    state: 'rotated',
    days_remaining: 29.99,
    expires_at: '2026-11-08T00:00:00.000Z',
    replayed: false,
    mirrors: ['replaced'],
  });
  for (const state of ['not_due', 'rotated', 'busy', 'disabled'])
    assert.equal(rotationExitCode(state), 0);
  for (const state of ['retry', 'refused', 'unauthorized', 'blocked', 'failed'])
    assert.equal(rotationExitCode(state), 1);
});

test('fulfillment worker reports identity expiry on start and when state or whole day changes', () => {
  const first = identityExpiryReport(identityExpiryStatus(at(12.4 * DAY), now), undefined);
  assert.deepEqual(first.entry, {
    event: 'edge_identity',
    state: 'ok',
    days_remaining: 12.4,
    expires_at: at(12.4 * DAY).expires_at,
  });
  assert.equal(identityExpiryReport(identityExpiryStatus(at(12.1 * DAY), now), first.key), null);
  const nextDay = identityExpiryReport(identityExpiryStatus(at(11.9 * DAY), now), first.key);
  assert.equal(nextDay.entry.days_remaining, 11.9);
  const due = identityExpiryReport(identityExpiryStatus(at(9.5 * DAY), now), nextDay.key);
  assert.equal(due.entry.state, 'renewal_due');
  assert.equal(JSON.stringify(due).includes('token'), false);
});

test('the Windows runtime ships the rotation task and its ACL helper', () => {
  const builder = readFileSync(
    new URL('../../scripts/build-windows-edge-runtime.py', import.meta.url),
    'utf8',
  );
  for (const file of ['native-identity-rotation.mjs', 'native-identity-acl.ps1'])
    assert.match(builder, new RegExp(`'infra/windows/${file.replace('.', '\\.')}'`));
});
