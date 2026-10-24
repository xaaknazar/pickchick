// Stage 2 (24.10.2026), lane kln: the staff-only kiosk health line (build, API origin,
// commercial flag, staff code, last device presence) and the presence outcome behind it.
// Synthetic values only; no device credential ever reaches the health facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KIOSK_HEARTBEAT_STALE_MS,
  kioskHealthLines,
  openKioskHealth,
} from '../../apps/kiosk/src/kiosk-health.ts';
import { startDevicePresence } from '../../apps/kiosk/src/device-presence.ts';
import { KIOSK_PRODUCTION_API_URL, KIOSK_STAGING_API_URL } from '../../apps/kiosk/src/api.ts';
import { LOCALES } from '../../apps/kiosk/src/i18n.ts';

const now = Date.parse('2026-10-24T09:00:00Z');
const production = {
  version: '0.1.0',
  build: '24',
  releaseId: 'pk-0123456789abcdef',
  profile: 'production',
  apiOrigin: KIOSK_PRODUCTION_API_URL,
  commercial: true,
  staffCode: 'verified',
  heartbeat: { at: now - 12000, status: 200 },
  checkedAt: now,
};
const byId = (lines) => Object.fromEntries(lines.map((line) => [line.id, line]));
const tick = () => new Promise((r) => globalThis.setImmediate(r));
const device = JSON.stringify({
  deviceId: '00000000-0000-4000-8000-000000000001',
  key: 'b'.repeat(64),
});

test('a pinned production commercial kiosk shows every fact and needs no attention', () => {
  const lines = kioskHealthLines(production, 'ru');
  assert.deepEqual(
    lines.map((line) => line.id),
    ['build', 'api', 'commercial', 'staff', 'heartbeat'],
  );
  assert.deepEqual(
    lines.filter((line) => line.attention),
    [],
  );
  const l = byId(lines);
  assert.equal(l.build.label, 'Сборка');
  assert.equal(l.build.value, '0.1.0 (24), выпуск pk-0123456789abcdef');
  assert.equal(l.api.value, 'https://api.pickchick.kz (production)');
  assert.equal(l.commercial.value, 'включён');
  assert.equal(l.staff.value, 'настроен, сервер принял код');
  assert.equal(l.heartbeat.value, '12 с назад, принят');
});

test('development, staging and simulator builds are flagged for staff', () => {
  const l = byId(
    kioskHealthLines(
      {
        ...production,
        releaseId: null,
        profile: 'staging',
        apiOrigin: KIOSK_STAGING_API_URL,
        commercial: false,
        staffCode: 'not-required',
        heartbeat: null,
      },
      'ru',
    ),
  );
  for (const id of ['build', 'api', 'commercial', 'staff', 'heartbeat'])
    assert.equal(l[id].attention, true, id);
  assert.equal(l.build.value, '0.1.0 (24), без закреплённого выпуска');
  assert.equal(l.api.value, `${KIOSK_STAGING_API_URL} (staging)`);
  assert.equal(l.commercial.value, 'выключен - сборка без оплаты');
  assert.equal(l.staff.value, 'не нужен в этой сборке');
  assert.equal(l.heartbeat.value, 'не отправляется в этой сборке');
});

test('the last presence: none yet, refused, offline and stale need attention', () => {
  const heartbeat = (value) => byId(kioskHealthLines({ ...production, ...value }, 'ru')).heartbeat;
  assert.deepEqual(heartbeat({ heartbeat: null }), {
    id: 'heartbeat',
    label: 'Сигнал в центр устройств',
    value: 'ещё не отправлялся',
    attention: true,
  });
  // DEVICE_CENTER_ENABLED off or no gateway route: the API answers 404.
  assert.equal(
    heartbeat({ heartbeat: { at: now - 5000, status: 404 } }).value,
    '5 с назад, сервер ответил 404',
  );
  assert.equal(heartbeat({ heartbeat: { at: now - 5000, status: 404 } }).attention, true);
  assert.equal(
    heartbeat({ heartbeat: { at: now - 3 * 60000, status: null } }).value,
    '3 мин назад, нет связи',
  );
  const stale = heartbeat({
    heartbeat: { at: now - KIOSK_HEARTBEAT_STALE_MS - 1000, status: 200 },
  });
  assert.equal(stale.value, '61 с назад, принят');
  assert.equal(stale.attention, true);
  assert.equal(
    heartbeat({ heartbeat: { at: now - 5 * 3600000, status: 200 } }).value,
    '5 ч назад, принят',
  );
});

test('the health line is translated, keeps the hyphen rule and never shows credentials', () => {
  for (const locale of LOCALES) {
    for (const facts of [production, { ...production, heartbeat: { at: now, status: 503 } }]) {
      const lines = kioskHealthLines(facts, locale);
      for (const line of lines) {
        assert.ok(line.label.trim(), `${locale}.${line.id} label`);
        assert.ok(line.value.trim(), `${locale}.${line.id} value`);
        assert.doesNotMatch(line.label + line.value, /[–—{}]/, `${locale}.${line.id}`);
      }
      assert.doesNotMatch(JSON.stringify(lines), /b{64}|00000000-0000-4000/);
    }
  }
  const en = byId(kioskHealthLines(production, 'en'));
  assert.equal(en.heartbeat.value, '12 s ago, accepted');
  for (const line of Object.values(en))
    assert.doesNotMatch(line.label + line.value, /[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]/);
});

test('the health line opens only after the server accepts the staff code', async () => {
  let reads = 0;
  const facts = () => {
    reads++;
    return production;
  };
  const codes = [];
  const verifyStaff = async (pin) => {
    codes.push(pin);
    return pin === '482915';
  };
  assert.equal(await openKioskHealth({ verifyStaff, facts }, '111111'), null);
  assert.equal(await openKioskHealth({ verifyStaff, facts }), null);
  assert.equal(reads, 0, 'no fact is read behind a refused code');
  assert.deepEqual(codes, ['111111', '']);
  assert.equal(await openKioskHealth({ verifyStaff, facts }, '482915'), production);
  assert.equal(reads, 1);
  // The simulator build has no staff code: its health line is visible from the staff hold.
  assert.equal(await openKioskHealth({ facts }), production);
});

test('device presence reports each attempt outcome for the health line', async () => {
  const results = [];
  let answer = () => new Response('{}', { status: 200 });
  let clock = now;
  const worker = startDevicePresence({
    readDevice: async () => device,
    origin: 'https://example.test',
    appVersion: 'test',
    snapshot: () => ({ state: 'active', issue: 'none', menuVersion: 1 }),
    now: () => clock,
    onResult: (result) => results.push(result),
    fetcher: async () => answer(),
  });
  try {
    await tick();
    assert.deepEqual(results, [{ at: now, status: 200 }]);
    clock += 15000;
    answer = () => new Response('{"code":"NOT_FOUND"}', { status: 404 });
    await worker.send();
    clock += 15000;
    answer = () => {
      throw new Error('offline');
    };
    await worker.send();
    assert.deepEqual(results.slice(1), [
      { at: now + 15000, status: 404 },
      { at: now + 30000, status: null },
    ]);
    // A failing observer can never break presence.
    const quiet = startDevicePresence({
      readDevice: async () => device,
      origin: 'https://example.test',
      appVersion: 'test',
      snapshot: () => ({ state: 'active', issue: 'none', menuVersion: 1 }),
      onResult: () => {
        throw new Error('observer');
      },
      fetcher: async () => new Response('{}'),
    });
    await tick();
    await quiet.send();
    quiet.stop();
  } finally {
    worker.stop();
  }
});

test('no presence attempt without device credentials, so no heartbeat is invented', async () => {
  for (const data of [null, '{}', 'not-json']) {
    const results = [];
    const worker = startDevicePresence({
      readDevice: async () => data,
      origin: 'https://example.test',
      appVersion: 'test',
      snapshot: () => ({ state: 'active', issue: 'none', menuVersion: null }),
      onResult: (result) => results.push(result),
      fetcher: async () => new Response('{}'),
    });
    await tick();
    await worker.send();
    worker.stop();
    assert.deepEqual(results, []);
  }
});
