import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWatchdogConfig, parseQuietHours } from '../../infra/staging/watchdog/config.mjs';
import { parseHostFacts } from '../../infra/staging/watchdog/host-facts.mjs';
import { aggregateWorkerEvents, evaluate } from '../../infra/staging/watchdog/checks.mjs';
import {
  emptyState,
  normalizeState,
  planNotifications,
  summaryDue,
} from '../../infra/staging/watchdog/dedup.mjs';
import { chunk, renderEvents, renderSummary } from '../../infra/staging/watchdog/messages.mjs';
import { probeApi } from '../../infra/staging/watchdog/api-probe.mjs';
import { sendTelegram } from '../../infra/staging/watchdog/telegram.mjs';
import { databaseErrorCode } from '../../infra/staging/watchdog/queries.mjs';
import { parseArgs, runWatchdog } from '../../infra/staging/watchdog/main.mjs';

// Synthetic placeholders only; the tests prove these never leak into output.
const DB_PASSWORD = '0123456789abcdef'.repeat(4);
const BOT_TOKEN = '000000:TEST_ONLY_not_a_real_bot_token_xxxxxxxx';
const NOW = Date.parse('2026-10-09T06:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const env = (extra = {}) => ({
  WATCHDOG_DB_PASSWORD: DB_PASSWORD,
  WATCHDOG_TIMEZONE: 'UTC',
  ...extra,
});
const config = (extra) => loadWatchdogConfig(env(extra));
const running = (startedAt = iso(NOW - 2 * DAY)) => ({
  present: true,
  status: 'running',
  running: true,
  health: null,
  restarts: 0,
  startedAt,
});
function hostFacts(overrides = {}) {
  return {
    version: 1,
    collectedAt: iso(NOW - MIN),
    logWindowSeconds: 600,
    collectorErrors: [],
    containers: {
      'kaspi-bridge': { ...running(), health: 'healthy' },
      'kaspi-remote-worker': running(),
      'kiosk-qr-worker': running(),
    },
    workerEvents: { 'kaspi-remote-worker': [], 'kiosk-qr-worker': [] },
    disks: [{ path: '/', usedPercent: 42.5, sizeBytes: 200 * 2 ** 30, availBytes: 115 * 2 ** 30 }],
    backups: {
      files: [
        {
          name: 'cloud-20261009T021500Z.dump.age',
          mtime: iso(NOW - 3 * HOUR),
          sizeBytes: 5_000_000,
          checksum: true,
        },
      ],
    },
    kaspiSessionProbe: null,
    ...overrides,
  };
}
function dbFacts(overrides = {}) {
  return {
    now: iso(NOW),
    identities: [
      {
        deviceId: 'd1',
        kind: 'edge',
        name: 'Касса 1',
        expiresAt: iso(NOW + 20 * DAY),
        remainingSeconds: 20 * 86_400,
      },
    ],
    heartbeats: [
      {
        branchId: 'b1',
        deviceId: 'd1',
        name: 'Касса 1',
        observedAt: iso(NOW - 5000),
        ageSeconds: 5,
      },
    ],
    unknownOverdue: { 'kaspi-remote-worker': 0, 'kiosk-qr-worker': 0 },
    paymentBacklog: { 'kaspi-remote-worker': 0, 'kiosk-qr-worker': 0 },
    ...overrides,
  };
}
const API_OK = { ok: true, status: 200, error: null, dependencies: null };
function run({
  api = API_OK,
  host = hostFacts(),
  db = dbFacts(),
  cfg = config(),
  nowMs = NOW,
} = {}) {
  return evaluate({
    api,
    host:
      typeof host === 'string'
        ? parseHostFacts(host, nowMs, 15 * MIN)
        : parseHostFacts(JSON.stringify(host), nowMs, 15 * MIN),
    db: db && db.ok === false ? db : { ok: true, facts: db },
    config: cfg,
    nowMs,
  });
}
const find = (evaluation, key) => evaluation.findings.find((finding) => finding.key === key);

test('config defaults keep Telegram off and validate thresholds without echoing values', () => {
  const cfg = config();
  assert.equal(cfg.telegram.enabled, false);
  assert.equal(cfg.identityWarnDays, 7);
  assert.equal(cfg.backupMaxAgeHours, 26);
  assert.equal(cfg.disk.warnPercent, 85);
  assert.equal(cfg.dailySummary.enabled, false);
  assert.equal(cfg.db.user, 'pickchick_watchdog');
  for (const [name, value] of [
    ['WATCHDOG_DB_PASSWORD', 'short'],
    ['WATCHDOG_TELEGRAM_ENABLED', 'yes'],
    ['WATCHDOG_DISK_WARN_PERCENT', '101'],
    ['WATCHDOG_DISK_CRITICAL_PERCENT', '80'],
    ['WATCHDOG_RENOTIFY_MINUTES', '1'],
    ['WATCHDOG_TIMEZONE', 'Mars/Base'],
    ['WATCHDOG_API_READY_URL', 'http://user:pass@api:3100/health/ready'],
    ['WATCHDOG_HEARTBEAT_QUIET_HOURS', '25:00-08:00'],
    ['WATCHDOG_LABEL', 'x'.repeat(41)],
  ])
    assert.throws(
      () => config({ [name]: value }),
      (error) => error.variable === name && !error.message.includes(value),
    );
  assert.throws(
    () => config({ WATCHDOG_TELEGRAM_ENABLED: 'true', WATCHDOG_TELEGRAM_CHAT_ID: '-100123' }),
    (error) => error.variable === 'WATCHDOG_TELEGRAM_BOT_TOKEN',
  );
  const enabled = config({
    WATCHDOG_TELEGRAM_ENABLED: 'true',
    WATCHDOG_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    WATCHDOG_TELEGRAM_CHAT_ID: '-1001234567890',
  });
  assert.equal(enabled.telegram.chatId, '-1001234567890');
  assert.deepEqual(parseQuietHours('23:30-08:30'), { start: '23:30', end: '08:30' });
  assert.equal(parseQuietHours(''), null);
});

test('host facts keep only whitelisted worker fields and report stale or broken files', () => {
  const facts = hostFacts({
    workerEvents: {
      'kaspi-remote-worker': [
        {
          at: iso(NOW - 2 * MIN),
          event: 'kaspi_remote_attention',
          sessionRejected: true,
          unknownOverdue: 1,
          errors: 2,
          phone: '+77000000000',
          token: 'secret',
        },
        { at: iso(NOW - MIN), event: 'unrelated_event', errors: 9 },
        { at: 'yesterday', event: 'kaspi_remote_failed' },
      ],
      'kiosk-qr-worker': [{ at: iso(NOW - MIN), event: 'kaspi_remote_attention', errors: 1 }],
    },
  });
  const parsed = parseHostFacts(JSON.stringify(facts), NOW, 15 * MIN);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.facts.workerEvents['kaspi-remote-worker'], [
    {
      at: iso(NOW - 2 * MIN),
      event: 'kaspi_remote_attention',
      errors: 2,
      unknownOverdue: 1,
      sessionProblem: true,
    },
  ]);
  assert.deepEqual(parsed.facts.workerEvents['kiosk-qr-worker'], []);
  assert.doesNotMatch(JSON.stringify(parsed), /secret|\+7700/);
  assert.deepEqual(parseHostFacts('', NOW, 15 * MIN), { ok: false, reason: 'missing' });
  assert.deepEqual(parseHostFacts('{not json', NOW, 15 * MIN), { ok: false, reason: 'invalid' });
  assert.deepEqual(
    parseHostFacts(JSON.stringify(hostFacts({ collectedAt: iso(NOW - 20 * MIN) })), NOW, 15 * MIN),
    { ok: false, reason: 'stale' },
  );
});

test('healthy facts produce no failing finding', () => {
  const evaluation = run();
  assert.deepEqual(
    evaluation.findings.filter((finding) => finding.status !== 'ok').map((finding) => finding.key),
    [],
  );
  assert.equal(evaluation.unavailable.size, 0);
  for (const key of [
    'api.ready',
    'container.kaspi-bridge',
    'container.kaspi-remote-worker',
    'container.kiosk-qr-worker',
    'kaspi.session',
    'worker.kaspi-remote-worker.errors',
    'worker.kiosk-qr-worker.unknown',
    'worker.kaspi-remote-worker.backlog',
    'edge.heartbeat.d1',
    'device.identity.d1',
    'backup.age',
    'disk./',
  ])
    assert.ok(find(evaluation, key), key);
});

test('API readiness failure is critical, needs confirmation and lists only dependency states', () => {
  const failing = find(
    run({
      api: {
        ok: false,
        status: 503,
        error: null,
        dependencies: { database: 'down', schema: 'up' },
      },
    }),
    'api.ready',
  );
  assert.equal(failing.status, 'fail');
  assert.equal(failing.severity, 'critical');
  assert.equal(failing.confirmRuns, 2);
  assert.match(failing.detail, /HTTP 503 \(database=down, schema=up\)/);
  assert.match(
    find(run({ api: { ok: false, status: null, error: 'timeout' } }), 'api.ready').detail,
    /нет ответа/,
  );
});

test('API probe parses readiness bodies and maps network failures', async () => {
  const ready = await probeApi(
    'http://api/health/ready',
    async () =>
      new Response(
        JSON.stringify({
          service: 'api',
          ready: true,
          degraded: false,
          dependencies: { database: 'up', schema: 'up', redis: 'up' },
        }),
        { status: 200 },
      ),
  );
  assert.equal(ready.ok, true);
  const down = await probeApi(
    'http://api/health/ready',
    async () =>
      new Response(
        JSON.stringify({
          ready: false,
          dependencies: { database: 'down', schema: 'up', redis: 'secret-ish' },
        }),
        { status: 503 },
      ),
  );
  assert.deepEqual(down, {
    ok: false,
    status: 503,
    error: null,
    dependencies: { database: 'down', schema: 'up' },
  });
  const refused = await probeApi('http://api/health/ready', async () => {
    throw new TypeError('fetch failed');
  });
  assert.equal(refused.error, 'unreachable');
});

test('containers: missing, stopped and unhealthy are critical; unexpected absent ones are ignored', () => {
  const host = hostFacts();
  host.containers['kaspi-bridge'] = { ...running(), health: 'unhealthy' };
  host.containers['kaspi-remote-worker'] = { present: false };
  host.containers['kiosk-qr-worker'] = {
    ...running(),
    status: 'restarting',
    running: false,
    restarts: 7,
  };
  const evaluation = run({ host });
  assert.match(find(evaluation, 'container.kaspi-bridge').detail, /unhealthy/);
  assert.match(find(evaluation, 'container.kaspi-remote-worker').detail, /не найден/);
  assert.match(find(evaluation, 'container.kiosk-qr-worker').detail, /restarting, перезапусков 7/);
  for (const key of [
    'container.kaspi-bridge',
    'container.kaspi-remote-worker',
    'container.kiosk-qr-worker',
  ]) {
    assert.equal(find(evaluation, key).severity, 'critical');
    assert.equal(find(evaluation, key).confirmRuns, 2);
  }
  const optional = hostFacts();
  optional.containers['kiosk-qr-worker'] = { present: false };
  const relaxed = run({
    host: optional,
    cfg: config({ WATCHDOG_EXPECT_KIOSK_QR_WORKER: 'false' }),
  });
  assert.equal(find(relaxed, 'container.kiosk-qr-worker'), undefined);
  assert.equal(find(relaxed, 'worker.kiosk-qr-worker.errors'), undefined);
});

test('Kaspi session uses worker-reported state and the optional existing session-check result', () => {
  const remote = hostFacts({
    workerEvents: {
      'kaspi-remote-worker': [
        {
          at: iso(NOW - 3 * MIN),
          event: 'kaspi_remote_attention',
          sessionRejected: true,
          unknownOverdue: 0,
          errors: 0,
        },
      ],
      'kiosk-qr-worker': [],
    },
  });
  const failing = find(run({ host: remote }), 'kaspi.session');
  assert.equal(failing.status, 'fail');
  assert.equal(failing.severity, 'critical');
  assert.match(failing.detail, /Kaspi worker счетов сообщил о проблеме сессии.*kaspi-login\.mjs/);
  const kiosk = hostFacts({
    workerEvents: {
      'kaspi-remote-worker': [],
      'kiosk-qr-worker': [
        { at: iso(NOW - MIN), event: 'kiosk_kaspi_qr', state: 'no_cashier_session' },
      ],
    },
  });
  assert.equal(find(run({ host: kiosk }), 'kaspi.session').status, 'fail');
  const probeDead = hostFacts({
    kaspiSessionProbe: { checkedAt: iso(NOW - HOUR), active: false, reason: 'not_verified' },
  });
  assert.match(
    find(run({ host: probeDead }), 'kaspi.session').detail,
    /session-check\.mjs.*not_verified/,
  );
  const probeAlive = hostFacts({
    kaspiSessionProbe: { checkedAt: iso(NOW - HOUR), active: true, reason: 'verified' },
  });
  assert.match(find(run({ host: probeAlive }), 'kaspi.session').detail, /активна/);
  const unknownProbe = hostFacts({
    kaspiSessionProbe: { checkedAt: iso(NOW - HOUR), active: null, reason: 'probe_failed' },
  });
  assert.equal(find(run({ host: unknownProbe }), 'kaspi.session').status, 'ok');
  assert.match(find(run(), 'kaspi.session').detail, /не проверялась/);
});

test('worker errors need confirmation, unknown invoices are critical from DB or logs', () => {
  const events = [
    {
      at: iso(NOW - 8 * MIN),
      event: 'kaspi_remote_attention',
      sessionRejected: false,
      unknownOverdue: 2,
      errors: 1,
    },
    { at: iso(NOW - 2 * MIN), event: 'kaspi_remote_failed', retrying: true },
  ];
  assert.deepEqual(
    aggregateWorkerEvents(
      parseHostFacts(
        JSON.stringify(
          hostFacts({ workerEvents: { 'kaspi-remote-worker': events, 'kiosk-qr-worker': [] } }),
        ),
        NOW,
        15 * MIN,
      ).facts.workerEvents['kaspi-remote-worker'],
    ),
    {
      sessionProblemAt: null,
      errorEvents: 2,
      unknownOverdue: 2,
      disabled: false,
      events: 2,
    },
  );
  const evaluation = run({
    host: hostFacts({ workerEvents: { 'kaspi-remote-worker': events, 'kiosk-qr-worker': [] } }),
  });
  const errors = find(evaluation, 'worker.kaspi-remote-worker.errors');
  assert.equal(errors.status, 'fail');
  assert.equal(errors.severity, 'warning');
  assert.equal(errors.confirmRuns, 2);
  assert.match(errors.detail, /событий с ошибками за 10 мин: 2/);
  // DB reports 0 but the worker log still shows 2: the larger value wins.
  assert.match(
    find(evaluation, 'worker.kaspi-remote-worker.unknown').detail,
    /issuing\/unknown дольше 5 мин: 2\./,
  );
  const fromDb = run({
    db: dbFacts({ unknownOverdue: { 'kaspi-remote-worker': 0, 'kiosk-qr-worker': 3 } }),
  });
  const qr = find(fromDb, 'worker.kiosk-qr-worker.unknown');
  assert.equal(qr.severity, 'critical');
  assert.match(qr.detail, /дольше 5 мин: 3\. .*повторный счёт не создавать/);
  const noDb = run({ db: { ok: false, code: 'connection_failed' } });
  assert.equal(find(noDb, 'worker.kiosk-qr-worker.unknown').status, 'skip');
  const disabled = run({
    host: hostFacts({
      workerEvents: {
        'kaspi-remote-worker': [],
        'kiosk-qr-worker': [{ at: iso(NOW - MIN), event: 'kiosk_kaspi_qr', state: 'disabled' }],
      },
    }),
  });
  assert.match(find(disabled, 'worker.kiosk-qr-worker.errors').detail, /disabled/);
});

test('payment backlog warns when Kaspi submissions wait for the bank', () => {
  const evaluation = run({
    db: dbFacts({ paymentBacklog: { 'kaspi-remote-worker': 2, 'kiosk-qr-worker': 0 } }),
  });
  const backlog = find(evaluation, 'worker.kaspi-remote-worker.backlog');
  assert.equal(backlog.status, 'fail');
  assert.equal(backlog.severity, 'warning');
  assert.match(backlog.detail, /заказов ждут счёта дольше 3 мин: 2\./);
  assert.equal(find(evaluation, 'worker.kiosk-qr-worker.backlog').status, 'ok');
});

test('edge heartbeat: never seen and stale are critical, quiet hours skip (also across midnight)', () => {
  const stale = run({
    db: dbFacts({
      heartbeats: [
        {
          branchId: 'b1',
          deviceId: 'd1',
          name: 'Касса 1',
          observedAt: iso(NOW - 25 * MIN),
          ageSeconds: 1500,
        },
        { branchId: 'b2', deviceId: 'd2', name: 'Касса 2', observedAt: null, ageSeconds: null },
        {
          branchId: 'b3',
          deviceId: 'd3',
          name: 'Касса 3',
          observedAt: iso(NOW - 9 * MIN),
          ageSeconds: 540,
        },
      ],
    }),
  });
  assert.match(find(stale, 'edge.heartbeat.d1').detail, /25 мин назад.*лимит 10 мин/);
  assert.equal(find(stale, 'edge.heartbeat.d1').severity, 'critical');
  assert.match(find(stale, 'edge.heartbeat.d2').detail, /ещё не передавала/);
  assert.equal(find(stale, 'edge.heartbeat.d3').status, 'ok');
  // NOW is 06:00 UTC.
  const quiet = run({
    cfg: config({ WATCHDOG_HEARTBEAT_QUIET_HOURS: '23:30-06:30' }),
    db: dbFacts({
      heartbeats: [
        { branchId: 'b1', deviceId: 'd1', name: 'Касса 1', observedAt: null, ageSeconds: null },
      ],
    }),
  });
  assert.equal(find(quiet, 'edge.heartbeat.d1').status, 'skip');
  const after = run({
    cfg: config({ WATCHDOG_HEARTBEAT_QUIET_HOURS: '23:30-05:59' }),
    db: dbFacts({
      heartbeats: [
        { branchId: 'b1', deviceId: 'd1', name: 'Касса 1', observedAt: null, ageSeconds: null },
      ],
    }),
  });
  assert.equal(find(after, 'edge.heartbeat.d1').status, 'fail');
  const daytime = run({
    cfg: config({ WATCHDOG_HEARTBEAT_QUIET_HOURS: '05:00-07:00' }),
    db: dbFacts({
      heartbeats: [
        { branchId: 'b1', deviceId: 'd1', name: 'Касса 1', observedAt: null, ageSeconds: null },
      ],
    }),
  });
  assert.equal(find(daytime, 'edge.heartbeat.d1').status, 'skip');
});

test('device identity: warning under 7 days, critical once expired', () => {
  const evaluation = run({
    db: dbFacts({
      identities: [
        {
          deviceId: 'd1',
          kind: 'edge',
          name: 'Касса 1',
          expiresAt: iso(NOW + 3 * DAY),
          remainingSeconds: 3 * 86_400,
        },
        {
          deviceId: 'd2',
          kind: 'pos',
          name: 'Касса 2',
          expiresAt: iso(NOW - HOUR),
          remainingSeconds: -3600,
        },
        {
          deviceId: 'd3',
          kind: 'edge',
          name: 'Касса 3',
          expiresAt: iso(NOW + 7 * DAY + MIN),
          remainingSeconds: 7 * 86_400 + 60,
        },
      ],
    }),
  });
  assert.equal(find(evaluation, 'device.identity.d1').severity, 'warning');
  assert.match(find(evaluation, 'device.identity.d1').detail, /через 3 дн/);
  assert.equal(find(evaluation, 'device.identity.d2').severity, 'critical');
  assert.match(find(evaluation, 'device.identity.d2').detail, /срок истёк/);
  assert.equal(find(evaluation, 'device.identity.d3').status, 'ok');
});

test('backup age uses only completed encrypted copies and the 26 hour limit', () => {
  const file = (ageMs, extra = {}) => ({
    name: 'cloud-20261008T021500Z.dump.age',
    mtime: iso(NOW - ageMs),
    sizeBytes: 1000,
    checksum: true,
    ...extra,
  });
  const backups = (files) => run({ host: hostFacts({ backups: { files } }) });
  assert.equal(find(backups([file(25 * HOUR)]), 'backup.age').status, 'ok');
  const old = find(backups([file(27 * HOUR)]), 'backup.age');
  assert.equal(old.severity, 'critical');
  assert.match(old.detail, /27 ч назад.*лимит 26 ч/);
  // A fresh file without its .sha256 (or empty) is not a completed backup.
  assert.match(
    find(backups([file(HOUR, { checksum: false }), file(HOUR, { sizeBytes: 0 })]), 'backup.age')
      .detail,
    /нет ни одной/,
  );
  assert.match(
    find(run({ host: hostFacts({ backups: { error: 'unavailable', files: [] } }) }), 'backup.age')
      .detail,
    /недоступен/,
  );
});

test('disk usage: warning above 85%, critical above 95%, unreadable is reported', () => {
  const evaluation = run({
    host: hostFacts({
      disks: [
        { path: '/', usedPercent: 85, sizeBytes: 100, availBytes: 15 },
        { path: '/var/lib/docker', usedPercent: 86.2, sizeBytes: 100, availBytes: 14 },
        { path: '/opt/pickchick-staging/backups', usedPercent: 96, sizeBytes: 100, availBytes: 4 },
        { path: '/srv', error: 'unavailable' },
      ],
    }),
  });
  assert.equal(find(evaluation, 'disk./').status, 'ok');
  assert.equal(find(evaluation, 'disk./var/lib/docker').severity, 'warning');
  assert.equal(find(evaluation, 'disk./opt/pickchick-staging/backups').severity, 'critical');
  assert.match(find(evaluation, 'disk./srv').detail, /не удалось/);
});

test('unreadable sources mark themselves unavailable instead of producing false findings', () => {
  const missing = run({ host: '' });
  assert.deepEqual([...missing.unavailable].sort(), ['docker', 'host', 'logs']);
  assert.match(find(missing, 'watchdog.host').detail, /отсутствуют/);
  assert.equal(find(missing, 'backup.age'), undefined);
  assert.equal(find(missing, 'container.kaspi-bridge'), undefined);
  const noDocker = run({
    host: hostFacts({ collectorErrors: ['docker_unavailable'], containers: {} }),
  });
  assert.deepEqual([...noDocker.unavailable].sort(), ['docker', 'logs']);
  assert.equal(find(noDocker, 'container.kaspi-bridge'), undefined);
  assert.equal(find(noDocker, 'backup.age').status, 'ok');
  const noDb = run({ db: { ok: false, code: 'authentication_failed' } });
  assert.match(find(noDb, 'watchdog.database').detail, /authentication_failed/);
  assert.equal(find(noDb, 'edge.heartbeat.d1'), undefined);
  assert.equal(
    databaseErrorCode({ code: '28P01', message: 'password authentication failed for user x' }),
    'authentication_failed',
  );
  assert.equal(databaseErrorCode({ code: 'ECONNREFUSED' }), 'connection_failed');
  assert.equal(databaseErrorCode({ code: '42501' }), 'permission_denied');
});

const finding = (key, status, severity = 'critical', confirmRuns = 1, source = 'db') => ({
  key,
  source,
  title: key,
  status,
  severity,
  detail: `${key} ${status}`,
  confirmRuns,
});
const plan = (state, findings, nowMs, unavailable = new Set()) =>
  planNotifications(state, { findings, unavailable }, nowMs, { renotifyMinutes: 120 });

test('de-dup: alert after confirmation, reminder after the interval, one recovery', () => {
  let state = emptyState('telegram');
  let result = plan(state, [finding('api.ready', 'fail', 'critical', 2, 'api')], NOW);
  assert.deepEqual(result.events, []);
  result = plan(result.state, [finding('api.ready', 'fail', 'critical', 2, 'api')], NOW + 5 * MIN);
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ['alert'],
  );
  assert.equal(result.events[0].since, NOW);
  state = result.state;
  for (const offset of [10, 60, 124]) {
    result = plan(state, [finding('api.ready', 'fail', 'critical', 2, 'api')], NOW + offset * MIN);
    assert.deepEqual(result.events, [], `no repeat at +${offset} min`);
    state = result.state;
  }
  result = plan(state, [finding('api.ready', 'fail', 'critical', 2, 'api')], NOW + 125 * MIN);
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ['reminder'],
  );
  result = plan(result.state, [finding('api.ready', 'ok', 'warning', 1, 'api')], NOW + 130 * MIN);
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ['recovery'],
  );
  assert.deepEqual(result.state.checks, {});
  assert.deepEqual(
    plan(result.state, [finding('api.ready', 'ok', 'warning', 1, 'api')], NOW + 135 * MIN).events,
    [],
  );
});

test('de-dup: an unconfirmed blip never notifies; escalation notifies once; skip keeps state', () => {
  let result = plan(
    emptyState('telegram'),
    [finding('container.x', 'fail', 'critical', 2, 'docker')],
    NOW,
  );
  result = plan(
    result.state,
    [finding('container.x', 'ok', 'warning', 2, 'docker')],
    NOW + 5 * MIN,
  );
  assert.deepEqual(result.events, []);
  result = plan(emptyState('telegram'), [finding('device.identity.d1', 'fail', 'warning')], NOW);
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ['alert'],
  );
  result = plan(result.state, [finding('device.identity.d1', 'fail', 'critical')], NOW + 5 * MIN);
  assert.deepEqual(
    result.events.map((event) => [event.kind, event.severity]),
    [['escalation', 'critical']],
  );
  result = plan(result.state, [finding('device.identity.d1', 'fail', 'critical')], NOW + 10 * MIN);
  assert.deepEqual(result.events, []);
  const kept = plan(result.state, [finding('device.identity.d1', 'skip')], NOW + 15 * MIN);
  assert.deepEqual(kept.events, []);
  assert.deepEqual(kept.state.checks, result.state.checks);
});

test('de-dup: vanished checks resolve only when their source was readable', () => {
  const open = plan(emptyState('telegram'), [finding('edge.heartbeat.d1', 'fail')], NOW).state;
  const unreadable = plan(open, [], NOW + 5 * MIN, new Set(['db']));
  assert.deepEqual(unreadable.events, []);
  assert.deepEqual(unreadable.state.checks, open.checks);
  const removed = plan(open, [], NOW + 5 * MIN);
  assert.deepEqual(
    removed.events.map((event) => event.kind),
    ['resolved'],
  );
  assert.deepEqual(removed.state.checks, {});
});

test('state normalization drops garbage and restarts when the delivery mode changes', () => {
  const open = plan(
    emptyState('print'),
    [finding('backup.age', 'fail', 'critical', 1, 'host')],
    NOW,
  ).state;
  assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(open)), 'print').checks, open.checks);
  assert.deepEqual(normalizeState(open, 'telegram'), emptyState('telegram'));
  assert.deepEqual(normalizeState('nonsense', 'telegram'), emptyState('telegram'));
  const damaged = {
    ...open,
    checks: { 'backup.age': { ...open.checks['backup.age'], since: 'x' }, 'BAD KEY': {} },
  };
  assert.deepEqual(normalizeState(damaged, 'print').checks, {});
});

test('daily summary is due once per local day after the configured hour', () => {
  const cfg = config({ WATCHDOG_DAILY_SUMMARY: 'true', WATCHDOG_DAILY_SUMMARY_HOUR: '9' });
  const morning = Date.parse('2026-10-09T08:59:00Z');
  const nine = Date.parse('2026-10-09T09:00:00Z');
  assert.equal(summaryDue(emptyState('telegram'), morning, cfg), null);
  assert.equal(summaryDue(emptyState('telegram'), nine, cfg), '2026-10-09');
  assert.equal(
    summaryDue({ ...emptyState('telegram'), lastSummaryDay: '2026-10-09' }, nine + HOUR, cfg),
    null,
  );
  assert.equal(
    summaryDue({ ...emptyState('telegram'), lastSummaryDay: '2026-10-09' }, nine + DAY, cfg),
    '2026-10-10',
  );
  assert.equal(summaryDue(emptyState('telegram'), nine, config()), null);
  assert.equal(summaryDue(emptyState('telegram'), morning, config(), true), '2026-10-09');
});

test('messages are plain text, ordered, split below the Telegram limit', () => {
  const cfg = config();
  const text = renderEvents(
    [
      {
        kind: 'alert',
        key: 'a',
        title: 'API /health/ready',
        detail: 'HTTP 503',
        severity: 'critical',
        since: NOW - 10 * MIN,
      },
      {
        kind: 'recovery',
        key: 'b',
        title: 'Диск /',
        detail: 'занято 40%',
        severity: 'warning',
        since: NOW - 30 * MIN,
      },
    ],
    cfg,
    NOW,
  );
  assert.match(text, /^\[PickChick staging\] мониторинг, 09\.10 06:00/);
  assert.match(
    text,
    /ТРЕВОГА \(критично\): API \/health\/ready\nHTTP 503\. С 09\.10 05:50 \(10 мин\)\./,
  );
  assert.match(text, /НОРМА: Диск \/\nзанято 40%\. Проблема длилась 30 мин\./);
  assert.doesNotMatch(text, /—/);
  const summary = renderSummary(
    run({ db: dbFacts({ unknownOverdue: { 'kaspi-remote-worker': 1, 'kiosk-qr-worker': 0 } }) }),
    cfg,
    NOW,
  );
  assert.match(summary, /ежедневная сводка/);
  assert.match(summary, /Проблем: 1\n- \(критично\) Kaspi worker счетов: счета без ответа банка/);
  assert.match(summary, /В норме:\n- API \/health\/ready: готов/);
  const parts = chunk(
    Array.from({ length: 400 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n'),
  );
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 3800));
  assert.equal(parts.join('\n').split('\n').length, 400);
});

test('Telegram sender posts JSON and never exposes the token in errors', async () => {
  const calls = [];
  await sendTelegram({ token: BOT_TOKEN, chatId: '-100' }, 'hello', async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  assert.equal(calls[0].url, `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    chat_id: '-100',
    text: 'hello',
    disable_web_page_preview: true,
  });
  await assert.rejects(
    sendTelegram(
      { token: BOT_TOKEN, chatId: '-100' },
      'x',
      async () => new Response('{"ok":false,"description":"Unauthorized"}', { status: 401 }),
    ),
    (error) => error.code === 'TELEGRAM_HTTP_401' && !String(error.message).includes(BOT_TOKEN),
  );
  await assert.rejects(
    sendTelegram({ token: BOT_TOKEN, chatId: '-100' }, 'x', async (url) => {
      throw new Error(`connect failed ${url}`);
    }),
    (error) => error.code === 'TELEGRAM_UNREACHABLE' && !String(error.message).includes(BOT_TOKEN),
  );
});

function harness({
  envExtra = {},
  facts = hostFacts(),
  db = dbFacts(),
  api = 200,
  telegram = 200,
} = {}) {
  const files = new Map([['/facts.json', JSON.stringify(facts)]]);
  const printed = [];
  const sent = [];
  let clock = NOW;
  let currentApi = api;
  let currentTelegram = telegram;
  const options = {
    env: env(envExtra),
    now: () => clock,
    readText: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(path);
    },
    writeText: async (path, text) => files.set(path, text),
    // Database facts come from a fake pool that answers readDatabaseFacts' queries.
    connect: async () => fakePool(db),
    print: (record) => printed.push(record),
    fetcher: async (url, init) => {
      if (String(url).startsWith('https://api.telegram.org/')) {
        if (currentTelegram === 200) sent.push(JSON.parse(init.body).text);
        return new Response(JSON.stringify({ ok: currentTelegram === 200 }), {
          status: currentTelegram,
        });
      }
      return currentApi === 200
        ? new Response(JSON.stringify({ ready: true }), { status: 200 })
        : new Response(JSON.stringify({ ready: false, dependencies: { database: 'down' } }), {
            status: currentApi,
          });
    },
  };
  return {
    files,
    printed,
    sent,
    options,
    advance: (ms) => {
      clock += ms;
      files.set('/facts.json', JSON.stringify({ ...facts, collectedAt: iso(clock - MIN) }));
    },
    setApi: (status) => (currentApi = status),
    setTelegram: (status) => (currentTelegram = status),
    run: (argv = ['--facts', '/facts.json', '--state', '/state.json']) =>
      runWatchdog({ ...options, argv }),
  };
}

function fakePool(db) {
  const client = {
    query: async (sql) => {
      if (/^(BEGIN|ROLLBACK)/.test(sql)) return { rows: [] };
      if (sql.startsWith('SELECT clock_timestamp')) return { rows: [{ now: new Date(NOW) }] };
      if (sql.includes('FROM devices d JOIN device_credentials'))
        return {
          rows: db.identities.map((row) => ({
            device_id: row.deviceId,
            kind: row.kind,
            name: row.name,
            expires_at: new Date(row.expiresAt),
            remaining_seconds: String(row.remainingSeconds),
          })),
        };
      if (sql.includes('FROM fulfillment_transport_bindings'))
        return {
          rows: db.heartbeats.map((row) => ({
            branch_id: row.branchId,
            device_id: row.deviceId,
            name: row.name,
            observed_at: row.observedAt ? new Date(row.observedAt) : null,
            age_seconds: row.ageSeconds === null ? null : String(row.ageSeconds),
          })),
        };
      if (sql.includes('commerce_kiosk_kaspi_qr'))
        return {
          rows: [
            {
              kaspi_remote: db.unknownOverdue['kaspi-remote-worker'],
              kiosk_qr: db.unknownOverdue['kiosk-qr-worker'],
            },
          ],
        };
      if (sql.includes('payment.submit_requested')) return { rows: [] };
      throw new Error('unexpected query');
    },
    release: () => undefined,
  };
  return { connect: async () => client, end: async () => undefined };
}

const telegramEnv = {
  WATCHDOG_TELEGRAM_ENABLED: 'true',
  WATCHDOG_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  WATCHDOG_TELEGRAM_CHAT_ID: '-1001234567890',
};
const leaks = (h) =>
  JSON.stringify([h.printed, [...h.files.values()]]).match(
    new RegExp(`${DB_PASSWORD}|${BOT_TOKEN.split(':')[1]}`),
  );

test('dry run prints findings and would-be alerts, sends nothing and keeps state untouched', async () => {
  const h = harness({
    envExtra: telegramEnv,
    db: dbFacts({ unknownOverdue: { 'kaspi-remote-worker': 1, 'kiosk-qr-worker': 0 } }),
  });
  assert.equal(await h.run(['--facts', '/facts.json', '--state', '/state.json', '--dry-run']), 0);
  assert.deepEqual(h.sent, []);
  assert.equal(h.files.has('/state.json'), false);
  const message = h.printed.find((record) => record.event === 'watchdog_message');
  assert.match(message.text, /ТРЕВОГА \(критично\): Kaspi worker счетов: счета без ответа банка/);
  assert.ok(
    h.printed.some(
      (record) =>
        record.event === 'watchdog_finding' &&
        record.key === 'edge.heartbeat.d1' &&
        record.status === 'ok',
    ),
  );
  assert.deepEqual(h.printed.at(-1), {
    event: 'watchdog_run',
    delivery: 'print',
    dryRun: true,
    checks: h.printed.filter((record) => record.event === 'watchdog_finding').length,
    failing: 1,
    notifications: 1,
    summary: false,
    unavailable: [],
  });
  assert.equal(leaks(h), null);
});

test('Telegram mode: confirmation, de-dup, recovery; failed delivery is retried, not lost', async () => {
  const h = harness({ envExtra: telegramEnv, api: 503 });
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.sent, []);
  h.advance(5 * MIN);
  h.setTelegram(502);
  assert.equal(await h.run(), 1);
  assert.deepEqual(h.printed.at(-1), {
    event: 'watchdog_delivery_failed',
    code: 'TELEGRAM_HTTP_502',
  });
  h.setTelegram(200);
  h.advance(5 * MIN);
  assert.equal(await h.run(), 0);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /ТРЕВОГА \(критично\): API \/health\/ready\nHTTP 503 \(database=down\)/);
  h.advance(5 * MIN);
  assert.equal(await h.run(), 0);
  assert.equal(h.sent.length, 1, 'no duplicate inside the re-notify interval');
  h.setApi(200);
  h.advance(5 * MIN);
  assert.equal(await h.run(), 0);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /НОРМА: API \/health\/ready/);
  const state = JSON.parse(h.files.get('/state.json'));
  assert.equal(state.delivery, 'telegram');
  assert.deepEqual(state.checks, {});
  assert.equal(leaks(h), null);
});

test('forced summary is sent once and recorded; invalid config exits 78 naming only the variable', async () => {
  const h = harness({
    envExtra: { ...telegramEnv, WATCHDOG_DAILY_SUMMARY: 'true', WATCHDOG_DAILY_SUMMARY_HOUR: '23' },
  });
  assert.equal(await h.run(['--facts', '/facts.json', '--state', '/state.json', '--summary']), 0);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /ежедневная сводка/);
  assert.equal(JSON.parse(h.files.get('/state.json')).lastSummaryDay, '2026-10-09');
  const broken = harness({
    envExtra: { ...telegramEnv, WATCHDOG_TELEGRAM_BOT_TOKEN: 'not-a-token' },
  });
  assert.equal(await broken.run(), 78);
  assert.deepEqual(broken.printed, [
    { event: 'watchdog_config_invalid', variable: 'WATCHDOG_TELEGRAM_BOT_TOKEN' },
  ]);
  assert.equal(await broken.run(['--facts', 'relative.json', '--state', '/state.json']), 64);
  assert.throws(() => parseArgs(['--facts', '/a', '--state', '/b', '--send-everything']));
});

test('shadow mode (Telegram off) prints alerts and keeps de-dup state', async () => {
  const h = harness({
    db: dbFacts({
      heartbeats: [
        { branchId: 'b1', deviceId: 'd1', name: 'Касса 1', observedAt: null, ageSeconds: null },
      ],
    }),
  });
  assert.equal(await h.run(), 0);
  assert.equal(h.printed.filter((record) => record.event === 'watchdog_message').length, 1);
  assert.equal(JSON.parse(h.files.get('/state.json')).delivery, 'print');
  h.advance(5 * MIN);
  assert.equal(await h.run(), 0);
  assert.equal(h.printed.filter((record) => record.event === 'watchdog_message').length, 1);
  assert.deepEqual(h.sent, []);
});
