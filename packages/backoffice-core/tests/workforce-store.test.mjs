import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager, revokeCatalogManager } from '../../catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../dist/index.js';
import { Workforce } from '../dist/workforce-store.js';

const month = '2026-09-01';
const at = (d, h) => `2026-09-${d}T${h}:00:00+05:00`;
const envelope = (command, reason = 'Проверка синтетического табеля') => ({
  request_id: randomUUID(),
  reason,
  command,
});
const setup = (fn) =>
  withSyncDatabases(async (c) => {
    const manager = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Synthetic workforce manager',
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
    const employee_id = randomUUID(),
      bo = new Backoffice(c.cloud.pool, true);
    await bo.command(
      manager.token,
      c.branch,
      envelope({
        type: 'save',
        kind: 'employee',
        id: employee_id,
        expected_revision: 0,
        payload: { name: 'Synthetic employee', role: 'cook', active: true, note: '' },
      }),
    );
    const workforce = new Workforce(c.cloud.pool, true);
    const send = (command) => workforce.command(manager.token, c.branch, envelope(command));
    const save = (kind, payload, id = randomUUID(), expected_revision = 0) =>
      send({ type: 'save', kind, payload, id, expected_revision });
    const entry = (extra = {}) => ({
      employee_id,
      date: month,
      status: 'approved',
      attendance: 'worked',
      intervals: [{ start: at('01', '09'), end: at('01', '17') }],
      source_event_ids: [],
      note: 'Проверено управляющим',
      ...extra,
    });
    await fn({
      ...c,
      manager,
      employee_id,
      workforce,
      send,
      save,
      entry,
      read: () => workforce.read(manager.token, c.branch, month),
    });
  });

test('durable replay, revisions, audit and scoped authorization', () =>
  setup(async (c) => {
    const { workforce: w, manager: m, branch, employee_id, cloud } = c;
    await assert.rejects(
      new Workforce(cloud.pool).read(m.token, branch, month),
      /SERVICE_UNAVAILABLE/,
    );
    await assert.rejects(w.read('bad', branch, month), /UNAUTHORIZED/);
    await assert.rejects(w.read(m.token, randomUUID(), month), /FORBIDDEN/);
    const command = envelope({
      type: 'save',
      kind: 'rate',
      id: randomUUID(),
      expected_revision: 0,
      payload: { employee_id, effective_date: month, hourly_minor: '100000' },
    });
    const [first, second] = await Promise.all([
      w.command(m.token, branch, command),
      w.command(m.token, branch, command),
    ]);
    assert.deepEqual(first, second);
    assert.equal((await c.read()).records.length, 1);
    assert.equal((await c.read()).audit.length, 1);
    await assert.rejects(
      w.command(m.token, branch, { ...command, reason: 'Другой смысл запроса' }),
      /CONFLICT/,
    );
    await assert.rejects(c.save('rate', command.command.payload, first.id, 1), /CONFLICT/);
    await assert.rejects(
      c.save('rate', { ...command.command.payload, employee_id: randomUUID() }),
      /NOT_FOUND/,
    );
    await grantBackoffice(cloud.pool, m.actor_id, branch, 'analyst');
    assert.equal((await c.read()).role, 'analyst');
    await assert.rejects(c.send(command.command), /FORBIDDEN/);
    await revokeCatalogManager(cloud.pool, m.actor_id);
    await assert.rejects(c.read(), /FORBIDDEN/);
  }));

test('raw event deduplication, transactional rollback and future punch rejection', () =>
  setup(async (c) => {
    const event = {
      employee_id: c.employee_id,
      external_id: 'terminal-event-1',
      direction: 'in',
      occurred_at: at('01', '09'),
    };
    const input = { type: 'import', source: 'manual_csv', events: [event, event] };
    assert.deepEqual(await c.send(input), { inserted: 1, duplicates: 1 });
    assert.deepEqual(await c.send(input), { inserted: 0, duplicates: 2 });
    await assert.rejects(
      c.send({
        ...input,
        events: [
          { ...event, external_id: 'must-rollback' },
          { ...event, direction: 'out' },
        ],
      }),
      /CONFLICT/,
    );
    assert.equal((await c.read()).events.length, 1);
    await assert.rejects(
      c.send({
        ...input,
        events: [{ ...event, external_id: 'future', occurred_at: '2099-01-01T09:00:00+05:00' }],
      }),
      /INVALID_REQUEST/,
    );
    await assert.rejects(
      c.send({ ...input, events: [{ ...event, fingerprint_template: 'not-accepted' }] }),
      /INVALID_REQUEST/,
    );
    assert.equal((await c.read()).unresolved_events, 1);
  }));

test('approval, locked period, explicit reopening and retained edit/deletion history', () =>
  setup(async (c) => {
    await c.save('rate', {
      employee_id: c.employee_id,
      effective_date: month,
      hourly_minor: '100000',
    });
    await c.send({
      type: 'import',
      source: 'manual_csv',
      events: [
        {
          employee_id: c.employee_id,
          external_id: 'in-1',
          direction: 'in',
          occurred_at: at('01', '09'),
        },
        {
          employee_id: c.employee_id,
          external_id: 'out-1',
          direction: 'out',
          occurred_at: at('01', '17'),
        },
      ],
    });
    const source_event_ids = (await c.read()).events.map((e) => e.id);
    await assert.rejects(
      c.send({ type: 'period', month, closed: true, expected_revision: 0 }),
      /NOT_READY/,
    );
    const entry = c.entry({ source_event_ids }),
      saved = await c.save('time', entry);
    await assert.rejects(c.save('time', entry), /CONFLICT/);
    const closed = await c.send({ type: 'period', month, closed: true, expected_revision: 0 });
    assert.equal(closed.revision, 1);
    assert.equal((await c.read()).period.snapshot.calculation.total_minor, '800000');
    await assert.rejects(
      c.save('time', { ...entry, status: 'voided' }, saved.id, saved.revision),
      /CONFLICT/,
    );
    await assert.rejects(
      c.save('rate', {
        employee_id: c.employee_id,
        effective_date: '2026-09-02',
        hourly_minor: '200000',
      }),
      /CONFLICT/,
    );
    // A new future rate cannot rewrite a closed month's effective rate.
    await c.save('rate', {
      employee_id: c.employee_id,
      effective_date: '2026-10-01',
      hourly_minor: '200000',
    });
    await c.send({ type: 'period', month, closed: false, expected_revision: 1 });
    await c.save('time', { ...entry, status: 'voided' }, saved.id, saved.revision);
    const state = await c.read();
    assert.equal(state.calculation.total_minor, '0');
    assert.equal(state.records.find((r) => r.id === saved.id).revision, 2);
    assert.equal(state.events.length, 2);
    assert.equal(state.unresolved_events, 2);
    const audit = state.audit.find(
      (a) => a.action === 'workforce.save' && a.after_value.payload?.status === 'voided',
    );
    assert.equal(audit.before_value.payload.status, 'approved');
    assert.equal(audit.actor_id, c.manager.actor_id);
    await assert.rejects(c.save('time', entry, saved.id, 1), /CONFLICT/);
    await c.save('time', entry); // corrected replacement, same source facts retained
    await c.send({ type: 'period', month, closed: true, expected_revision: 2 });
  }));

test('published schedule without attendance and missing rate block closing; late events remain visible', () =>
  setup(async (c) => {
    await c.save('plan', {
      employee_id: c.employee_id,
      start: at('01', '09'),
      end: at('01', '17'),
      unpaid_break_minutes: 0,
      status: 'published',
      position: 'Повар',
    });
    await assert.rejects(
      c.send({ type: 'period', month, closed: true, expected_revision: 0 }),
      /NOT_READY/,
    );
    await c.save('time', c.entry());
    await assert.rejects(
      c.send({ type: 'period', month, closed: true, expected_revision: 0 }),
      /NOT_READY/,
    );
    await c.save('rate', {
      employee_id: c.employee_id,
      effective_date: month,
      hourly_minor: '100000',
    });
    await c.send({ type: 'period', month, closed: true, expected_revision: 0 });
    await c.send({
      type: 'import',
      source: 'manual_csv',
      events: [
        {
          employee_id: c.employee_id,
          external_id: 'late',
          direction: 'in',
          occurred_at: at('02', '09'),
        },
      ],
    });
    const state = await c.read();
    assert.equal(state.period.closed, true);
    assert.equal(state.period.snapshot.calculation.total_minor, '800000');
    assert.equal(state.unresolved_events, 1);
  }));
