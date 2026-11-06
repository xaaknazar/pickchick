// Cutover 19.11.2026, integration (lead decision 07.11 item 2, review R6, CR cloud-2 section 6,
// CR cloud-6 section 2): infra/windows/pos-sales-sync-release.mjs, the owner command that lists
// and releases a parked posSales event on the point server. Real edge 026 outbox, the real POS
// sync sender (syncPosSalesOnce) and the real cloud receiver (receivePosSales on 073) in process,
// the real cloud owner command for a restored Z (acceptRestoredShiftReport). Synthetic data only;
// the network is never used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPool } from '@pickchick/database';
import { hashJson } from '@pickchick/menu-sync';
import { fenceRestoredEdge } from '@pickchick/local-orders';
import {
  acceptRestoredShiftReport,
  createPosSalesSchedule,
  receivePosSales,
  syncPosSalesOnce,
} from '@pickchick/pos-order-sync';
import { provisionCatalogManager } from '@pickchick/catalog-admin';
import { grantBackoffice } from '@pickchick/backoffice-core';
import { authFor } from '../helpers/sync.mjs';
import { posSalesWorkerGrants } from '../../infra/windows/pos-sales-grants.mjs';
import { posSyncWorkerGrants } from '../../infra/windows/pos-sync-worker-grants.mjs';
import {
  SYNC_RELEASE_COMMANDS,
  SYNC_RELEASE_MESSAGES,
  SyncReleaseError,
  parseSyncReleaseArgs,
  releaseParkedPosSalesEvent,
  runPosSalesSyncRelease,
  syncReleaseConfig,
  syncReleaseFailure,
} from '../../infra/windows/pos-sales-sync-release.mjs';
import {
  cashSale,
  enqueue,
  migrationsUpTo,
  sentAs,
  vectorEvent,
  withPosSalesDatabases,
  zReportFor,
} from '../../packages/pos-order-sync/tests/sales-cloud-fixture.mjs';

const TOOL = fileURLToPath(
  new URL('../../infra/windows/pos-sales-sync-release.mjs', import.meta.url),
);
const START = Date.parse('2026-11-19T06:00:00.000Z');
const RELEASED_AT = '2026-11-19T07:30:00.000Z';
const REASON = 'Z смены через восстановление кассы принят владельцем облака (синтетика)';
const ACTOR = 'Codex';

/**
 * The POS sync worker's posSales step against the real receiver of the cloud test schema (no
 * HTTP server, no network: the request body goes straight to receivePosSales).
 */
function sender(ctx) {
  let clock = START;
  const schedule = createPosSalesSchedule();
  const io = {
    now: () => clock,
    fetch: async (_url, options) =>
      Response.json(
        await receivePosSales(ctx.cloud.pool, authFor(ctx.identity), JSON.parse(options.body)),
      ),
  };
  return {
    step: () =>
      syncPosSalesOnce(
        ctx.edge.pool,
        {
          enabled: true,
          branchId: ctx.branch,
          origin: 'http://127.0.0.1:9',
          identity: ctx.identity,
        },
        schedule,
        io,
      ),
    // The parked stream is looked at again after a minute.
    advance: (ms = 60_000) => (clock += ms),
  };
}

/** Runs one command as the CLI does after its owner check; the stdout line, parsed. */
async function run(ctx, argv, pool = ctx.edge.pool) {
  const line = await runPosSalesSyncRelease(parseSyncReleaseArgs(argv), {
    pool,
    branchId: ctx.branch,
    now: () => new Date(RELEASED_AT),
  });
  assert.equal(typeof line, 'string');
  assert.doesNotMatch(line, /\n/, 'one line');
  return JSON.parse(line);
}
const release = (eventId, reason = REASON, actor = ACTOR) => [
  'release',
  '--event',
  eventId,
  '--reason',
  reason,
  '--actor',
  actor,
];

/** Fails with a SyncReleaseError of `code` (and the given details). */
async function refused(promise, code, details = {}) {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error instanceof SyncReleaseError, String(error));
  assert.equal(error.code, code, error.message);
  for (const [key, value] of Object.entries(details)) assert.equal(error.details[key], value, key);
  return error;
}

/** Every row the tool may touch: the whole outbox and the sync state. */
const snapshot = async (pool) => ({
  outbox: (
    await pool.query(
      `SELECT event_id,sequence::text AS sequence,kind,payload_hash,acknowledged_at,attempts,last_error
       FROM pos_sale_outbox ORDER BY sequence`,
    )
  ).rows,
  sync: (
    await pool.query(
      'SELECT branch_id,last_supported_at,last_error,updated_at FROM pos_sale_sync_state ORDER BY branch_id',
    )
  ).rows,
});
const rowOf = async (pool, eventId) =>
  (
    await pool.query(
      'SELECT acknowledged_at,attempts,last_error FROM pos_sale_outbox WHERE event_id=$1',
      [eventId],
    )
  ).rows[0];
const cloudCount = async (pool, table) => {
  assert.match(table, /^cloud_pos_[a-z_]+$/);
  return Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
};

/** A real LOGIN role on the edge test schema holding exactly `grants`. */
async function restricted(ctx, grants, work) {
  const role = 'sync_release_' + randomUUID().replaceAll('-', ''),
    secret = randomBytes(32).toString('hex');
  let pool;
  try {
    await ctx.edge.admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await ctx.edge.pool.query(grants(role, ctx.edge.schema));
    const url = new URL(ctx.edge.config.databaseUrl);
    url.username = role;
    url.password = secret;
    pool = createPool(url.toString());
    await work(pool);
  } finally {
    await pool?.end();
    await ctx.edge.admin.query(`DROP OWNED BY ${role}`);
    await ctx.edge.admin.query(`DROP ROLE ${role}`);
  }
}

test('a Z of a shift open across a restore, parked as rejected:INVALID_EVENT: status lists only it; after the cloud owner accepts it, release prints one JSON line and the next syncPosSalesOnce delivers it and the sale behind it', async () => {
  await withPosSalesDatabases(async (ctx) => {
    const { step, advance } = sender(ctx);
    // The edge database comes back from an older copy (as in sales-worker-integration): sale 1
    // acknowledged, sale 2 copied but unacknowledged; the lost timeline delivered sale 2 and a
    // sale 3 the restored edge never stored.
    const kept = cashSale(ctx.branch, 1, 1);
    await enqueue(ctx.edge.pool, [kept]);
    assert.deepEqual(await step(), { state: 'delivered', count: 1, more: false });
    const copied = cashSale(ctx.branch, 2, 2);
    const [copiedRow] = await enqueue(ctx.edge.pool, [copied]);
    const lost = {
      ...cashSale(ctx.branch, 1, 3),
      sequence: String(BigInt(copiedRow.sequence) + 1n),
    };
    const timeline = await receivePosSales(ctx.cloud.pool, authFor(ctx.identity), {
      events: [sentAs(copied, copiedRow), lost],
    });
    assert.equal(timeline.receipts.length, 2, 'the cloud accepted the lost timeline');
    await ctx.edge.pool.query(
      `INSERT INTO edge_database_epochs(epoch,system_identifier,database_oid,reason,sequence_gap)
       SELECT max(epoch)+1, 1, 1, 'initial', 0 FROM edge_database_epochs`,
    );
    assert.equal((await fenceRestoredEdge(ctx.edge.pool)).state, 'restore');
    const sale = cashSale(ctx.branch, 1, 4);
    await enqueue(ctx.edge.pool, [sale]);
    assert.deepEqual(await step(), { state: 'delivered', count: 2, more: false });
    // The Z of the shift open across the restore lacks the lost sale 3; the first sale of the
    // next shift waits behind it.
    const z = vectorEvent('shift_report_z', ctx.branch, (payload, event) => {
      event.event_id = randomUUID();
      payload.report = zReportFor([kept, copied, sale], payload.report, {
        cash_out_minor: '0',
        counted_cash_minor: '2050000',
        terminal_reported_minor: null,
        terminal_discrepancy_minor: null,
      });
    });
    assert.equal(z.payload.report.expected_cash_minor, '2050000');
    const later = cashSale(ctx.branch, 1, 5);
    later.payload.shift_id = randomUUID();
    const [zRow, laterRow] = await enqueue(ctx.edge.pool, [z, later]);
    const parked = { state: 'parked', eventId: zRow.event_id, error: 'INVALID_EVENT' };
    assert.deepEqual(await step(), parked);
    assert.equal((await rowOf(ctx.edge.pool, zRow.event_id)).last_error, 'rejected:INVALID_EVENT');

    // status: read-only, only the parked Z (not the delivered sales, not the sale behind it).
    const before = await snapshot(ctx.edge.pool);
    const status = await run(ctx, ['status']);
    assert.deepEqual(await snapshot(ctx.edge.pool), before, 'status changes nothing');
    assert.equal(status.event, 'pos_sales_sync_status');
    assert.equal(status.branch_id, ctx.branch);
    assert.equal(status.owner, true);
    assert.deepEqual(status.sync.last_error, `PARKED INVALID_EVENT ${zRow.event_id}`);
    assert.equal(status.pending, 2);
    assert.equal(status.parked_count, 1);
    assert.equal(status.parked.length, 1);
    const [listed] = status.parked;
    // The pinned vectors carry their own occurred_at (19.11); the age is whole minutes from it.
    assert.ok(Number.isInteger(listed.age_minutes));
    assert.match(listed.occurred_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(
      { ...listed, age_minutes: 0, occurred_at: null },
      {
        event_id: zRow.event_id,
        kind: 'shift_report',
        sequence: zRow.sequence,
        state: 'parked',
        reason: 'INVALID_EVENT',
        attempts: 1,
        occurred_at: null,
        age_minutes: 0,
        head: true,
        waiting_behind: 1,
      },
    );

    // The sale behind the Z is not parked: refused, nothing changes.
    await refused(run(ctx, release(laterRow.event_id)), 'NOT_PARKED', {
      event_id: laterRow.event_id,
      state: 'pending',
    });
    assert.deepEqual(await snapshot(ctx.edge.pool), before);

    // The cloud owner accepts the Z as written (CR cloud-6 section 2) ...
    const manager = await provisionCatalogManager(ctx.cloud.pool, {
      organization_id: ctx.org,
      name: 'Синтетический управляющий',
      branch_ids: [ctx.branch],
    });
    await grantBackoffice(ctx.cloud.pool, manager.actor_id, ctx.branch, 'manager');
    const accepted = await acceptRestoredShiftReport(ctx.cloud.pool, {
      branchId: ctx.branch,
      deviceId: ctx.device,
      actorId: manager.actor_id,
      requestId: randomUUID(),
      reason: 'Z смены через восстановление кассы (синтетика)',
      payloadHash: hashJson(z.payload),
      event: sentAs(z, zRow),
    });
    assert.equal(accepted.state, 'accepted');
    assert.equal(accepted.rejected_as, 'shift_cash');
    // ... and the edge still waits: only its owner releases the parked row.
    advance();
    assert.deepEqual(await step(), parked);
    assert.deepEqual(await snapshot(ctx.edge.pool), before);

    // release: exactly one JSON line with the previous state, reason, actor and time.
    const released = await run(ctx, release(zRow.event_id.toUpperCase()));
    assert.deepEqual(released, {
      event: 'pos_sales_sync_released',
      branch_id: ctx.branch,
      event_id: zRow.event_id,
      kind: 'shift_report',
      sequence: zRow.sequence,
      occurred_at: listed.occurred_at,
      previous: {
        state: 'parked',
        reason: 'INVALID_EVENT',
        last_error: 'rejected:INVALID_EVENT',
        attempts: 1,
        sync_last_error: `PARKED INVALID_EVENT ${zRow.event_id}`,
      },
      changed: { outbox_last_error: null, sync_last_error: null },
      state: 'pending',
      reason: REASON,
      actor: ACTOR,
      released_at: RELEASED_AT,
    });
    // The rows show the release by their own fields: the event is unacknowledged without a
    // parking mark, its bytes and attempts unchanged; the sync state has no error and a new time.
    const after = await snapshot(ctx.edge.pool);
    assert.deepEqual(
      after.outbox,
      before.outbox.map((row) =>
        row.event_id === zRow.event_id ? { ...row, last_error: null } : row,
      ),
    );
    assert.equal(after.sync[0].last_error, null);
    assert.deepEqual(after.sync[0].last_supported_at, before.sync[0].last_supported_at);
    assert.ok(after.sync[0].updated_at > before.sync[0].updated_at);
    const statusAfter = await run(ctx, ['status']);
    assert.deepEqual([statusAfter.parked, statusAfter.pending], [[], 2]);
    assert.equal(statusAfter.sync.last_error, null);

    // A second release of the same event is refused and changes nothing.
    const again = await refused(run(ctx, release(zRow.event_id)), 'NOT_PARKED', {
      event_id: zRow.event_id,
      state: 'pending',
    });
    assert.match(again.message, /уже освобождено и ждёт отправки - ничего не изменено/);
    assert.deepEqual(await snapshot(ctx.edge.pool), after);

    // The next step of the sender delivers the Z (a duplicate for the cloud) and the sale behind.
    advance();
    assert.deepEqual(await step(), { state: 'delivered', count: 2, more: false });
    const delivered = await snapshot(ctx.edge.pool);
    assert.ok(delivered.outbox.every((row) => row.acknowledged_at && row.last_error === null));
    assert.equal((await rowOf(ctx.edge.pool, zRow.event_id)).attempts, 2);
    assert.equal(delivered.sync[0].last_error, null);
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_shift_reports'), 1);
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_sales'), 5);
    await refused(run(ctx, release(zRow.event_id)), 'NOT_PARKED', { state: 'delivered' });
    const done = await run(ctx, ['status']);
    assert.deepEqual([done.parked, done.parked_count, done.pending], [[], 0, 0]);
    assert.deepEqual(await snapshot(ctx.edge.pool), delivered);

    // The two example lines of the master runbook section 9.1 have exactly these fields.
    const runbook = await readFile(
      new URL('../../docs/operations/cutover-2026-11-19.md', import.meta.url),
      'utf8',
    );
    const section = runbook.slice(runbook.indexOf('### 9.1 '), runbook.indexOf('### 9.2 '));
    const examples = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
    assert.deepEqual(examples.map(shape), [shape(status), shape(released)]);
  });
});

/** Field names (nested, in order) and value types of a JSON value. */
const shape = (value) =>
  Array.isArray(value)
    ? value.map(shape)
    : value && typeof value === 'object'
      ? Object.entries(value).map(([key, item]) => [key, shape(item)])
      : value === null
        ? 'null'
        : typeof value;

test('release refuses an unknown event, an event of another branch, an event that is not parked, a wrong or missing reason or actor and a non-owner connection, and changes nothing; it never skips the cloud check', async () => {
  await withPosSalesDatabases(async (ctx) => {
    const { step, advance } = sender(ctx);
    const first = cashSale(ctx.branch, 1, 1);
    const [firstRow] = await enqueue(ctx.edge.pool, [first]);
    assert.deepEqual(await step(), { state: 'delivered', count: 1, more: false });
    // A refund of a sale the cloud never received: INVALID_EVENT, parked; a sale waits behind it.
    const refund = vectorEvent('refund_terminal_part', ctx.branch, (_payload, event) => {
      event.event_id = randomUUID();
    });
    const behind = cashSale(ctx.branch, 1, 2);
    const [refundRow, behindRow] = await enqueue(ctx.edge.pool, [refund, behind]);
    const parked = { state: 'parked', eventId: refundRow.event_id, error: 'INVALID_EVENT' };
    assert.deepEqual(await step(), parked);
    const status = await run(ctx, ['status']);
    assert.deepEqual(
      status.parked.map((row) => [
        row.event_id,
        row.kind,
        row.reason,
        row.head,
        row.waiting_behind,
      ]),
      [[refundRow.event_id, 'refund', 'INVALID_EVENT', true, 1]],
    );
    const before = await snapshot(ctx.edge.pool);
    const unchanged = async () => assert.deepEqual(await snapshot(ctx.edge.pool), before);

    // Events the tool may not release.
    const unknown = randomUUID();
    await refused(run(ctx, release(unknown)), 'UNKNOWN_EVENT', { event_id: unknown });
    await refused(
      releaseParkedPosSalesEvent(ctx.edge.pool, randomUUID(), {
        eventId: refundRow.event_id,
        reason: REASON,
        actor: ACTOR,
      }),
      'UNKNOWN_EVENT',
    );
    await refused(run(ctx, release(firstRow.event_id)), 'NOT_PARKED', { state: 'delivered' });
    await refused(run(ctx, release(behindRow.event_id)), 'NOT_PARKED', { state: 'pending' });
    await unchanged();

    // Arguments: reason 3..300 in one line, actor 2..64 in one line, event a uuid, each option
    // exactly once; refused before any database access.
    const id = refundRow.event_id;
    for (const [argv, code] of [
      [release(id, 'ab'), 'REASON_INVALID'],
      [release(id, '   '), 'REASON_INVALID'],
      [release(id, 'x'.repeat(301)), 'REASON_INVALID'],
      [release(id, 'две\nстроки'), 'REASON_INVALID'],
      [release(id, REASON, 'C'), 'ACTOR_INVALID'],
      [release(id, REASON, 'x'.repeat(65)), 'ACTOR_INVALID'],
      [release(id, REASON, 'Co\tdex'), 'ACTOR_INVALID'],
      [release('not-a-uuid'), 'EVENT_INVALID'],
      [['release', '--event', id, '--actor', ACTOR], 'USAGE'],
      [['release', '--event', id, '--reason', REASON], 'USAGE'],
      [['release', '--event', id, '--reason', REASON, '--reason', REASON], 'USAGE'],
      [['release', '--event', id, '--reason', REASON, '--actor', ACTOR, '--force', 'yes'], 'USAGE'],
      [['release', '--event', id, '--reason', REASON, '--who', ACTOR], 'USAGE'],
      [['status', '--event', id], 'USAGE'],
      [['sync-release', '--event', id], 'USAGE'],
      [[], 'USAGE'],
    ])
      assert.throws(
        () => parseSyncReleaseArgs(argv),
        (error) => error instanceof SyncReleaseError && error.code === code,
        JSON.stringify(argv),
      );
    assert.deepEqual(parseSyncReleaseArgs(release(` ${id} `, ` ${REASON} `, ' Codex ')), {
      command: 'release',
      eventId: id,
      reason: REASON,
      actor: ACTOR,
    });
    assert.equal(parseSyncReleaseArgs(release(id, 'x'.repeat(300))).reason.length, 300);
    await unchanged();

    // A non-owner connection: the POS sync worker role may UPDATE last_error of the outbox, and
    // still the tool (and retryPosSalesDelivery under it) refuses; it can only look.
    const worker = (role, schema) =>
      posSyncWorkerGrants(role, schema) + '\n' + posSalesWorkerGrants(role, schema);
    await restricted(ctx, worker, async (pool) => {
      await refused(run(ctx, release(id), pool), 'NOT_OWNER');
      const view = await run(ctx, ['status'], pool);
      assert.equal(view.owner, false);
      assert.deepEqual(
        view.parked.map((row) => row.event_id),
        [id],
      );
    });
    await unchanged();

    // The owner releases it; the cloud still refuses that refund, so the sender parks it again:
    // the release never bypasses the receiver's check.
    const released = await run(ctx, release(id, 'Разбор возврата с инженером (синтетика)'));
    assert.equal(released.previous.reason, 'INVALID_EVENT');
    assert.equal((await rowOf(ctx.edge.pool, id)).last_error, null);
    advance();
    assert.deepEqual(await step(), parked);
    assert.equal((await rowOf(ctx.edge.pool, id)).last_error, 'rejected:INVALID_EVENT');
    assert.equal((await rowOf(ctx.edge.pool, behindRow.event_id)).acknowledged_at, null);
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_refunds'), 0);
  });
});

test('an edge without schema026: status and release refuse NOT_INSTALLED', async () => {
  const old = await migrationsUpTo('edge', 25);
  try {
    await withPosSalesDatabases(
      async (ctx) => {
        await refused(run(ctx, ['status']), 'NOT_INSTALLED');
        await refused(run(ctx, release(randomUUID())), 'NOT_INSTALLED');
      },
      { edgeMigrationDirectory: old.directory },
    );
  } finally {
    await old.remove();
  }
});

test('the command line checks arguments and the owner environment before any connection, prints one line and never the connection string; the master runbook lists every refusal', async () => {
  const secret = 'synthetic-secret-' + randomUUID();
  const branch = '10000000-0000-4000-8000-000000000003';
  const owner = {
    APP_ENV: 'local',
    EDGE_DATABASE_URL: `postgresql://pickchick_edge_owner:${secret}@127.0.0.1:55433/pickchick_edge`,
    EDGE_BRANCH_ID: branch,
  };
  assert.equal(syncReleaseConfig(owner).branchId, branch);
  for (const env of [
    {},
    { ...owner, APP_ENV: 'test' },
    { ...owner, EDGE_DATABASE_URL: owner.EDGE_DATABASE_URL.replace('_owner:', '_runtime:') },
    { ...owner, EDGE_DATABASE_URL: owner.EDGE_DATABASE_URL.replace(':55433/', ':55432/') },
    { ...owner, EDGE_DATABASE_URL: owner.EDGE_DATABASE_URL.replace('127.0.0.1', 'localhost') },
    { ...owner, EDGE_DATABASE_URL: owner.EDGE_DATABASE_URL.replace('_edge', '_cloud') },
    { ...owner, EDGE_DATABASE_URL: owner.EDGE_DATABASE_URL + '?options=-c%20role%3Dx' },
    { ...owner, EDGE_BRANCH_ID: 'not-a-branch' },
  ])
    assert.throws(
      () => syncReleaseConfig(env),
      (error) => error instanceof SyncReleaseError && error.code === 'OWNER_REQUIRED',
      JSON.stringify(env),
    );

  const cli = async (args, env) => {
    const result = await promisify(execFile)(process.execPath, [TOOL, ...args], {
      env: { PATH: process.env.PATH, ...env },
    }).then(
      (done) => ({ code: 0, stdout: done.stdout, stderr: done.stderr }),
      (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
    );
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, new RegExp(secret));
    assert.doesNotMatch(result.stderr, /postgresql:|@127\.0\.0\.1/);
    assert.equal(result.stderr.split('\n').filter(Boolean).length, 1, result.stderr);
    return JSON.parse(result.stderr);
  };
  const id = randomUUID();
  const runtime = {
    ...owner,
    EDGE_DATABASE_URL: owner.EDGE_DATABASE_URL.replace('_owner:', '_runtime:'),
  };
  for (const [args, env, code, command] of [
    [[], owner, 'USAGE', null],
    [['sync-release'], owner, 'USAGE', null],
    [release(id, 'ab'), owner, 'REASON_INVALID', 'release'],
    [release(id, REASON, ''), owner, 'ACTOR_INVALID', 'release'],
    [release('x'), owner, 'EVENT_INVALID', 'release'],
    [['status'], runtime, 'OWNER_REQUIRED', 'status'],
    [release(id), runtime, 'OWNER_REQUIRED', 'release'],
    [['status'], {}, 'OWNER_REQUIRED', 'status'],
  ]) {
    const line = await cli(args, env);
    assert.deepEqual(
      { event: line.event, command: line.command, code: line.code, message: line.message },
      {
        event: 'pos_sales_sync_release_refused',
        command,
        code,
        message: SYNC_RELEASE_MESSAGES[code],
      },
      JSON.stringify(args),
    );
  }
  // Anything unexpected stays generic: only an error code, never driver text.
  const failure = JSON.parse(
    syncReleaseFailure(
      Object.assign(new Error(`connect to ${owner.EDGE_DATABASE_URL} failed`), {
        code: 'ECONNREFUSED',
      }),
      'status',
    ),
  );
  assert.deepEqual(Object.keys(failure).sort(), [
    'code',
    'command',
    'error_code',
    'event',
    'message',
  ]);
  assert.equal(failure.error_code, 'ECONNREFUSED');
  assert.doesNotMatch(JSON.stringify(failure), new RegExp(secret));
  assert.equal(JSON.parse(syncReleaseFailure(new Error('x'))).error_code, undefined);

  // No network in the tool; the master runbook names the commands and every refusal code.
  const source = await readFile(TOOL, 'utf8');
  assert.doesNotMatch(source, /\bfetch\(|node:https?|node:net|node:dgram|WebSocket/);
  assert.deepEqual(SYNC_RELEASE_COMMANDS, ['status', 'release']);
  const runbook = await readFile(
    new URL('../../docs/operations/cutover-2026-11-19.md', import.meta.url),
    'utf8',
  );
  assert.ok(runbook.includes('infra/windows/pos-sales-sync-release.mjs status'));
  assert.ok(runbook.includes('pos-sales-sync-release.mjs release --event '));
  for (const code of Object.keys(SYNC_RELEASE_MESSAGES))
    assert.ok(runbook.includes('`' + code + '`'), code);
});
