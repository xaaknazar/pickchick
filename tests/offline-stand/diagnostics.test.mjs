import test from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostics, DIAGNOSTIC_SQL, diagnosticError, probeDatabase } from './diagnostics.mjs';

const fakePool = () => ({
  totalCount: 2,
  idleCount: 1,
  waitingCount: 3,
  async query() {
    return { rows: [{ diagnostic: { sessions: [], locks: 0, database: {} } }] };
  },
  async end() {
    this.ended = true;
  },
});

test('probe exposes SQLSTATE, never driver messages, SQL parameters or credentials', async () => {
  const error = Object.assign(new Error('postgresql://user:secret@localhost/private'), {
    code: '57014',
    detail: 'private SQL parameters',
  });
  assert.deepEqual(diagnosticError(error), { code: '57014' });
  assert.deepEqual(diagnosticError({ code: 'password' }), { code: 'PROBE_ERROR' });
  const result = await probeDatabase({
    query: async () => {
      throw error;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, '57014');
  assert.ok(result.elapsed_ms >= 0);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('query is bounded and read-only; retains wait/blocker evidence without SQL text', () => {
  assert.match(DIAGNOSTIC_SQL, /md5\(query\) AS query_hash/);
  assert.match(DIAGNOSTIC_SQL, /pg_blocking_pids/);
  assert.match(DIAGNOSTIC_SQL, /LIMIT 64/);
  assert.match(DIAGNOSTIC_SQL, /datname=current_database\(\)/);
  assert.doesNotMatch(DIAGNOSTIC_SQL, /\b(?:UPDATE|DELETE|INSERT|ALTER|DROP|TRUNCATE)\b/);
});

test('diagnostics use independent pools and serialize samples; stop drains and closes only own pools', async () => {
  const stand = {
    cloudUrl: 'cloud',
    edgeUrl: 'edge',
    cloud: fakePool(),
    edge: fakePool(),
    runDir: '/tmp',
  };
  const owned = [],
    writes = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const diag = new Diagnostics(stand, {
    poolFactory: (url, max) => {
      assert.equal(max, 1);
      const p = fakePool();
      owned.push(p);
      return p;
    },
    write: async (...args) => {
      writes.push(args);
      await gate;
    },
  });
  const first = diag.sample('start');
  assert.equal(diag.sample('overlap'), first);
  release();
  await first;
  const result = await diag.stop();
  assert.equal(result.samples, 2);
  assert.equal(result.write_errors, 0);
  assert.ok(owned.every((p) => p.ended));
  assert.equal(stand.cloud.ended, undefined);
  assert.equal(stand.edge.ended, undefined);
  assert.equal(writes[0][2].mode, 0o600);
  const snapshot = JSON.parse(writes[0][1]);
  assert.equal(snapshot.pools.edge.waiting, 3);
  assert.equal(snapshot.edge.ok, true);
  assert.ok(snapshot.observed_at);
  assert.ok(snapshot.process_memory.rss > 0);
});

test('one timed-out DB does not discard the other DB evidence; write failure is counted', async () => {
  const stand = {
    cloudUrl: 'cloud',
    edgeUrl: 'edge',
    cloud: fakePool(),
    edge: fakePool(),
    runDir: '/tmp',
  };
  const diag = new Diagnostics(stand, {
    poolFactory: (url) =>
      url === 'cloud'
        ? {
            ...fakePool(),
            query: async () => {
              throw Object.assign(new Error('do not log me'), { code: '57014' });
            },
          }
        : fakePool(),
    write: async () => {
      throw new Error('full disk');
    },
  });
  const row = await diag.sample('error');
  assert.equal(row.cloud.ok, false);
  assert.equal(row.edge.ok, true);
  const result = await diag.stop();
  assert.equal(result.samples, 0);
  assert.equal(result.write_errors, 2);
});
