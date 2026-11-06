import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import {
  BACKOFFICE_DESIGNATIONS,
  BACKOFFICE_EFFECTIVE_ROLES,
  BACKOFFICE_PERMISSIONS,
  Backoffice,
  BackofficeError,
  CloudChannelStops,
  Command,
  ROLE_PERMISSIONS,
  backofficeOptions,
  can,
  commandPermission,
  designateBackoffice,
  effectiveRole,
  grantBackoffice,
  permissionsOf,
  requirePermission,
} from '../dist/index.js';
import { Finance } from '../dist/finance.js';
import { Workforce } from '../dist/workforce-store.js';
import { Reconciliation, grantReconciliationAccountant } from '../dist/reconciliation.js';
import * as contracts from '../../contracts/dist/index.js';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import {
  SALES_REPORT_TABLES,
  assertBackofficeCutoverPrivileges,
  backofficeCutoverGrants,
  backofficeCutoverPrivileges,
} from '../../../infra/staging/backoffice-cutover-grants.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));
const reason = (code) => (error) =>
  error instanceof BackofficeError && error.code === 'FORBIDDEN' && error.reason === code;
const bareForbidden = (error) =>
  error instanceof BackofficeError && error.code === 'FORBIDDEN' && error.reason === undefined;

// ---------------------------------------------------------------- pure: matrix and flags ----

test('role enums are verbatim copies of the cutover contract enums', () => {
  assert.deepEqual([...BACKOFFICE_DESIGNATIONS], contracts.BackofficeDesignationSchema.options);
  assert.deepEqual(
    [...BACKOFFICE_EFFECTIVE_ROLES],
    contracts.BackofficeEffectiveRoleSchema.options,
  );
});

test('effectiveRole: a manager grant wins, a designation needs the flag, default analyst', () => {
  for (const designation of [null, 'shift_manager', 'accountant']) {
    assert.equal(effectiveRole('manager', designation, true), 'manager');
    assert.equal(effectiveRole('manager', designation, false), 'manager');
    assert.equal(effectiveRole('analyst', designation, false), 'analyst');
  }
  assert.equal(effectiveRole('analyst', null, true), 'analyst');
  assert.equal(effectiveRole('analyst', 'shift_manager', true), 'shift_manager');
  assert.equal(effectiveRole('analyst', 'accountant', true), 'accountant');
});

test('P0 permission matrix (contracts 5.10)', () => {
  assert.deepEqual(permissionsOf('manager'), [...BACKOFFICE_PERMISSIONS]);
  assert.deepEqual(permissionsOf('shift_manager'), [
    'reports.read',
    'stops.write',
    'orders.cancel',
    'orders.refund',
    'stock.receipt',
    'stock.waste',
    'stock.count',
  ]);
  assert.deepEqual(permissionsOf('accountant'), [
    'reports.read',
    'finance.read',
    'finance.write',
    'reconciliation.read',
    'reconciliation.write',
    'workforce.read',
    'stock.receipt',
  ]);
  // Analyst: read-only, exactly the sections it reads today.
  assert.deepEqual(permissionsOf('analyst'), [
    'reports.read',
    'finance.read',
    'reconciliation.read',
    'workforce.read',
  ]);
  for (const role of BACKOFFICE_EFFECTIVE_ROLES) {
    assert.ok(can(role, 'reports.read'));
    for (const permission of ROLE_PERMISSIONS[role])
      assert.ok(BACKOFFICE_PERMISSIONS.includes(permission));
  }
  // Shift manager: no finance, reconciliation, rates or payroll; accountant: no cancel/refund/waste.
  for (const p of ['finance.read', 'finance.write', 'reconciliation.read', 'workforce.read'])
    assert.equal(can('shift_manager', p), false);
  for (const p of ['orders.cancel', 'orders.refund', 'stock.waste', 'stock.count', 'stops.write'])
    assert.equal(can('accountant', p), false);
  for (const p of BACKOFFICE_PERMISSIONS) assert.equal(can('analyst', p), p.endsWith('.read'), p);
});

test('requirePermission keeps the bare FORBIDDEN for manager/analyst and explains designations', () => {
  assert.doesNotThrow(() => requirePermission('manager', 'finance.write'));
  assert.throws(() => requirePermission('analyst', 'stock.waste'), bareForbidden);
  assert.throws(() => requirePermission('shift_manager', 'finance.read'), reason('ROLE_FORBIDDEN'));
  assert.throws(() => requirePermission('accountant', 'stock.waste'), reason('ROLE_FORBIDDEN'));
});

test('every back-office command type maps to one permission', () => {
  const id = randomUUID();
  const line = { ingredient_id: id, quantity: '1', value_minor: '0', expected_revision: 0 };
  const commands = [
    [{ type: 'save', kind: 'promo', id, expected_revision: 0, payload: {} }, 'records.write'],
    [{ type: 'publish', kind: 'promo', id, expected_revision: 1 }, 'records.write'],
    [{ type: 'deliver_station_plan' }, 'records.write'],
    [{ type: 'stock', kind: 'receipt', reference: 'R', lines: [line] }, 'stock.receipt'],
    [{ type: 'stock', kind: 'waste', reference: 'R', lines: [line] }, 'stock.waste'],
    [{ type: 'stock', kind: 'count', reference: 'R', lines: [line] }, 'stock.count'],
    [
      {
        type: 'produce',
        recipe_id: id,
        recipe_revision: 1,
        batches: 1,
        expected_balances: {},
        reference: 'R',
      },
      'stock.production',
    ],
    [{ type: 'consume', order_id: id, expected_balances: {} }, 'stock.production'],
    [{ type: 'revoke_device', id, confirm_name: 'Synthetic' }, 'devices.write'],
    [{ type: 'cancel_order', id, expected_version: 1 }, 'orders.cancel'],
    [{ type: 'refund', id, capture_id: id, amount_minor: '1' }, 'orders.refund'],
    [
      { type: 'manual_refund', id, capture_id: id, amount_minor: '1', bank_reference: 'KP-1' },
      'orders.refund',
    ],
    [{ type: 'withdraw_refund', id, refund_id: id }, 'orders.refund'],
  ];
  const types = new Set();
  for (const [input, permission] of commands) {
    const parsed = Command.parse(input);
    types.add(parsed.type);
    assert.equal(commandPermission(parsed), permission, input.type);
  }
  assert.deepEqual([...types].sort(), [...Command.options.map((o) => o.shape.type.value)].sort());
});

test('BACKOFFICE_ROLES_ENABLED and BACKOFFICE_STOCK_V2_ENABLED default off, true|false only', () => {
  assert.equal(backofficeOptions({}).rolesEnabled, false);
  assert.equal(backofficeOptions({}).stockV2Enabled, false);
  assert.equal(backofficeOptions({ BACKOFFICE_ROLES_ENABLED: 'true' }).rolesEnabled, true);
  assert.equal(backofficeOptions({ BACKOFFICE_STOCK_V2_ENABLED: 'true' }).stockV2Enabled, true);
  for (const value of ['1', 'TRUE', 'yes', '']) {
    assert.throws(() => backofficeOptions({ BACKOFFICE_ROLES_ENABLED: value }));
    assert.throws(() => backofficeOptions({ BACKOFFICE_STOCK_V2_ENABLED: value }));
  }
});

test('backoffice cutover grants: SELECT on designations only with the back-office and the flag', () => {
  assert.deepEqual(backofficeCutoverPrivileges({ backoffice: true, roles: true }), {
    bo_role_designations: ['SELECT'],
  });
  for (const options of [
    { backoffice: false, roles: true },
    { backoffice: true, roles: false },
    { backoffice: false, roles: false },
  ])
    assert.deepEqual(backofficeCutoverPrivileges(options), {});
  assert.throws(() => backofficeCutoverPrivileges({ backoffice: 'true', roles: true }));
  assert.throws(() => backofficeCutoverGrants('Bad-Role', { backoffice: true, roles: true }));
  assert.match(
    backofficeCutoverGrants('pickchick_app', { backoffice: true, roles: true }),
    /to_regclass\('public\.bo_role_designations'\) IS NOT NULL THEN REVOKE ALL ON "public"\."bo_role_designations" FROM "pickchick_app";GRANT SELECT ON "public"\."bo_role_designations" TO "pickchick_app";/,
  );
  assert.doesNotMatch(
    backofficeCutoverGrants('pickchick_app', { backoffice: true, roles: false }),
    /GRANT SELECT ON "public"\."bo_role_designations"/,
  );
  // Contracts 3.2 point 2: with the back office the helper also grants read rights on the
  // cloud073 report tables that exist (additive, no REVOKE: the pos helper owns their reset).
  const sales = backofficeCutoverGrants('pickchick_app', { backoffice: true, roles: false });
  for (const table of SALES_REPORT_TABLES)
    assert.match(
      sales,
      new RegExp(
        `IF to_regclass\\('public\\.${table}'\\) IS NOT NULL THEN GRANT SELECT ON "public"\\."${table}" TO "pickchick_app"; END IF;`,
      ),
    );
  assert.doesNotMatch(sales, /cloud_pos_sale_inbox|cloud_pos_fiscal_receipts|REVOKE[^;]*cloud_pos/);
  for (const roles of [true, false])
    assert.doesNotMatch(
      backofficeCutoverGrants('pickchick_app', { backoffice: false, roles }),
      /GRANT|cloud_pos/,
    );
});

// ------------------------------------------------------------------------- PostgreSQL ----

/** Manager, plain analyst and two analysts that may be designated. */
async function people(c) {
  const person = async (name, role) => {
    const p = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name,
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, p.actor_id, c.branch, role);
    return p;
  };
  return {
    manager: await person('Синтетический управляющий', 'manager'),
    analyst: await person('Синтетический аналитик', 'analyst'),
    shift: await person('Синтетический начальник смены', 'analyst'),
    accountant: await person('Синтетический бухгалтер', 'analyst'),
  };
}
const request = (command, text = 'Synthetic role check') => ({
  request_id: randomUUID(),
  reason: text,
  command,
});
async function ingredient(bo, token, branch) {
  const id = randomUUID();
  await bo.command(
    token,
    branch,
    request({
      type: 'save',
      kind: 'ingredient',
      id,
      expected_revision: 0,
      payload: { name: 'Synthetic flour', unit: 'g', minimum: '0', active: true },
    }),
  );
  return id;
}
const stock = (kind, id, revision, quantity = '100') =>
  request({
    type: 'stock',
    kind,
    reference: 'SYN-' + kind,
    lines: [{ ingredient_id: id, quantity, value_minor: '1000', expected_revision: revision }],
  });

/** GET branches/:id keys as of D0 (5b212949): the flag-off payload never gains a key. */
const D0_READ_KEYS = [
  'schema_version',
  'branch_id',
  'role',
  'as_of',
  'period_start',
  'period_end',
  'timezone',
  'operational_shift_filter',
  'cashier_shifts',
  'cashier_orders',
  'cashier_metrics',
  'selected_shift',
  'coverage',
  'period',
  'records',
  'stock',
  'orders',
  'pos',
  'metrics',
  'chart',
  'finance',
  'refunds',
  'issues',
  'devices',
  'availability',
  'kitchen',
  'guests',
  'audit',
  'catalog_audit',
  'documents',
  'publications',
  'station_plan',
  'limits',
  'truncated',
  'capabilities',
];
const D0_CAPABILITIES = [
  'operational_shift_filter',
  'bank_settlement',
  'push_delivery',
  'external_reviews',
  'fiscal_shift',
  'edge_configuration_delivery',
];
const D0_DOCUMENT_KEYS = [
  'id',
  'kind',
  'reference',
  'reason',
  'order_id',
  'created_at',
  'actor_id',
  'actor_name',
  'lines',
];
const withoutClock = (state) => ({ ...state, as_of: null });

test('designations: append-only, latest row wins, refused for managers and strangers', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const stranger = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Синтетический без доступа',
      branch_ids: [c.branch],
    });
    const designated = await designateBackoffice(
      c.cloud.pool,
      p.shift.actor_id,
      c.branch,
      'shift_manager',
      'Т7: начальник смены',
    );
    assert.equal(designated.grant, 'analyst');
    assert.equal(designated.previous_role, null);
    assert.equal(designated.role, 'shift_manager');
    await assert.rejects(
      designateBackoffice(c.cloud.pool, p.manager.actor_id, c.branch, 'accountant', 'Нельзя'),
      { code: 'CONFLICT' },
    );
    // Withdrawing a designation of a manager is harmless and allowed.
    await designateBackoffice(c.cloud.pool, p.manager.actor_id, c.branch, null, 'Снять');
    await assert.rejects(
      designateBackoffice(c.cloud.pool, stranger.actor_id, c.branch, 'accountant', 'Нет гранта'),
      { code: 'FORBIDDEN' },
    );
    for (const [role, text] of [
      ['owner', 'Неизвестная роль'],
      ['accountant', 'x'],
      ['accountant', 'я'.repeat(501)],
    ])
      await assert.rejects(
        designateBackoffice(c.cloud.pool, p.accountant.actor_id, c.branch, role, text),
        { code: 'INVALID_REQUEST' },
      );
    const bo = new Backoffice(c.cloud.pool, true, { rolesEnabled: true });
    assert.equal((await bo.read(p.shift.token, c.branch)).effective_role, 'shift_manager');
    const withdrawn = await designateBackoffice(
      c.cloud.pool,
      p.shift.actor_id,
      c.branch,
      null,
      'Смена закончилась',
    );
    assert.equal(withdrawn.previous_role, 'shift_manager');
    assert.equal((await bo.read(p.shift.token, c.branch)).effective_role, 'analyst');
    await designateBackoffice(c.cloud.pool, p.shift.actor_id, c.branch, 'accountant', 'Новая');
    assert.equal((await bo.read(p.shift.token, c.branch)).effective_role, 'accountant');
    await assert.rejects(c.cloud.pool.query('UPDATE bo_role_designations SET role=NULL'), {
      message: /immutable/,
    });
    await assert.rejects(c.cloud.pool.query('DELETE FROM bo_role_designations'), {
      message: /immutable/,
    });
    await assert.rejects(
      c.cloud.pool.query(
        "INSERT INTO bo_role_designations(actor_id,branch_id,role,reason,source) VALUES($1,$2,'accountant','Синтетика','http')",
        [p.shift.actor_id, c.branch],
      ),
      { code: '23514' },
    );
    // A later analyst-to-manager grant makes the designation irrelevant (manager wins).
    await grantBackoffice(c.cloud.pool, p.shift.actor_id, c.branch, 'manager');
    assert.equal((await bo.read(p.shift.token, c.branch)).effective_role, 'manager');
  }));

test('a grant change ends a designation: designate, promote, demote is an analyst again', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, { rolesEnabled: true });
    const role = async () => (await bo.read(p.shift.token, c.branch)).effective_role;
    const designate = (text) =>
      designateBackoffice(c.cloud.pool, p.shift.actor_id, c.branch, 'shift_manager', text);
    await designate('Т7: начальник смены');
    assert.equal(await role(), 'shift_manager');
    // Recording the same grant role again is not a change: the designation stays.
    await grantBackoffice(c.cloud.pool, p.shift.actor_id, c.branch, 'analyst');
    assert.equal(await role(), 'shift_manager');
    await grantBackoffice(c.cloud.pool, p.shift.actor_id, c.branch, 'manager');
    assert.equal(await role(), 'manager');
    // Demoted: no shift manager rights come back with the old designation.
    await grantBackoffice(c.cloud.pool, p.shift.actor_id, c.branch, 'analyst');
    const state = await bo.read(p.shift.token, c.branch);
    assert.equal(state.role, 'analyst');
    assert.equal(state.effective_role, 'analyst');
    assert.deepEqual(state.permissions, [
      'reports.read',
      'finance.read',
      'reconciliation.read',
      'workforce.read',
    ]);
    // The operator designates anew after the change; the record shows nothing was in force.
    const again = await designate('Снова начальник смены после понижения');
    assert.equal(again.previous_role, null);
    assert.equal(await role(), 'shift_manager');
    // The other analyst and the flag-off cabinet are untouched.
    assert.equal((await bo.read(p.accountant.token, c.branch)).effective_role, 'analyst');
    const off = new Backoffice(c.cloud.pool, true, {});
    assert.equal((await off.read(p.shift.token, c.branch)).effective_role, undefined);
  }));

test('flag off: designations change nothing and GET branches/:id keeps the D0 payload', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    await designateBackoffice(
      c.cloud.pool,
      p.shift.actor_id,
      c.branch,
      'shift_manager',
      'Т7: назначение',
    );
    await designateBackoffice(
      c.cloud.pool,
      p.accountant.actor_id,
      c.branch,
      'accountant',
      'Т7: назначение',
    );
    const off = new Backoffice(c.cloud.pool, true, {});
    const id = await ingredient(off, p.manager.token, c.branch);
    await off.command(p.manager.token, c.branch, stock('receipt', id, 0));
    for (const who of [p.analyst, p.shift, p.accountant]) {
      const state = await off.read(who.token, c.branch);
      assert.equal(state.role, 'analyst');
      assert.deepEqual(Object.keys(state), D0_READ_KEYS);
      assert.deepEqual(Object.keys(state.capabilities), D0_CAPABILITIES);
      assert.deepEqual(Object.keys(state.documents[0]), D0_DOCUMENT_KEYS);
      // Every write stays manager-only with the bare FORBIDDEN of today.
      await assert.rejects(off.command(who.token, c.branch, stock('waste', id, 1)), bareForbidden);
      await assert.rejects(
        off.command(who.token, c.branch, stock('receipt', id, 1)),
        bareForbidden,
      );
    }
    const manager = await off.read(p.manager.token, c.branch);
    assert.deepEqual(Object.keys(manager), D0_READ_KEYS);
    // Finance, time sheet and reconciliation: exactly the grant roles.
    const finance = new Finance(c.cloud.pool, true, {});
    const range = { start_date: '2026-11-01', end_date: '2026-11-30' };
    const financeState = await finance.read(p.shift.token, c.branch, range);
    assert.equal(financeState.role, 'analyst');
    assert.equal('effective_role' in financeState, false);
    assert.equal('permissions' in financeState, false);
    await assert.rejects(
      finance.command(p.accountant.token, c.branch, {
        request_id: randomUUID(),
        reason: 'Synthetic account',
        command: {
          type: 'account',
          id: randomUUID(),
          name: 'Synthetic cash',
          kind: 'cash',
          opening_date: '2026-11-01',
          opening_minor: '0',
        },
      }),
      bareForbidden,
    );
    const workforce = new Workforce(c.cloud.pool, true, {});
    assert.equal((await workforce.read(p.shift.token, c.branch, '2026-11-01')).role, 'analyst');
    const reconciliation = new Reconciliation(c.cloud.pool, true, {});
    const rec = await reconciliation.read(p.accountant.token, c.branch, { day: '2026-11-04' });
    assert.equal(rec.role, 'analyst');
    assert.equal(rec.writable, false);
  }));

test('flag on: shift manager and accountant rights in commands, finance, time sheet, reconciliation', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    await designateBackoffice(
      c.cloud.pool,
      p.shift.actor_id,
      c.branch,
      'shift_manager',
      'Т7: назначение',
    );
    await designateBackoffice(
      c.cloud.pool,
      p.accountant.actor_id,
      c.branch,
      'accountant',
      'Т7: назначение',
    );
    const on = new Backoffice(c.cloud.pool, true, { rolesEnabled: true });
    const off = new Backoffice(c.cloud.pool, true, {});
    const id = await ingredient(on, p.manager.token, c.branch);

    // GET branches/:id: role unchanged, new keys are purely additive.
    const shiftState = await on.read(p.shift.token, c.branch);
    assert.equal(shiftState.role, 'analyst');
    assert.equal(shiftState.effective_role, 'shift_manager');
    assert.deepEqual(shiftState.permissions, permissionsOf('shift_manager'));
    assert.equal(shiftState.capabilities.roles, true);
    assert.equal((await on.read(p.accountant.token, c.branch)).effective_role, 'accountant');
    assert.equal((await on.read(p.analyst.token, c.branch)).effective_role, 'analyst');
    const managerOn = await on.read(p.manager.token, c.branch);
    const managerOff = await off.read(p.manager.token, c.branch);
    assert.equal(managerOn.effective_role, 'manager');
    assert.deepEqual(managerOn.permissions, [...BACKOFFICE_PERMISSIONS]);
    const stripped = { ...managerOn, capabilities: { ...managerOn.capabilities } };
    delete stripped.effective_role;
    delete stripped.permissions;
    delete stripped.capabilities.roles;
    assert.deepEqual(withoutClock(stripped), withoutClock(managerOff));
    assert.deepEqual(Object.keys(stripped), D0_READ_KEYS);

    // Stock: the shift manager receives, wastes and counts; the accountant only receives.
    await on.command(p.shift.token, c.branch, stock('receipt', id, 0));
    await on.command(p.shift.token, c.branch, stock('waste', id, 1, '10'));
    await on.command(p.shift.token, c.branch, stock('count', id, 2, '80'));
    await on.command(p.accountant.token, c.branch, stock('receipt', id, 3));
    await assert.rejects(
      on.command(p.accountant.token, c.branch, stock('waste', id, 4, '1')),
      reason('ROLE_FORBIDDEN'),
    );
    await assert.rejects(
      on.command(p.accountant.token, c.branch, stock('count', id, 4, '1')),
      reason('ROLE_FORBIDDEN'),
    );
    await assert.rejects(
      on.command(p.analyst.token, c.branch, stock('receipt', id, 4)),
      bareForbidden,
    );
    // Manager-only commands stay manager-only.
    for (const command of [
      { type: 'save', kind: 'ingredient', id: randomUUID(), expected_revision: 0, payload: {} },
      { type: 'revoke_device', id: c.device, confirm_name: 'Synthetic' },
      { type: 'deliver_station_plan' },
      { type: 'consume', order_id: randomUUID(), expected_balances: {} },
    ])
      for (const who of [p.shift, p.accountant])
        await assert.rejects(
          on.command(who.token, c.branch, request(command)),
          reason('ROLE_FORBIDDEN'),
        );
    // Cloud order cancellation and refunds: the shift manager passes the role check (the
    // synthetic order does not exist), the accountant does not.
    const orderCommands = [
      { type: 'cancel_order', id: randomUUID(), expected_version: 1 },
      {
        type: 'manual_refund',
        id: randomUUID(),
        capture_id: randomUUID(),
        amount_minor: '100',
        bank_reference: 'KP-SYN-1',
      },
    ];
    for (const command of orderCommands) {
      await assert.rejects(on.command(p.shift.token, c.branch, request(command)), {
        code: 'NOT_FOUND',
      });
      await assert.rejects(
        on.command(p.accountant.token, c.branch, request(command)),
        reason('ROLE_FORBIDDEN'),
      );
      await assert.rejects(off.command(p.shift.token, c.branch, request(command)), bareForbidden);
    }
    // Audit keeps who did it; the replay of a shift manager's request is exact.
    const replay = stock('waste', id, 4, '1');
    const first = await on.command(p.shift.token, c.branch, replay);
    assert.deepEqual(await on.command(p.shift.token, c.branch, replay), first);
    assert.equal(
      (
        await c.cloud.pool.query(
          "SELECT count(*)::int n FROM bo_audit WHERE actor_id=$1 AND action='stock:waste'",
          [p.shift.actor_id],
        )
      ).rows[0].n,
      2,
    );

    // Stops: a shift manager passes the role check of both stop paths.
    const stopRequest = {
      request_id: randomUUID(),
      catalog_ref: { product_id: 'synthetic-burger' },
      stopped: true,
      duration: 'manual',
      reason: 'Закончились булки',
      expected_version: 0,
    };
    await assert.rejects(on.requestStop(p.shift.token, c.branch, stopRequest), {
      reason: 'REMOTE_STOPS_DISABLED',
    });
    await assert.rejects(
      on.requestStop(p.accountant.token, c.branch, stopRequest),
      reason('ROLE_FORBIDDEN'),
    );
    await assert.rejects(off.requestStop(p.shift.token, c.branch, stopRequest), bareForbidden);
    const channelOn = new CloudChannelStops(c.cloud.pool, { enabled: true, rolesEnabled: true });
    const channelOff = new CloudChannelStops(c.cloud.pool, { enabled: true });
    const cloudStop = { ...stopRequest, request_id: randomUUID() };
    await assert.rejects(channelOn.setStop(p.shift.token, c.branch, cloudStop), {
      detail: 'CLOUD_STOPS_DISABLED',
    });
    await assert.rejects(
      channelOn.setStop(p.accountant.token, c.branch, cloudStop),
      reason('ROLE_FORBIDDEN'),
    );
    await assert.rejects(channelOff.setStop(p.shift.token, c.branch, cloudStop), bareForbidden);
    assert.equal((await channelOn.read(p.shift.token, c.branch)).role, 'analyst');

    // Finance: the shift manager does not see it; the accountant writes; the analyst reads.
    const finance = new Finance(c.cloud.pool, true, { rolesEnabled: true });
    const range = { start_date: '2026-11-01', end_date: '2026-11-30' };
    await assert.rejects(finance.read(p.shift.token, c.branch, range), reason('ROLE_FORBIDDEN'));
    const account = {
      request_id: randomUUID(),
      reason: 'Synthetic account',
      command: {
        type: 'account',
        id: randomUUID(),
        name: 'Synthetic cash',
        kind: 'cash',
        opening_date: '2026-11-01',
        opening_minor: '0',
      },
    };
    assert.deepEqual(await finance.command(p.accountant.token, c.branch, account), {
      id: account.command.id,
    });
    await assert.rejects(
      finance.command(p.shift.token, c.branch, { ...account, request_id: randomUUID() }),
      reason('ROLE_FORBIDDEN'),
    );
    await assert.rejects(
      finance.command(p.analyst.token, c.branch, { ...account, request_id: randomUUID() }),
      bareForbidden,
    );
    const accountantFinance = await finance.read(p.accountant.token, c.branch, range);
    assert.equal(accountantFinance.role, 'analyst');
    assert.equal(accountantFinance.effective_role, 'accountant');
    assert.ok(accountantFinance.permissions.includes('finance.write'));
    assert.equal((await finance.read(p.analyst.token, c.branch, range)).effective_role, 'analyst');

    // Time sheet (rates and payroll): hidden from the shift manager, read-only for the accountant.
    const workforce = new Workforce(c.cloud.pool, true, { rolesEnabled: true });
    await assert.rejects(
      workforce.read(p.shift.token, c.branch, '2026-11-01'),
      reason('ROLE_FORBIDDEN'),
    );
    assert.equal(
      (await workforce.read(p.accountant.token, c.branch, '2026-11-01')).role,
      'analyst',
    );
    await assert.rejects(
      workforce.command(p.accountant.token, c.branch, {
        request_id: randomUUID(),
        reason: 'Synthetic employee',
        command: { type: 'delete', kind: 'plan', id: randomUUID(), expected_revision: 1 },
      }),
      reason('ROLE_FORBIDDEN'),
    );

    // Reconciliation: a designated accountant writes like an operator accountant.
    const reconciliation = new Reconciliation(c.cloud.pool, true, { rolesEnabled: true });
    const rec = await reconciliation.read(p.accountant.token, c.branch, { day: '2026-11-04' });
    assert.equal(rec.role, 'accountant');
    assert.equal(rec.writable, true);
    await assert.rejects(
      reconciliation.read(p.shift.token, c.branch, { day: '2026-11-04' }),
      reason('ROLE_FORBIDDEN'),
    );
    assert.equal(
      (await reconciliation.read(p.analyst.token, c.branch, { day: '2026-11-04' })).role,
      'analyst',
    );
    // The operator designation of 071 still works on its own.
    await grantReconciliationAccountant(c.cloud.pool, p.analyst.actor_id, c.branch, true);
    assert.equal(
      (await reconciliation.read(p.analyst.token, c.branch, { day: '2026-11-04' })).role,
      'accountant',
    );
  }));

test('new runtime on a cloud schema without 074: flags off unchanged, roles flag fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-cloud-073-'));
  try {
    for (const file of await readdir(MIGRATIONS))
      if (file.endsWith('.sql') && file < '074')
        await cp(join(MIGRATIONS, file), join(directory, file));
    await withSyncDatabases(
      async (c) => {
        assert.equal(
          (await c.cloud.pool.query("SELECT to_regclass('bo_role_designations') t")).rows[0].t,
          null,
        );
        const p = await people(c);
        const off = new Backoffice(c.cloud.pool, true, {});
        const on = new Backoffice(c.cloud.pool, true, { rolesEnabled: true });
        const id = await ingredient(off, p.manager.token, c.branch);
        await off.command(p.manager.token, c.branch, stock('receipt', id, 0));
        assert.deepEqual(Object.keys(await off.read(p.shift.token, c.branch)), D0_READ_KEYS);
        const state = await on.read(p.shift.token, c.branch);
        assert.equal(state.effective_role, 'analyst');
        assert.equal(state.capabilities.roles, false);
        assert.equal((await on.read(p.manager.token, c.branch)).effective_role, 'manager');
        await on.command(p.manager.token, c.branch, stock('waste', id, 1, '1'));
        await assert.rejects(
          on.command(p.shift.token, c.branch, stock('waste', id, 2)),
          bareForbidden,
        );
        await assert.rejects(
          designateBackoffice(
            c.cloud.pool,
            p.shift.actor_id,
            c.branch,
            'shift_manager',
            'Т7: назначение',
          ),
          { code: 'NOT_READY' },
        );
        // Then 074 is applied under the running runtime: nothing changes until designations exist.
        assert.deepEqual(await migrate(c.cloud.pool, MIGRATIONS, 'cloud'), [
          '074_cloud_backoffice_cutover.sql',
        ]);
        assert.equal((await on.read(p.shift.token, c.branch)).capabilities.roles, true);
        assert.equal((await on.read(p.shift.token, c.branch)).effective_role, 'analyst');
      },
      { cloudMigrationDirectory: directory },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('least privilege: the API role reads designations only through backofficeCutoverGrants', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    await designateBackoffice(
      c.cloud.pool,
      p.shift.actor_id,
      c.branch,
      'shift_manager',
      'Т7: назначение',
    );
    const schema = c.cloud.schema;
    const role = 'bo_cutover_' + randomUUID().replaceAll('-', '');
    let pool;
    await c.cloud.admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    try {
      await c.cloud.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await c.cloud.pool.query(backofficeGrants(role, true));
      const url = new URL(c.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
      pool = createPool(url.toString());
      const bo = new Backoffice(pool, true, { rolesEnabled: true });
      // Without the 074 grant the designation is ignored: fail closed to the analyst grant.
      await assertBackofficeCutoverPrivileges(
        c.cloud.pool,
        role,
        {
          backoffice: true,
          roles: false,
          stockV2: true,
        },
        schema,
      );
      let state = await bo.read(p.shift.token, c.branch);
      assert.equal(state.capabilities.roles, false);
      assert.equal(state.effective_role, 'analyst');
      await c.cloud.pool.query(
        backofficeCutoverGrants(role, { backoffice: true, roles: true }, schema),
      );
      await assertBackofficeCutoverPrivileges(
        c.cloud.pool,
        role,
        { backoffice: true, roles: true, stockV2: true },
        schema,
      );
      await assert.rejects(
        assertBackofficeCutoverPrivileges(
          c.cloud.pool,
          role,
          { backoffice: true, roles: false },
          schema,
        ),
        /bo_role_designations privileges/,
      );
      state = await bo.read(p.shift.token, c.branch);
      assert.equal(state.capabilities.roles, true);
      assert.equal(state.effective_role, 'shift_manager');
      // The runtime can never write a designation.
      await assert.rejects(
        pool.query(
          "INSERT INTO bo_role_designations(actor_id,branch_id,role,reason) VALUES($1,$2,'accountant','Синтетика')",
          [p.analyst.actor_id, c.branch],
        ),
        { code: '42501' },
      );
      // The reset revokes again when the flag is switched off.
      await c.cloud.pool.query(
        backofficeCutoverGrants(role, { backoffice: true, roles: false }, schema),
      );
      await assertBackofficeCutoverPrivileges(
        c.cloud.pool,
        role,
        { backoffice: true, roles: false },
        schema,
      );
    } finally {
      await pool?.end();
      // DROP OWNED also revokes every privilege of the role in this database.
      await c.cloud.admin.query(`DROP OWNED BY ${role}`);
      await c.cloud.admin.query(`DROP ROLE ${role}`);
    }
  }));

test('scripts/backoffice-setup.mjs --designation records, --role is unchanged, bad usage refused', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const script = fileURLToPath(new URL('../../../scripts/backoffice-setup.mjs', import.meta.url));
    const run = (args) =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [script, ...args],
          { env: { ...process.env, CLOUD_DATABASE_URL: c.cloud.config.databaseUrl } },
          (error, stdout, stderr) =>
            resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
        );
      });
    const designated = await run([
      '--actor',
      p.shift.actor_id,
      '--branch',
      c.branch,
      '--designation',
      'shift_manager',
      '--reason',
      'Начальник смены с 16.11',
    ]);
    assert.equal(designated.code, 0, designated.stderr);
    const event = JSON.parse(designated.stdout);
    assert.deepEqual(
      { ...event, note: undefined },
      {
        event: 'backoffice_designation_recorded',
        actor_id: p.shift.actor_id,
        branch_id: c.branch,
        grant: 'analyst',
        previous_role: null,
        role: 'shift_manager',
        note: undefined,
      },
    );
    assert.doesNotMatch(designated.stdout, /token|password/i);
    const withdrawn = await run([
      '--actor',
      p.shift.actor_id,
      '--branch',
      c.branch,
      '--designation',
      'none',
      '--reason',
      'Снять назначение',
    ]);
    assert.equal(JSON.parse(withdrawn.stdout).role, null);
    const rows = (
      await c.cloud.pool.query(
        'SELECT role,reason,source FROM bo_role_designations WHERE actor_id=$1 ORDER BY id',
        [p.shift.actor_id],
      )
    ).rows;
    assert.deepEqual(rows, [
      { role: 'shift_manager', reason: 'Начальник смены с 16.11', source: 'trusted_local_setup' },
      { role: null, reason: 'Снять назначение', source: 'trusted_local_setup' },
    ]);
    // The grant form of today: same arguments, same output.
    const granted = await run([
      '--actor',
      p.accountant.actor_id,
      '--branch',
      c.branch,
      '--role',
      'manager',
    ]);
    assert.equal(granted.code, 0, granted.stderr);
    assert.equal(
      granted.stdout,
      'Backoffice branch grant recorded. Existing private manager credential remains unchanged.\n',
    );
    for (const args of [
      [
        '--actor',
        p.shift.actor_id,
        '--branch',
        c.branch,
        '--designation',
        'owner',
        '--reason',
        'Нет',
      ],
      ['--actor', p.shift.actor_id, '--branch', c.branch, '--designation', 'accountant'],
      [
        '--actor',
        p.shift.actor_id,
        '--branch',
        c.branch,
        '--role',
        'shift_manager',
        '--reason',
        'x',
      ],
    ]) {
      const refused = await run(args);
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /Usage: --actor UUID --branch UUID --role manager\|analyst/);
    }
    // A manager cannot be designated.
    const manager = await run([
      '--actor',
      p.manager.actor_id,
      '--branch',
      c.branch,
      '--designation',
      'accountant',
      '--reason',
      'Управляющий',
    ]);
    assert.notEqual(manager.code, 0);
    assert.match(manager.stderr, /CONFLICT/);
  }));
