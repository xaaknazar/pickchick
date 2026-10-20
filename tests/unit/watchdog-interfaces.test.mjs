import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { KaspiAttention } from '../../packages/commerce-core/dist/index.js';
import { CustomerIdentity } from '../../packages/customer-identity/dist/index.js';
import { TransportAttention } from '../../packages/fulfillment-transport/dist/index.js';
import { evaluate } from '../../infra/staging/watchdog/checks.mjs';
import { loadWatchdogConfig } from '../../infra/staging/watchdog/config.mjs';
import { parseHostFacts } from '../../infra/staging/watchdog/host-facts.mjs';

// Integration 19.10: the JSON lines the merged workers really print (pay KaspiAttention, ful
// TransportAttention, sec customer identity) pass the watchdog host collector (run-watchdog.py)
// and its second whitelist (host-facts.mjs) and open the intended alerts. A renamed field or
// reason code on either side fails here instead of silently reading as "НОРМА".
const runner = fileURLToPath(
  new URL('../../infra/staging/watchdog/run-watchdog.py', import.meta.url),
);
const NOW = Date.parse('2026-10-20T06:00:00Z');
const stamp = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

/** Docker log lines -> the Python collector's sanitizers, exactly as on the VPS. */
function collect(lines) {
  const program = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('runner', sys.argv[1])
runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
data = json.load(sys.stdin)
print(json.dumps({
  'worker': [x for x in (runner.sanitize_worker_line('kaspi-remote-worker', l) for l in data['worker']) if x],
  'fulfillment': [x for x in map(runner.sanitize_fulfillment_line, data['fulfillment']) if x],
  'identity': [x for x in map(runner.sanitize_identity_line, data['identity']) if x],
}))`;
  const result = spawnSync('python3', ['-I', '-c', program, runner], {
    input: JSON.stringify(lines),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const line = (minutes, event) => `${stamp(minutes)} ${JSON.stringify(event)}`;

test('worker attention lines of the merged lanes open the watchdog alerts', () => {
  let clock = 0;
  const kaspi = new KaspiAttention(5 * 60_000);
  const tick = {
    submitted: 0,
    checked: 0,
    notSent: 0,
    errors: 0,
    unknownOverdue: 0,
    pendingUnsent: 2,
    oldestUnsentSeconds: 400,
  };
  const session = kaspi.next(
    { ...tick, sessionProblem: true, sessionReason: 'bridge_unreachable' },
    clock,
  );
  const transport = new TransportAttention(5 * 60_000, 2 * 60_000, () => clock);
  const parked = transport.observe({
    state: 'parked',
    reason: 'ITEM_STOPPED',
    unresolvedFailures: 1,
  });
  const events = [];
  const identity = new CustomerIdentity(null, {}, null, (event) => events.push(event));
  identity['deliveryAttention']('telegram', 'channel_unavailable');
  const sanitized = collect({
    worker: [line(4, session)],
    fulfillment: [line(3, parked)],
    identity: [
      line(2, events[0]),
      // Shape of the budget event (packages/customer-identity, checked against the real code by
      // tests/integration/identity-abuse-limits.test.mjs).
      line(1, {
        event: 'customer_otp_budget_attention',
        pool: 'new_phones',
        percent: 100,
        budget: 800,
      }),
    ],
  });
  assert.deepEqual(sanitized.worker[0], {
    at: stamp(4).replace(/\.\d+Z$/, 'Z'),
    event: 'kaspi_remote_attention',
    errors: 0,
    unknownOverdue: 0,
    pendingUnsent: 2,
    oldestUnsentSeconds: 400,
    sessionProblem: true,
    reason: 'bridge_unreachable',
  });
  assert.deepEqual(sanitized.fulfillment[0].reasons, { ITEM_STOPPED: 1 });
  assert.equal(sanitized.identity.length, 2);
  const host = parseHostFacts(
    JSON.stringify({
      version: 1,
      collectedAt: stamp(1),
      logWindowSeconds: 600,
      collectorErrors: [],
      containers: {},
      workerEvents: { 'kaspi-remote-worker': sanitized.worker, 'kiosk-qr-worker': [] },
      fulfillmentEvents: sanitized.fulfillment,
      fulfillmentCollected: true,
      identityCollected: true,
      identityDelivery: sanitized.identity.filter((e) => e.event.endsWith('delivery_attention')),
      identityBudget: {
        day: '2026-10-20',
        pools: { new_phones: { ...sanitized.identity[1], event: undefined } },
      },
      disks: [],
      backups: { files: [] },
    }),
    NOW,
    15 * 60_000,
  );
  assert.equal(host.ok, true);
  const config = loadWatchdogConfig({
    WATCHDOG_DB_PASSWORD: '0123456789abcdef'.repeat(4),
    WATCHDOG_TIMEZONE: 'UTC',
  });
  const { findings } = evaluate({
    api: { ok: true, status: 200, error: null, dependencies: null },
    host,
    db: { ok: false, code: 'connection_failed' },
    config,
    nowMs: NOW,
  });
  const status = (key) => {
    const finding = findings.find((item) => item.key === key);
    return finding && [finding.status, finding.severity];
  };
  assert.deepEqual(status('kaspi.session'), ['fail', 'critical']);
  assert.match(findings.find((f) => f.key === 'kaspi.session').detail, /мост Kaspi не отвечает/);
  assert.deepEqual(status('kitchen.transport'), ['fail', 'critical']);
  assert.deepEqual(status('identity.otp_delivery'), ['fail', 'critical']);
  assert.deepEqual(status('identity.otp_budget_pool'), ['fail', 'critical']);

  // Recovery lines of the same emitters close the alerts again.
  clock = 10 * 60_000;
  const recovered = collect({
    worker: [line(4, session), line(1, kaspi.next({ ...tick, oldestUnsentSeconds: 0 }, clock))],
    fulfillment: [
      line(3, parked),
      line(1, transport.observe({ state: 'idle', unresolvedFailures: 0 })),
    ],
    identity: [],
  });
  assert.deepEqual(recovered.worker[1], {
    at: stamp(1).replace(/\.\d+Z$/, 'Z'),
    event: 'kaspi_remote_attention',
    sessionProblem: false,
    recovered: true,
  });
  assert.deepEqual(recovered.fulfillment[1].recovered, true);
});
