import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { designateBackoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import {
  DAY,
  NAMES,
  STAFF,
  TERMINAL,
  seedDay,
} from '../../packages/backoffice-core/tests/pos-day-fixture.mjs';

/**
 * Lane bo-ui «Касса» over HTTP: the real API controllers behind the operator proxy, the flag and
 * the roles of contract 5.10 (manager, shift manager, accountant, analyst read; nobody else).
 * Synthetic day of packages/backoffice-core/tests/pos-day-fixture.mjs.
 */
const view = (c, query) =>
  `${c.url}/v1/admin/backoffice/branches/${c.branch}/ops/pos-day?${new URLSearchParams(query)}`;
const headers = (token) => ({ Authorization: 'Bearer ' + token });

async function person(c, name, role, designation) {
  const m = await provisionCatalogManager(c.cloud.pool, {
    organization_id: c.org,
    name,
    branch_ids: [c.branch],
  });
  if (role) await grantBackoffice(c.cloud.pool, m.actor_id, c.branch, role);
  if (designation)
    await designateBackoffice(c.cloud.pool, m.actor_id, c.branch, designation, 'Т7: синтетика');
  return m;
}

test('flag off: ops/pos-day is the 404 of an unknown view, GET branches/:id has no pos_day', () =>
  withCatalog(async (c) => {
    await seedDay(c);
    const off = await fetch(view(c, { date: DAY }), { headers: headers(c.manager.token) });
    assert.equal(off.status, 404);
    const body = await off.json();
    assert.equal(body.code, 'NOT_FOUND');
    assert.equal(body.error, undefined);
    const state = await (
      await fetch(`${c.url}/v1/admin/backoffice/branches/${c.branch}?period=day`, {
        headers: headers(c.manager.token),
      })
    ).json();
    assert.equal('pos_day' in state.capabilities, false);
    assert.equal('pos_terminals' in state, false);
    assert.equal('pos_staff' in state, false);
  }));

test('flag on: every reading role gets the day through the proxy, others are refused', () =>
  withCatalog(
    async (c) => {
      await seedDay(c);
      const shift = await person(c, 'Синтетический начальник смены', 'analyst', 'shift_manager');
      const accountant = await person(c, 'Синтетический бухгалтер', 'analyst', 'accountant');
      const analyst = await person(c, 'Синтетический аналитик', 'analyst');
      const outsider = await person(c, 'Синтетический посторонний', null);
      for (const [who, role] of [
        [c.manager, 'manager'],
        [shift, 'shift_manager'],
        [accountant, 'accountant'],
        [analyst, 'analyst'],
      ]) {
        const state = await (
          await fetch(`${c.url}/v1/admin/backoffice/branches/${c.branch}?period=day`, {
            headers: headers(who.token),
          })
        ).json();
        assert.equal(state.effective_role, role);
        assert.equal(state.capabilities.pos_day, true);
        assert.ok(state.permissions.includes('reports.read'));
        const response = await fetch(view(c, { date: DAY }), { headers: headers(who.token) });
        assert.equal(response.status, 200, role);
        assert.match(response.headers.get('content-type'), /^application\/json/);
        const day = await response.json();
        assert.equal(day.view, 'pos-day');
        assert.equal(day.totals.revenue_minor, '850000', role);
        assert.equal(day.sales.length, 12);
        assert.equal(day.staff[STAFF.cashier].name, NAMES.cashier);
        assert.deepEqual(
          day.terminals.map((t) => t.label),
          ['Касса 1', 'Касса 2', 'Касса 3'],
        );
      }
      const desk = await (
        await fetch(view(c, { date: DAY, terminal_id: TERMINAL.two }), {
          headers: headers(accountant.token),
        })
      ).json();
      assert.deepEqual(
        desk.sales.map((s) => s.display_number),
        [3, 2, 1],
      );
      const denied = await fetch(view(c, { date: DAY }), { headers: headers(outsider.token) });
      assert.equal(denied.status, 403);
      assert.equal((await fetch(view(c, { date: DAY }))).status, 401);
      // The proxy refuses a query it does not know before the API sees it; the API itself
      // answers 400 for a date that is not a calendar day.
      const blocked = await fetch(view(c, { date: DAY, format: 'csv' }), {
        headers: headers(c.manager.token),
      });
      assert.equal(blocked.status, 404);
      assert.equal(
        (
          await fetch(
            `${c.upstream}/v1/admin/backoffice/branches/${c.branch}/ops/pos-day?date=2026-11-31`,
            { headers: headers(c.manager.token) },
          )
        ).status,
        400,
      );
      // Another branch of the organization: the manager here has no grant there.
      const other = randomUUID();
      await c.cloud.pool.query(
        "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'SYN2','Synthetic 2')",
        [other, c.org, c.legal],
      );
      const foreign = await fetch(
        `${c.url}/v1/admin/backoffice/branches/${other}/ops/pos-day?date=${DAY}`,
        { headers: headers(c.manager.token) },
      );
      assert.equal(foreign.status, 403);
    },
    { roles: true, posDay: true },
  ));
