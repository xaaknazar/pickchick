// 18.11.2026 (cutover 19.11): the additive EXECUTE tool for the cashier report and sales helpers
// that invoker triggers call as the edge runtime and the fulfillment worker on a native edge
// (PUBLIC EXECUTE revoked by native-foundation-db.mjs). Plan per schema, names bound to the
// migrations, nothing but EXECUTE, and a CLI that refuses anything but the local edge owner.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  OWNER_FUNCTIONS,
  REPORT_FUNCTIONS,
  RUNTIME_ROLE,
  SALES_FUNCTIONS,
  WORKER_FUNCTIONS,
  WORKER_ROLES,
  functionGrantPlan,
} from '../../infra/windows/cashier-report-function-grants.mjs';

const windows = new URL('../../infra/windows/', import.meta.url);
const migration = (name) =>
  readFile(new URL(`../../db/edge/migrations/${name}`, import.meta.url), 'utf8');

test('functionGrantPlan: report helpers from schema016, sales helpers from schema026, worker gets the order report only', () => {
  for (const length of [15, 29, 16.5, '28', undefined])
    assert.throws(() => functionGrantPlan(length), /Reviewed schema016 to schema028 required/);
  const runtime = (fns) => fns.map((fn) => ({ role: RUNTIME_ROLE, fn }));
  assert.deepEqual(functionGrantPlan(16), runtime(REPORT_FUNCTIONS));
  assert.deepEqual(functionGrantPlan(25), runtime(REPORT_FUNCTIONS));
  assert.deepEqual(functionGrantPlan(26), runtime([...REPORT_FUNCTIONS, ...SALES_FUNCTIONS]));
  assert.deepEqual(functionGrantPlan(28, { workerRoles: [...WORKER_ROLES] }), [
    ...runtime([...REPORT_FUNCTIONS, ...SALES_FUNCTIONS]),
    { role: 'pickchick_fulfillment_sync', fn: 'append_cashier_order_report(uuid)' },
    { role: 'pickchick_fulfillment_worker', fn: 'append_cashier_order_report(uuid)' },
  ]);
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
