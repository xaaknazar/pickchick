// Stage 2 (lane ebk, audit 6.4): optional cashier backup attention in the heartbeat pull.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture } from './worker-fixture.mjs';
import { PullRequestSchema } from '../dist/index.js';

const attention = {
  state: 'failed',
  ageMinutes: 185,
  maxAgeMinutes: 120,
  error: 'DESTINATION_UNAVAILABLE',
};
const ordering = (f, enabled) =>
  f.pool.query('UPDATE branch_config SET ordering_enabled=$2 WHERE id=$1', [
    f.scope.branchId,
    enabled,
  ]);
const cloudAvailability = async (f) =>
  (await f.cloud.query('SELECT * FROM cloud_branch_availability')).rows[0];

/** Cloud log lines `edge_backup_attention` written while `run` executes (same process). */
async function backupLines(run) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    await run();
  } finally {
    console.error = original;
  }
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((line) => line?.event === 'edge_backup_attention');
}

function recording(reject = () => false) {
  const bodies = [];
  return {
    bodies,
    io: {
      fetch: async (url, init) => {
        if (!url.endsWith('/pull')) return fetch(url, init);
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (reject(body))
          return new Response(
            JSON.stringify({
              code: 'INVALID_REQUEST',
              message_key: 'error.invalid_request',
              trace_id: randomUUID(),
              retryable: false,
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        return fetch(url, init);
      },
    },
  };
}

test('the backup attention field is optional, strict and bounded', () => {
  const base = { workerId: randomUUID(), leaseSeconds: 30 };
  assert.equal(PullRequestSchema.safeParse(base).success, true);
  assert.equal(PullRequestSchema.safeParse({ ...base, edgeBackup: attention }).success, true);
  for (const edgeBackup of [
    { ...attention, ageMinutes: null, error: null, state: 'stale' },
    { ...attention, maxAgeMinutes: 60 },
    { ...attention, maxAgeMinutes: 4320 },
  ])
    assert.equal(PullRequestSchema.safeParse({ ...base, edgeBackup }).success, true);
  for (const edgeBackup of [
    { ...attention, extra: true },
    { ...attention, state: 'ok' },
    { ...attention, ageMinutes: -1 },
    { ...attention, ageMinutes: 1.5 },
    { ...attention, maxAgeMinutes: 59 },
    { ...attention, error: 'connection refused: password=secret' },
    { ...attention, error: 'lowercase' },
    { state: 'stale', ageMinutes: 1, maxAgeMinutes: 120 },
    null,
  ])
    assert.equal(
      PullRequestSchema.safeParse({ ...base, edgeBackup }).success,
      false,
      JSON.stringify(edgeBackup),
    );
});

test('a stale cashier backup reaches the cloud log once per interval; a healthy one sends nothing', () =>
  fixture(async (f) => {
    const { bodies, io } = recording();
    assert.deepEqual(await backupLines(() => f.tick(io)), []);
    assert.ok(bodies.length);
    // Without attention the heartbeat is byte-for-byte the previous one.
    assert.ok(bodies.every((body) => !('edgeBackup' in body)));
    f.options.edgeBackup = attention;
    bodies.length = 0;
    const lines = await backupLines(async () => {
      await f.tick(io);
      await f.tick(io);
    });
    assert.ok(bodies.filter((body) => body.edgeBackup).length >= 2);
    assert.deepEqual(bodies.find((body) => body.edgeBackup).edgeBackup, attention);
    // Throttled per branch: the watchdog reads one line per interval, not one per heartbeat.
    assert.deepEqual(lines, [
      { event: 'edge_backup_attention', branchId: f.scope.branchId, ...attention },
    ]);
    // A malformed local health record is neither sent nor allowed to break the order loop.
    f.options.edgeBackup = { ...attention, ageMinutes: -5, error: 'free text' };
    bodies.length = 0;
    const result = await f.tick(io);
    assert.ok(['applied', 'idle', 'acknowledged'].includes(result.state), result.state);
    assert.ok(bodies.length);
    assert.ok(bodies.every((body) => !('edgeBackup' in body)));
  }));

test('an older cloud refuses only the backup field: the closed-ordering signal still arrives', () =>
  fixture(async (f) => {
    const { bodies, io } = recording((body) => body.edgeBackup !== undefined);
    await ordering(f, false);
    f.options.edgeBackup = attention;
    await f.tick(io);
    assert.ok(bodies[0].edgeBackup);
    // The same turn repeats the request without the backup field, keeping orderingEnabled.
    assert.equal(bodies[1].edgeBackup, undefined);
    assert.equal(bodies[1].availability.orderingEnabled, false);
    assert.equal((await cloudAvailability(f)).ordering_closed, true);
    // The backup field stays off for this cloud for a while; the ordering field does not.
    bodies.length = 0;
    await f.tick(io);
    assert.ok(bodies.length);
    assert.ok(bodies.every((body) => body.edgeBackup === undefined));
    assert.ok(bodies.some((body) => body.availability?.orderingEnabled === false));
    await ordering(f, true);
  }));
