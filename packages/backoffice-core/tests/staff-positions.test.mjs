import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import {
  Backoffice,
  BackofficeError,
  Employee,
  EmployeeP1,
  STAFF_POSITIONS_V1,
  StaffPositionsSchema,
  designateBackoffice,
  edgeStaffId,
  grantBackoffice,
  keepEmployeePositions,
  rosterDigest,
  rosterEntry,
  stripKeptPositions,
} from '../dist/index.js';

/**
 * Staff positions of lane bo-ui (positions.ts; design-bo-ui.md 5.7): the eleven positions and the
 * branch's own list, the position fields of an employee card (old cards stay valid, a save without
 * them keeps them), the roster of the cashier edge, roles and the flag-off behaviour. Synthetic.
 */
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;
const request = (command, reason = 'Синтетическая карточка сотрудника') => ({
  request_id: randomUUID(),
  reason,
  command,
});
const ON = { staffPositionsEnabled: true, rolesEnabled: true };
const card = (extra = {}) => ({
  name: 'Синтетическая кассир',
  role: 'cashier',
  active: true,
  note: '',
  ...extra,
});
const save = (id, revision, payload) => ({
  type: 'save',
  kind: 'employee',
  id,
  expected_revision: revision,
  payload,
});

test('the eleven positions: station numbers, KDS functions, cashier access', () => {
  assert.equal(STAFF_POSITIONS_V1.length, 11);
  assert.equal(StaffPositionsSchema.safeParse(STAFF_POSITIONS_V1).success, true);
  assert.deepEqual(
    STAFF_POSITIONS_V1.map((p) => [p.code, p.station, p.pos_access]),
    [
      ['cashier', 1, 'cashier'],
      ['issue', 2, 'none'],
      ['delivery_handover', 3, 'none'],
      ['assembler', 4, 'none'],
      ['toasts_fries', 5, 'none'],
      ['breading', 6, 'none'],
      ['fryer', 7, 'none'],
      ['prep', 8, 'none'],
      ['runner', 9, 'none'],
      ['shift_manager', null, 'shift_manager'],
      ['manager', null, 'shift_manager'],
    ],
  );
  const first = STAFF_POSITIONS_V1[0];
  for (const bad of [
    [first, first],
    [first, { ...first, code: 'other' }],
    [{ ...first, active: false }],
    [{ ...first, station: 10 }],
    [{ ...first, kds: ['grill'] }],
    [],
  ])
    assert.equal(StaffPositionsSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('card payload: old cards valid, P1 fields only in EmployeeP1, kept on a save without them', () => {
  const old = card();
  assert.equal(Employee.safeParse(old).success, true);
  assert.equal(EmployeeP1.safeParse(old).success, true);
  const p1 = card({
    position_code: 'cashier',
    extra_position_codes: ['issue', 'runner'],
    pos_access: 'cashier',
  });
  assert.equal(EmployeeP1.safeParse(p1).success, true);
  assert.equal(Employee.safeParse(p1).success, false, 'the cloud lane schema refuses them');
  for (const bad of [
    { ...p1, extra_position_codes: ['issue', 'issue'] },
    { ...p1, extra_position_codes: ['cashier'] },
    { ...p1, extra_position_codes: ['issue', 'runner', 'prep', 'fryer'] },
    { ...p1, pos_access: 'kitchen' },
    { ...p1, position_code: 'Кассир' },
  ])
    assert.equal(EmployeeP1.safeParse(bad).success, false, JSON.stringify(bad));
  assert.deepEqual(keepEmployeePositions(card({ note: 'new' }), p1), { ...p1, note: 'new' });
  assert.deepEqual(keepEmployeePositions(old, null), old);
  assert.deepEqual(keepEmployeePositions({ ...p1, pos_access: 'none' }, p1).pos_access, 'none');
  // With the flag off, the unchanged fields an editor sends back are not refused.
  assert.deepEqual(stripKeptPositions({ ...p1, note: 'x' }, p1), card({ note: 'x' }));
  assert.deepEqual(stripKeptPositions({ ...p1, pos_access: 'none' }, p1), {
    ...card(),
    pos_access: 'none',
  });
  assert.deepEqual(stripKeptPositions(p1, null), p1);
});

test('roster entry and digest: edge role and id only for a working card with access', () => {
  const id = randomUUID();
  assert.deepEqual(
    rosterEntry(id.toUpperCase(), card({ position_code: 'cashier', pos_access: 'cashier' })),
    {
      employee_id: id,
      name: 'Синтетическая кассир',
      position_code: 'cashier',
      pos_access: 'cashier',
      role: 'cashier',
      edge_staff_id: edgeStaffId(id, 'cashier'),
      active: true,
    },
  );
  for (const payload of [
    card({ pos_access: 'cashier', active: false }),
    card({ pos_access: 'cashier', deleted: true }),
    card({ pos_access: 'none' }),
    card(),
  ]) {
    const e = rosterEntry(id, payload);
    assert.equal(e.role, null);
    assert.equal(e.edge_staff_id, null);
  }
  const branch = randomUUID();
  const staff = [rosterEntry(id, card({ pos_access: 'shift_manager' }))];
  assert.match(rosterDigest(branch, staff), /^[0-9a-f]{64}$/);
  assert.equal(rosterDigest(branch, staff), rosterDigest(branch, [{ ...staff[0] }]));
  assert.notEqual(rosterDigest(branch, staff), rosterDigest(randomUUID(), staff));
  assert.notEqual(
    rosterDigest(branch, staff),
    rosterDigest(branch, [{ ...staff[0], name: 'Другое имя' }]),
  );
});

async function people(c) {
  const login = async (name, role, designation) => {
    const p = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name,
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, p.actor_id, c.branch, role);
    if (designation)
      await designateBackoffice(c.cloud.pool, p.actor_id, c.branch, designation, 'Синтетика');
    return p;
  };
  return {
    manager: await login('Синтетический управляющий', 'manager'),
    shift: await login('Синтетический начальник смены', 'analyst', 'shift_manager'),
    analyst: await login('Синтетический аналитик', 'analyst'),
  };
}

test('flag off: the cloud lane card, no roster view, no positions key', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const off = new Backoffice(c.cloud.pool, true, { rolesEnabled: true });
    const id = randomUUID();
    await assert.rejects(
      off.command(manager.token, c.branch, request(save(id, 0, card({ pos_access: 'cashier' })))),
      is('INVALID_REQUEST', undefined),
    );
    const saved = await off.command(manager.token, c.branch, request(save(id, 0, card())));
    assert.deepEqual(saved.payload, card());
    await assert.rejects(
      off.ops(manager.token, c.branch, 'staff-roster', {}),
      is('NOT_FOUND', undefined),
    );
    const state = await off.read(manager.token, c.branch);
    assert.equal('staff_positions' in state, false);
    assert.equal(state.permissions.includes('staff.positions'), false);
    await assert.rejects(
      off.command(
        manager.token,
        c.branch,
        request({
          type: 'staff_positions_save',
          positions: STAFF_POSITIONS_V1,
          expected_version: 1,
        }),
      ),
      is('INVALID_REQUEST', undefined),
    );
  }));

test('flag on: positions on the card, the branch list, the roster, and a rollback keeps them', () =>
  withSyncDatabases(async (c) => {
    const { manager, shift, analyst } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const state = await bo.read(manager.token, c.branch);
    assert.equal(state.capabilities.staff_positions, true);
    assert.deepEqual(state.permissions.slice(-1), ['staff.positions']);
    assert.equal(state.staff_positions.version, 1);
    assert.equal(state.staff_positions.editable, true);
    assert.equal(state.staff_positions.positions.length, 11);

    const cashier = randomUUID();
    const first = card({
      position_code: 'cashier',
      extra_position_codes: ['issue'],
      pos_access: 'cashier',
    });
    const saved = await bo.command(manager.token, c.branch, request(save(cashier, 0, first)));
    assert.deepEqual(saved.payload, first);
    await assert.rejects(
      bo.command(
        manager.token,
        c.branch,
        request(save(randomUUID(), 0, card({ position_code: 'barista' }))),
      ),
      is('INVALID_REQUEST', 'POSITION_UNKNOWN'),
    );
    // A save without the fields (the old editor) keeps them.
    const kept = await bo.command(
      manager.token,
      c.branch,
      request(save(cashier, 1, card({ note: 'Работает с 19.11' }))),
    );
    assert.deepEqual(kept.payload, { ...first, note: 'Работает с 19.11' });
    // Only the manager sets positions.
    await assert.rejects(
      bo.command(analyst.token, c.branch, request(save(randomUUID(), 0, first))),
      is('FORBIDDEN', undefined),
    );

    // The branch list: a new position, the runner made inactive; codes never removed.
    const runnerCard = randomUUID();
    await bo.command(
      manager.token,
      c.branch,
      request(save(runnerCard, 0, card({ name: 'Синтетический раннер', position_code: 'runner' }))),
    );
    const list = STAFF_POSITIONS_V1.map((p) => (p.code === 'runner' ? { ...p, active: false } : p));
    const washer = {
      code: 'custom_1',
      label: 'Мойщик',
      station: null,
      kds: [],
      pos_access: 'none',
      active: true,
    };
    await assert.rejects(
      bo.command(
        shift.token,
        c.branch,
        request({
          type: 'staff_positions_save',
          positions: [...list, washer],
          expected_version: 1,
        }),
      ),
      is('FORBIDDEN', 'ROLE_FORBIDDEN'),
    );
    const v2 = await bo.command(
      manager.token,
      c.branch,
      request({ type: 'staff_positions_save', positions: [...list, washer], expected_version: 1 }),
    );
    assert.equal(v2.version, 2);
    await assert.rejects(
      bo.command(
        manager.token,
        c.branch,
        request({ type: 'staff_positions_save', positions: list, expected_version: 1 }),
      ),
      is('CONFLICT', undefined),
    );
    await assert.rejects(
      bo.command(
        manager.token,
        c.branch,
        request({ type: 'staff_positions_save', positions: list, expected_version: 2 }),
      ),
      is('INVALID_REQUEST', 'POSITION_IN_USE'),
    );
    assert.equal((await bo.read(manager.token, c.branch)).staff_positions.version, 2);
    // The runner keeps the inactive position; a new card cannot take it.
    await bo.command(
      manager.token,
      c.branch,
      request(
        save(
          runnerCard,
          1,
          card({ name: 'Синтетический раннер', position_code: 'runner', note: 'x' }),
        ),
      ),
    );
    await assert.rejects(
      bo.command(
        manager.token,
        c.branch,
        request(save(randomUUID(), 0, card({ position_code: 'runner' }))),
      ),
      is('INVALID_REQUEST', 'POSITION_UNKNOWN'),
    );
    await bo.command(
      manager.token,
      c.branch,
      request(
        save(randomUUID(), 0, card({ name: 'Синтетический мойщик', position_code: 'custom_1' })),
      ),
    );

    // The roster: every card, the edge role and id, a removed card without access.
    const manager2 = randomUUID();
    await bo.command(
      manager.token,
      c.branch,
      request(
        save(
          manager2,
          0,
          card({
            name: 'Синтетический менеджер',
            position_code: 'shift_manager',
            pos_access: 'shift_manager',
          }),
        ),
      ),
    );
    const gone = randomUUID();
    await bo.command(
      manager.token,
      c.branch,
      request(
        save(
          gone,
          0,
          card({ name: 'Синтетический уволенный', pos_access: 'cashier', active: false }),
        ),
      ),
    );
    const roster = await bo.ops(manager.token, c.branch, 'staff-roster', {});
    assert.equal(roster.schema_version, 1);
    assert.equal(roster.branch_id, c.branch);
    assert.equal(roster.positions_version, 2);
    assert.equal(roster.staff.length, 5);
    assert.equal(roster.sha256, rosterDigest(c.branch, roster.staff));
    const by = Object.fromEntries(roster.staff.map((s) => [s.employee_id, s]));
    assert.deepEqual(
      [by[cashier].role, by[cashier].edge_staff_id],
      ['cashier', edgeStaffId(cashier, 'cashier')],
    );
    assert.deepEqual(
      [by[manager2].role, by[manager2].edge_staff_id],
      ['shift_manager', edgeStaffId(manager2, 'shift_manager')],
    );
    assert.deepEqual([by[gone].role, by[gone].active], [null, false]);
    assert.equal(by[runnerCard].role, null);
    assert.deepEqual(
      roster.staff.map((s) => s.employee_id),
      [...roster.staff.map((s) => s.employee_id)].sort(),
    );
    for (const person of [shift, analyst])
      await assert.rejects(
        bo.ops(person.token, c.branch, 'staff-roster', {}),
        (e) => e instanceof BackofficeError && e.code === 'FORBIDDEN',
      );
    await assert.rejects(
      bo.ops(manager.token, c.branch, 'staff-roster', { format: 'csv' }),
      is('INVALID_REQUEST', undefined),
    );

    // Rollback: the flag off, the card keeps its fields; sending them back unchanged is fine,
    // changing them is refused as by the cloud lane.
    const off = new Backoffice(c.cloud.pool, true, { rolesEnabled: true });
    const afterOff = await off.command(
      manager.token,
      c.branch,
      request(save(cashier, 2, { ...first, note: 'Отпуск до 25.11' })),
    );
    assert.deepEqual(afterOff.payload, { ...first, note: 'Отпуск до 25.11' });
    const workforceEditor = await off.command(
      manager.token,
      c.branch,
      request(save(cashier, 3, card({ note: 'Вернулась' }))),
    );
    assert.deepEqual(workforceEditor.payload, { ...first, note: 'Вернулась' });
    await assert.rejects(
      off.command(
        manager.token,
        c.branch,
        request(save(cashier, 4, { ...first, pos_access: 'none' })),
      ),
      is('INVALID_REQUEST', undefined),
    );
  }));
