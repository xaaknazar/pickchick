// 18.11.2026 (cutover 19.11): the additive EXECUTE tool for the cashier report and sales helpers
// that invoker triggers call as the edge runtime and the fulfillment worker on a native edge
// (PUBLIC EXECUTE revoked by native-foundation-db.mjs). Plan per schema, names bound to the
// migrations, nothing but EXECUTE, and a CLI that refuses anything but the local edge owner.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  KASPI_SCHEMA_ROW,
  OWNER_FUNCTIONS,
  PINNED_MIN,
  REPORT_FUNCTIONS,
  RUNTIME_ROLE,
  SALES_FUNCTIONS,
  WORKER_FUNCTIONS,
  WORKER_ROLES,
  functionGrantPlan,
} from '../../infra/windows/cashier-report-function-grants.mjs';

const windows = new URL('../../infra/windows/', import.meta.url);
const migrations = new URL('../../db/edge/migrations/', import.meta.url);
const migration = (name) => readFile(new URL(name, migrations), 'utf8');

test('functionGrantPlan: report helpers from schema016, sales helpers from schema026, worker gets the order report only', () => {
  for (const length of [15, 30, 16.5, '28', undefined])
    assert.throws(() => functionGrantPlan(length), /Reviewed schema016 to schema029 required/);
  const runtime = (fns) => fns.map((fn) => ({ role: RUNTIME_ROLE, fn }));
  assert.deepEqual(functionGrantPlan(16), runtime(REPORT_FUNCTIONS));
  assert.deepEqual(functionGrantPlan(25), runtime(REPORT_FUNCTIONS));
  assert.deepEqual(functionGrantPlan(26), runtime([...REPORT_FUNCTIONS, ...SALES_FUNCTIONS]));
  assert.deepEqual(functionGrantPlan(28, { workerRoles: [...WORKER_ROLES] }), [
    ...runtime([...REPORT_FUNCTIONS, ...SALES_FUNCTIONS]),
    { role: 'pickchick_fulfillment_sync', fn: 'append_cashier_order_report(uuid)' },
    { role: 'pickchick_fulfillment_worker', fn: 'append_cashier_order_report(uuid)' },
  ]);
  // The reviewed Kaspi 029 (test cashier) adds no helper: exactly the 028 plan.
  assert.deepEqual(
    functionGrantPlan(29, { workerRoles: [...WORKER_ROLES] }),
    functionGrantPlan(28, { workerRoles: [...WORKER_ROLES] }),
  );
  assert.deepEqual(WORKER_FUNCTIONS, ['append_cashier_order_report(uuid)']);
  for (const options of [
    { runtimeRole: 'Pickchick' },
    { runtimeRole: 'a;b' },
    { workerRoles: ['x"y'] },
  ])
    assert.throws(() => functionGrantPlan(28, options), /Invalid identifier/);
  // The POS sync login must hold no EXECUTE at all (native-pos-sync-db.mjs): never planned.
  assert.ok(!WORKER_ROLES.includes('pickchick_pos_sync'));
});

test('the planned helpers are the invoker functions the migrations call from triggers and code', async () => {
  const m016 = await migration('016_edge_cashier_reports.sql');
  const m026 = await migration('026_edge_pos_sales.sql');
  const signature = (fn) => {
    const [, name, args] = /^([a-z_]+)\(([a-z,]*)\)$/.exec(fn);
    return { name, args: args ? args.split(',') : [] };
  };
  const defined = (text, fn) => {
    const { name, args } = signature(fn);
    const match = new RegExp(
      `CREATE (?:OR REPLACE )?FUNCTION ${name}\\(([^)]*)\\)[^$]*?(LANGUAGE \\w+[^$]*?)AS \\$\\$`,
    ).exec(text);
    assert.ok(match, fn);
    // IN arguments only, as regprocedure prints them.
    const types = match[1]
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a && !a.startsWith('OUT '))
      .map((a) => a.split(/\s+/).at(-1));
    assert.deepEqual(types, args, fn);
    // Attributes may stand before the body or after it, up to the end of the statement.
    const end = text.indexOf('$$', match.index + match[0].length);
    const tail = text.slice(end + 2, text.indexOf(';', end + 2));
    assert.doesNotMatch(match[2] + tail, /SECURITY DEFINER/, fn);
  };
  for (const fn of REPORT_FUNCTIONS) defined(m016, fn);
  for (const fn of SALES_FUNCTIONS) defined(m026, fn);
  // The 016 trigger calls both report helpers as the role that wrote the row.
  assert.match(m016, /PERFORM append_cashier_shift_report\(NEW\.id\)/);
  assert.match(m016, /PERFORM append_cashier_order_report\(NEW\.local_order_id\)/);
  assert.match(m016, /AFTER INSERT OR UPDATE ON fulfillment_reservations/);
  // Reported owner-rights functions exist as definers in their own migrations.
  assert.deepEqual(OWNER_FUNCTIONS, [
    'edge_restore_fence(boolean)',
    'fulfillment_display_allocate(uuid)',
  ]);
});

test('029 is accepted only as the reviewed Kaspi file: trigger functions only, nothing replaced', async () => {
  assert.deepEqual(Object.keys(KASPI_SCHEMA_ROW), ['scope', 'version', 'checksum']);
  assert.equal(KASPI_SCHEMA_ROW.scope, 'edge');
  assert.match(KASPI_SCHEMA_ROW.version, /^029_[a-z_]+\.sql$/);
  assert.match(KASPI_SCHEMA_ROW.checksum, /^[a-f0-9]{64}$/);
  const ledger = JSON.parse(
    await readFile(new URL('native-edge-backup-ledger.json', windows), 'utf8'),
  );
  assert.ok(ledger.length >= PINNED_MIN);
  const files = (await readdir(migrations)).filter((name) => name.startsWith('029_'));
  if (files.length === 0) {
    // The cutover branch ends at 028; the Kaspi 029 runs on the test cashier only.
    assert.equal(ledger.length, PINNED_MIN);
    return;
  }
  // Once 029 is in this repository it must be the reviewed file, or this tool is reviewed again.
  assert.deepEqual(files, [KASPI_SCHEMA_ROW.version]);
  const text = await migration(KASPI_SCHEMA_ROW.version);
  assert.equal(createHash('sha256').update(text).digest('hex'), KASPI_SCHEMA_ROW.checksum);
  const { version, checksum, scope } = ledger[PINNED_MIN];
  assert.deepEqual({ scope, version, checksum }, KASPI_SCHEMA_ROW);
  const created = [...text.matchAll(/CREATE (OR REPLACE )?FUNCTION (\w+)\(\) RETURNS (\w+)/g)];
  assert.equal(created.length, (text.match(/CREATE (?:OR REPLACE )?FUNCTION/g) ?? []).length);
  assert.ok(created.length > 0);
  for (const [, replace, name, returns] of created) {
    assert.equal(replace, undefined, name);
    assert.equal(returns, 'trigger', name);
  }
  assert.doesNotMatch(text, /SECURITY DEFINER|GRANT |REVOKE /);
  // Its triggers call built-ins only: no earlier non-trigger edge function is named in it.
  const earlier = (await readdir(migrations)).filter((name) => /^0(0\d|1\d|2[0-8])_/.test(name));
  const helpers = new Set();
  for (const name of earlier)
    for (const [, fn, head] of (await migration(name)).matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION (\w+)\(([^$]*?)AS \$\$/g,
    ))
      if (!/RETURNS trigger\b/.test(head)) helpers.add(fn);
  assert.ok(helpers.has('append_cashier_order_report') && helpers.has('pos_shift_cash'));
  for (const fn of helpers) assert.doesNotMatch(text, new RegExp(`\\b${fn}\\s*\\(`), fn);
});

test('the tool grants or revokes EXECUTE on functions only and never prints driver text', async () => {
  const tool = (await readFile(new URL('cashier-report-function-grants.mjs', windows), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const statements = tool.match(
    /`\$\{mode === 'apply' \? 'GRANT' : 'REVOKE'\} EXECUTE ON FUNCTION/g,
  );
  assert.equal(statements?.length, 1);
  assert.doesNotMatch(
    tool,
    /GRANT (ALL|SELECT|INSERT|UPDATE|DELETE|USAGE)|ALTER DEFAULT|SECURITY DEFINER/,
  );
  assert.doesNotMatch(tool, /pickchick_pos_sync/);
  assert.match(tool, /pg_advisory_xact_lock/);
  assert.match(tool, /SET LOCAL lock_timeout='5s'/);
  // The CLI refuses anything but the local edge owner before loading a driver.
  const script = fileURLToPath(new URL('cashier-report-function-grants.mjs', windows));
  for (const [env, args, message] of [
    [
      { EDGE_DATABASE_URL: 'postgresql://pickchick_edge_runtime:x@127.0.0.1:55433/pickchick_edge' },
      ['inspect', fileURLToPath(windows)],
      'Local edge owner required',
    ],
    [
      { EDGE_DATABASE_URL: 'postgresql://pickchick_edge_owner:x@10.0.0.5:55433/pickchick_edge' },
      ['apply', fileURLToPath(windows)],
      'Local edge owner required',
    ],
    [
      { EDGE_DATABASE_URL: 'postgresql://pickchick_edge_owner:x@127.0.0.1:55433/pickchick_edge' },
      ['apply'],
      'Invalid invocation',
    ],
    [{}, ['inspect', fileURLToPath(windows)], undefined],
  ])
    await assert.rejects(
      promisify(execFile)(process.execPath, [script, ...args], {
        env: { PATH: process.env.PATH, ...env },
      }),
      (error) => {
        assert.equal(error.code, 1);
        const line = JSON.parse(error.stderr.trim());
        assert.equal(line.event, 'cashier_report_function_grants_failed');
        assert.equal(line.message, message);
        assert.doesNotMatch(error.stderr, /:x@|10\.0\.0\.5/);
        return true;
      },
    );
});
