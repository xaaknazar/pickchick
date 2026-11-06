import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { StaffSetupSchema } from '@pickchick/contracts';
import { withSyncDatabases } from '../helpers/sync.mjs';
import {
  EDGE_STAFF_ID_VECTOR,
  EDGE_STAFF_ROLES,
  edgeStaffId,
} from '../../packages/backoffice-core/dist/index.js';
import {
  ROLES,
  edgeStaffId as scriptStaffId,
  rosterRows,
  run,
} from '../../scripts/edge-staff-id.mjs';

/**
 * scripts/edge-staff-id.mjs (lane bo-ui, design-bo-ui.md 5.7, runbook «Касса в бэк-офисе»): the
 * operator's copy of edgeStaffId. Its bytes must equal the back office's, or «Касса» shows codes
 * instead of names. Synthetic ids only.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/edge-staff-id.mjs', import.meta.url));
const exec = promisify(execFile);
const cli = (args, env = {}) =>
  exec(process.execPath, [SCRIPT, ...args], {
    env: { PATH: process.env.PATH, ...env },
    timeout: 20000,
  });

test('the script and the back office compute the same pinned vector', async () => {
  assert.deepEqual(ROLES, [...EDGE_STAFF_ROLES]);
  for (const role of ROLES) {
    assert.equal(
      scriptStaffId(EDGE_STAFF_ID_VECTOR.employee_id, role),
      EDGE_STAFF_ID_VECTOR.ids[role],
    );
    const { stdout } = await cli(['--employee', EDGE_STAFF_ID_VECTOR.employee_id, '--role', role]);
    assert.deepEqual(JSON.parse(stdout), {
      employee_id: EDGE_STAFF_ID_VECTOR.employee_id,
      role,
      staff_id: EDGE_STAFF_ID_VECTOR.ids[role],
    });
  }
  // Random cards agree too, upper-case ids included.
  for (let i = 0; i < 20; i++) {
    const id = randomUUID();
    for (const role of ROLES) {
      assert.equal(scriptStaffId(id, role), edgeStaffId(id, role));
      assert.equal(scriptStaffId(id.toUpperCase(), role), edgeStaffId(id, role));
    }
  }
});

test('--terminal and --name print the exact staff-setup.mjs file', async () => {
  const employee = randomUUID(),
    terminal = randomUUID();
  const { stdout } = await cli([
    '--employee',
    employee,
    '--role',
    'shift_manager',
    '--terminal',
    terminal,
    '--name',
    '  Синтетический начальник смены  ',
  ]);
  const setup = JSON.parse(stdout);
  assert.deepEqual(setup, {
    staff_id: edgeStaffId(employee, 'shift_manager'),
    terminal_id: terminal,
    name: 'Синтетический начальник смены',
    role: 'shift_manager',
  });
  assert.deepEqual(StaffSetupSchema.parse(setup), setup);
});

test('bad arguments are refused with exit code 2 and nothing on stdout', async () => {
  const employee = randomUUID();
  for (const args of [
    [],
    ['--employee', employee],
    ['--employee', employee, '--role', 'manager'],
    ['--employee', 'card-1', '--role', 'cashier'],
    ['--employee', employee, '--role', 'cashier', '--terminal', 'desk-1', '--name', 'X'],
    ['--employee', employee, '--role', 'cashier', '--terminal', randomUUID()],
    ['--employee', employee, '--role', 'cashier', '--role', 'kitchen'],
    ['--employee', employee, '--role', 'cashier', '--token', 'x'],
    ['--list'],
    ['--list', '--branch', 'one'],
  ]) {
    await assert.rejects(cli(args), (error) => error.code === 2 && error.stdout === '');
  }
  await assert.rejects(
    cli(['--list', '--branch', randomUUID()]),
    (error) => error.code === 2 && /CLOUD_DATABASE_URL required/.test(error.stderr),
  );
  assert.throws(() => run(['--employee', employee]), /Usage/);
});

test('--list prints every employee card of the branch with its three edge ids (read only)', () =>
  withSyncDatabases(async (c) => {
    const cards = [
      { id: randomUUID(), name: 'Синтетический кассир', role: 'cashier', active: true },
      { id: randomUUID(), name: 'Синтетический повар', role: 'cook', active: false },
    ];
    for (const card of cards)
      await c.cloud.pool.query(
        `INSERT INTO bo_records(id,branch_id,organization_id,kind,revision,payload)
         VALUES($1,$2,$3,'employee',1,$4)`,
        [
          card.id,
          c.branch,
          c.org,
          { name: card.name, role: card.role, active: card.active, note: '' },
        ],
      );
    const before = (await c.cloud.pool.query('SELECT count(*)::int n FROM bo_records')).rows[0].n;
    const { stdout } = await cli(['--list', '--branch', c.branch], {
      CLOUD_DATABASE_URL: c.cloud.config.databaseUrl,
    });
    const rows = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      rows,
      rosterRows(cards.map((card) => ({ ...card, deleted: null }))).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
    for (const row of rows)
      for (const role of ROLES) assert.equal(row[role], edgeStaffId(row.employee_id, role));
    assert.equal(rows.find((r) => r.card_role === 'cook').active, false);
    assert.equal(
      (await c.cloud.pool.query('SELECT count(*)::int n FROM bo_records')).rows[0].n,
      before,
    );
  }));
