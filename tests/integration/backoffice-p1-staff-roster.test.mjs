import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loginStaffPin, provisionStaff, revokeStaff, setStaffPin } from '@pickchick/local-orders';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import {
  Backoffice,
  edgeStaffId,
  grantBackoffice,
  rosterDigest as coreDigest,
} from '../../packages/backoffice-core/dist/index.js';
import { createStaffCredentialStore } from '../../scripts/staff-credential.mjs';
import {
  applyRoster,
  planHash,
  planRoster,
  readLocalStaff,
  readRoster,
  rosterDigest,
} from '../../scripts/staff-roster-apply.mjs';
import { PIN_ATTEMPTS, runPinBatch } from '../../scripts/staff-pin-batch.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';

/**
 * Lane bo-ui step 6 end to end with synthetic staff (design-bo-ui.md 5.7): the back-office roster
 * (GET ops/staff-roster) -> scripts/staff-roster-apply.mjs on the branch edge (plan, hash, apply
 * through provisionStaff/revokeStaff, a role never changed in place, a revoked account blocked)
 * -> scripts/staff-pin-batch.mjs (one PIN per person by setStaffPin, never printed).
 */
const request = (command) => ({
  request_id: randomUUID(),
  reason: 'Синтетический состав кассы',
  command,
});
const card = (name, access, extra = {}) => ({
  name,
  role: 'cashier',
  active: true,
  note: '',
  pos_access: access,
  ...extra,
});
async function cloudSide(c) {
  const manager = await provisionCatalogManager(c.cloud.pool, {
    organization_id: c.org,
    name: 'Синтетический управляющий',
    branch_ids: [c.branch],
  });
  await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
  const bo = new Backoffice(c.cloud.pool, true, { staffPositionsEnabled: true });
  const revisions = new Map();
  const save = async (id, payload) => {
    const r = await bo.command(
      manager.token,
      c.branch,
      request({
        type: 'save',
        kind: 'employee',
        id,
        expected_revision: revisions.get(id) ?? 0,
        payload,
      }),
    );
    revisions.set(id, r.revision);
  };
  const roster = () => bo.ops(manager.token, c.branch, 'staff-roster', {});
  return { save, roster };
}

test('roster -> staff-roster-apply -> staff-pin-batch: plan, hash, roles never changed in place, PINs never printed', () =>
  withSyncDatabases(async (c) => {
    const directory = await mkdtemp(join(tmpdir(), 'pickchick-staff-roster-'));
    const store = createStaffCredentialStore(pathToFileURL(directory + '/'));
    const edge = c.edge.pool;
    const printed = [];
    const log = (event) => printed.push(JSON.stringify(event));
    try {
      const cloud = await cloudSide(c);
      const A = randomUUID(),
        B = randomUUID(),
        C = randomUUID(),
        D = randomUUID();
      await cloud.save(A, card('Синтетическая Алия', 'cashier', { position_code: 'cashier' }));
      await cloud.save(
        B,
        card('Синтетический Бек', 'shift_manager', { position_code: 'shift_manager' }),
      );
      await cloud.save(C, card('Синтетический жарщик', 'none', { position_code: 'fryer' }));
      await cloud.save(D, card('Синтетический уволенный', 'cashier', { active: false }));
      let roster = await cloud.roster();
      // The script reads exactly what the back office wrote: same digest bytes.
      assert.equal(
        rosterDigest(roster.branch_id, roster.staff),
        coreDigest(c.branch, roster.staff),
      );
      assert.equal(readRoster(roster, c.branch), roster);
      const tampered = JSON.parse(JSON.stringify(roster));
      tampered.staff[0].name = 'Другое имя';
      assert.throws(() => readRoster(tampered, c.branch), /ROSTER_DIGEST/);
      assert.throws(() => readRoster(roster, randomUUID()), /ROSTER_OTHER_BRANCH/);
      const forged = JSON.parse(JSON.stringify(roster));
      forged.staff[0].edge_staff_id = randomUUID();
      assert.throws(() => readRoster(forged, c.branch), /ROSTER_FORMAT/);
      assert.throws(() => readRoster({ ...roster, extra: 1 }, c.branch), /ROSTER_FORMAT/);

      // The edge before: the shared kitchen login (not managed by the roster) on the cash desk
      // terminal, and an account of the removed card that must be revoked.
      const terminal = randomUUID();
      const kitchen = randomUUID();
      await provisionStaff(edge, c.branch, {
        staff_id: kitchen,
        terminal_id: terminal,
        name: 'Кухня',
        role: 'kitchen',
      });
      await provisionStaff(edge, c.branch, {
        staff_id: edgeStaffId(D, 'cashier'),
        terminal_id: terminal,
        name: 'Синтетический уволенный',
        role: 'cashier',
      });
      const plan = planRoster(roster, await readLocalStaff(edge, c.branch), terminal);
      assert.deepEqual(
        plan.provision.map((p) => [p.employee_id, p.role, p.staff_id]).sort(),
        [
          [A, 'cashier', edgeStaffId(A, 'cashier')],
          [B, 'shift_manager', edgeStaffId(B, 'shift_manager')],
        ].sort(),
      );
      assert.deepEqual(
        plan.revoke.map((r) => [r.employee_id, r.role]),
        [[D, 'cashier']],
      );
      assert.deepEqual(plan.unmanaged, [{ staff_id: kitchen, role: 'kitchen', active: true }]);
      assert.deepEqual(plan.blocked, []);
      assert.equal(plan.terminal_id, terminal);
      const hash = planHash(plan);
      assert.equal(
        planHash(planRoster(roster, await readLocalStaff(edge, c.branch), terminal)),
        hash,
      );
      const deps = {
        pool: edge,
        branchId: c.branch,
        roster,
        store,
        log,
        provisionStaff,
        revokeStaff,
      };
      await assert.rejects(
        applyRoster({ ...deps, terminal, expected: '0'.repeat(64) }),
        /PLAN_CHANGED/,
      );
      const noTerminal = planHash(planRoster(roster, await readLocalStaff(edge, c.branch)));
      await assert.rejects(applyRoster({ ...deps, expected: noTerminal }), /TERMINAL_REQUIRED/);
      const stranger = randomUUID();
      await assert.rejects(
        applyRoster({
          ...deps,
          terminal: stranger,
          expected: planHash(planRoster(roster, await readLocalStaff(edge, c.branch), stranger)),
        }),
        /TERMINAL_UNKNOWN/,
      );
      assert.equal(printed.length, 0, 'nothing written before a valid plan');
      assert.deepEqual(await applyRoster({ ...deps, terminal, expected: hash }), {
        revoked: 1,
        provisioned: 2,
        blocked: 0,
      });
      const accounts = Object.fromEntries(
        (await readLocalStaff(edge, c.branch)).map((s) => [s.id, s]),
      );
      assert.deepEqual(
        [accounts[edgeStaffId(A, 'cashier')].role, accounts[edgeStaffId(A, 'cashier')].active],
        ['cashier', true],
      );
      assert.equal(accounts[edgeStaffId(B, 'shift_manager')].role, 'shift_manager');
      assert.equal(accounts[edgeStaffId(D, 'cashier')].active, false);
      assert.equal(accounts[kitchen].active, true, 'the kitchen login is never touched');
      // Private bootstrap files for the PIN batch; the log has ids and roles, no token.
      const files = (await readdir(directory)).sort();
      assert.deepEqual(
        files,
        [
          `staff-${edgeStaffId(A, 'cashier')}.json`,
          `staff-${edgeStaffId(B, 'shift_manager')}.json`,
        ].sort(),
      );
      for (const f of files) assert.equal((await stat(join(directory, f))).mode & 0o777, 0o600);
      for (const line of printed) assert.doesNotMatch(line, /token|[0-9a-f]{64}/);
      // A second run has nothing to do.
      const again = planRoster(roster, await readLocalStaff(edge, c.branch), terminal);
      assert.deepEqual([again.provision, again.revoke, again.blocked], [[], [], []]);
      assert.equal(again.keep.length, 2);
      assert.equal(again.terminal_id, null);

      // The shift manager becomes a cashier: the old account is revoked, a new one provisioned.
      await cloud.save(B, card('Синтетический Бек', 'cashier', { position_code: 'cashier' }));
      // The removed card is back with access: its revoked account cannot come back (blocked).
      await cloud.save(D, card('Синтетический уволенный', 'cashier'));
      roster = await cloud.roster();
      const change = planRoster(roster, await readLocalStaff(edge, c.branch), terminal);
      assert.deepEqual(
        change.revoke.map((r) => [r.employee_id, r.role]),
        [[B, 'shift_manager']],
      );
      assert.deepEqual(
        change.provision.map((p) => [p.employee_id, p.role]),
        [[B, 'cashier']],
      );
      assert.deepEqual(
        change.blocked.map((b) => [b.employee_id, b.reason]),
        [[D, 'revoked_earlier']],
      );
      await applyRoster({ ...deps, roster, terminal, expected: planHash(change) });
      const after = Object.fromEntries(
        (await readLocalStaff(edge, c.branch)).map((s) => [s.id, s]),
      );
      assert.equal(after[edgeStaffId(B, 'shift_manager')].active, false);
      assert.deepEqual(
        [after[edgeStaffId(B, 'cashier')].role, after[edgeStaffId(B, 'cashier')].active],
        ['cashier', true],
      );

      // PINs one by one: Алия, then Бек tries Алия's PIN, mistypes once, then succeeds.
      const answers = ['1234', '1234', '1234', '1234', '5678', '5679', '5678', '5678'];
      const prompts = [];
      const said = [];
      const readPin = async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? '';
      };
      const events = await runPinBatch({
        pool: edge,
        branchId: c.branch,
        roster,
        store,
        setStaffPin,
        readPin,
        say: (line) => said.push(line),
        log,
      });
      assert.equal(answers.length, 0);
      assert.equal(PIN_ATTEMPTS, 3);
      assert.deepEqual(
        events.map((e) => [e.event, e.staff_id, e.reason ?? null]),
        [
          ['staff_pin_saved', edgeStaffId(A, 'cashier'), null],
          ['staff_pin_saved', edgeStaffId(B, 'cashier'), null],
          ['staff_pin_skipped', edgeStaffId(D, 'cashier'), 'not_on_edge'],
        ],
      );
      assert.ok(said.some((l) => l.startsWith('Сотрудник: Синтетическая Алия (кассир).')));
      assert.ok(said.includes('Этот PIN не подходит. Введите другой.'));
      assert.ok(said.includes('PIN не совпал или не 4 цифр. Попробуйте ещё раз.'));
      for (const text of [...printed, ...said, ...prompts])
        assert.doesNotMatch(text, /1234|5678|5679/, 'a PIN is never shown or logged');
      const session = await loginStaffPin(edge, c.branch, { pin: '1234', terminal_id: terminal });
      assert.equal(session.staff_id, edgeStaffId(A, 'cashier'));
      // Run again: both have a PIN and are skipped without a prompt.
      prompts.length = 0;
      const second = await runPinBatch({
        pool: edge,
        branchId: c.branch,
        roster,
        store,
        setStaffPin,
        readPin,
        log,
      });
      assert.deepEqual(
        second.map((e) => e.reason),
        ['pin_exists', 'pin_exists', 'not_on_edge'],
      );
      assert.equal(prompts.length, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }));
