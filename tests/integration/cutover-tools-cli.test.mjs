// Cutover 19.11.2026, integration (review R10): the command lines of the two guarded edge tools of
// window C4, infra/windows/pos-sales-upgrade-db.mjs (026, and 028 with inspect-028/apply-028,
// CR pos-7) and kds-upgrade-db.mjs. A refusal names its
// own cause (master runbook, step 3 table of refusals); anything else stays generic or gives only
// an error code; no connection string or password is ever printed. The CLI never connects before
// its arguments and the owner URL are checked.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withSyncDatabases } from '../helpers/sync.mjs';
import {
  deskNumberMigration,
  operatorMessage as posMessage,
  posSalesMigration,
} from '../../infra/windows/pos-sales-upgrade-db.mjs';
import {
  operatorMessage as kdsMessage,
  kdsMigration,
} from '../../infra/windows/kds-upgrade-db.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const posFile = fileURLToPath(
  new URL('../../infra/windows/pos-sales-upgrade-db.mjs', import.meta.url),
);
const tools = {
  pos: {
    file: posFile,
    prefix: 'POS sales migration stopped',
    invocation: 'Invalid POS sales migration invocation',
    modes: ['inspect', 'apply'],
    message: posMessage,
    migration: posSalesMigration,
  },
  // The 028 step is the same command line with its own modes (CR pos-7 section 2 p.1).
  desk: {
    file: posFile,
    prefix: 'POS sales migration stopped',
    invocation: 'Invalid POS sales migration invocation',
    modes: ['inspect-028', 'apply-028'],
    message: posMessage,
    migration: deskNumberMigration,
  },
  kds: {
    file: fileURLToPath(new URL('../../infra/windows/kds-upgrade-db.mjs', import.meta.url)),
    prefix: 'KDS migration stopped',
    invocation: 'Invalid KDS migration invocation',
    modes: ['inspect', 'apply'],
    message: kdsMessage,
    migration: kdsMigration,
  },
};
const SECRET = 'synthetic-secret-' + randomUUID();
const owner = `postgresql://pickchick_edge_owner:${SECRET}@127.0.0.1:55433/pickchick_edge`;
const runtime = `postgresql://pickchick_edge_runtime:${SECRET}@127.0.0.1:55433/pickchick_edge`;
const branch = '10000000-0000-4000-8000-000000000003';

async function cli(tool, args, url) {
  const result = await promisify(execFile)(process.execPath, [tool.file, ...args], {
    env: { PATH: process.env.PATH, ...(url === undefined ? {} : { EDGE_DATABASE_URL: url }) },
  }).then(
    (done) => ({ code: 0, stdout: done.stdout, stderr: done.stderr }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, new RegExp(SECRET));
  assert.doesNotMatch(result.stderr, /postgresql:|@127\.0\.0\.1/);
  assert.equal(result.stderr.split('\n').filter(Boolean).length, 1, result.stderr);
  return result.stderr.trim();
}

for (const [name, tool] of Object.entries(tools))
  test(`${name}: the command line names its refusal, never the connection string`, async () => {
    const [inspect, apply] = tool.modes;
    const line = (reason) => `${tool.prefix}: ${reason}; inspect protected state.`;
    for (const args of [
      [],
      [inspect],
      ['repair', repoRoot, repoRoot, branch],
      [name === 'kds' ? 'inspect-028' : 'inspect-027', repoRoot, repoRoot, branch],
      [inspect, repoRoot, repoRoot, 'not-a-branch'],
      [apply, repoRoot, repoRoot, branch, 'extra'],
    ])
      assert.equal(await cli(tool, args, owner), line(tool.invocation), JSON.stringify(args));
    const valid = [inspect, repoRoot, repoRoot, branch];
    // The runtime login, another port, host or database: refused before any connection.
    for (const url of [
      runtime,
      owner.replace(':55433/', ':55432/'),
      owner.replace('127.0.0.1', 'localhost'),
      owner.replace('/pickchick_edge', '/pickchick_cloud'),
    ])
      assert.equal(await cli(tool, valid, url), line('Expected local edge owner'), url);
    // No URL or an unparsable one: only the error code.
    assert.equal(
      await cli(tool, valid, undefined),
      line('database or connection error ERR_INVALID_URL'),
    );
    assert.equal(
      await cli(tool, valid, 'not a url'),
      line('database or connection error ERR_INVALID_URL'),
    );
    // Owner URL, but the tools root has no pg driver: still no connection, only the code.
    const empty = await mkdtemp(join(tmpdir(), 'cutover-tools-root-'));
    try {
      assert.equal(
        await cli(tool, [inspect, empty, repoRoot, branch], owner),
        line('database or connection error MODULE_NOT_FOUND'),
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

test('operatorMessage: own refusals and grant proofs by text, database errors by code only, the rest generic', () => {
  for (const tool of Object.values(tools)) {
    assert.equal(
      tool.message(Object.assign(new Error('x'), { code: '28P01' })),
      'database or connection error 28P01',
    );
    assert.equal(
      tool.message(
        Object.assign(new Error(`connect to ${owner} failed`), { code: 'ECONNREFUSED' }),
      ),
      'database or connection error ECONNREFUSED',
    );
    assert.equal(tool.message(new Error(`unexpected ${owner}`)), null);
    assert.equal(tool.message(Object.assign(new Error('x'), { code: 'lower-case' })), null);
    assert.equal(tool.message(null), null);
  }
  assert.equal(
    posMessage(new Error('POS sales table privileges differ: pos_sales')),
    'POS sales table privileges differ: pos_sales',
  );
  assert.equal(posMessage(new Error('KDS table privileges differ: kds_layouts')), null);
  assert.equal(
    kdsMessage(new Error('KDS column privileges differ: delivery_handovers.staff_id')),
    'KDS column privileges differ: delivery_handovers.staff_id',
  );
  assert.equal(kdsMessage(new Error('POS sales relations differ from schema026')), null);
});

test('a refusal on a real edge carries its own message to the operator; the runbook table lists every refusal', async () => {
  await withSyncDatabases(async (ctx) => {
    const client = await ctx.edge.pool.connect();
    try {
      // On a fully migrated edge (028): 026 and 027 are no longer pending, 028 is applied.
      for (const tool of Object.values(tools)) {
        const error = await tool
          .migration(client, {
            mode: 'apply',
            appRoot: repoRoot,
            branchId: ctx.branch,
            schema: ctx.edge.schema,
          })
          .then(
            () => null,
            (caught) => caught,
          );
        assert.ok(error?.refusal === true, String(error));
        assert.equal(tool.message(error), error.message);
        assert.match(
          error.message,
          /already applied; nothing changed|Expected unchanged schema02[567] and only reviewed migration02[678]/,
        );
      }
    } finally {
      client.release();
    }
  });
  // Every refusal text of both tools (the 028 step included) appears in the runbook table.
  const runbook = await readFile(
    new URL('../../docs/operations/cutover-2026-11-19.md', import.meta.url),
    'utf8',
  );
  for (const tool of [tools.pos, tools.kds]) {
    const source = await readFile(tool.file, 'utf8');
    const messages = [...source.matchAll(/refused\('([^']+)'/g)].map((m) => m[1]);
    assert.ok(messages.length > 15);
    for (const message of messages) assert.ok(runbook.includes('`' + message.trim()), message);
  }
});
