import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import { Finance } from '../../packages/backoffice-core/dist/finance.js';

test('financial acceptance: cumulative boundary protects both dates, corrections and reports; reopening preserves controls', () =>
  withSyncDatabases(async ({ cloud, org, branch }) => {
    const manager = await provisionCatalogManager(cloud.pool, {
      organization_id: org,
      name: 'Synthetic period acceptance',
      branch_ids: [branch],
    });
    await grantBackoffice(cloud.pool, manager.actor_id, branch, 'manager');
    const f = new Finance(cloud.pool, true);
    const request = (command, reason = 'Synthetic period acceptance') => ({
      request_id: randomUUID(),
      reason,
      command,
    });
    const run = (command, reason) => f.command(manager.token, branch, request(command, reason));
    const period = (month, closed, expected_revision) => ({
      type: 'period',
      month,
      closed,
      expected_revision,
    });
    const cash = randomUUID();
    const account = (opening_date) => ({
      type: 'account',
      id: randomUUID(),
      name: randomUUID(),
      kind: 'cash',
      opening_date,
      opening_minor: '500000',
    });
    await run({ ...account('2025-01-01'), id: cash });
    const entry = (patch = {}) => ({
      id: randomUUID(),
      kind: 'expense',
      amount_minor: '10000',
      cash_date: '2026-10-10',
      recognition_date: '2026-10-10',
      account_id: cash,
      to_account_id: null,
      category_id: 'rent',
      center: 'restaurant',
      counterparty: 'Synthetic',
      reference: randomUUID(),
      note: '',
      ...patch,
    });
    const historical = [];
    for (const date of ['2025-12-31', '2026-08-31', '2026-09-01', '2026-09-30']) {
      for (const dates of [
        { cash_date: date },
        { recognition_date: date },
        { cash_date: date, recognition_date: date },
      ]) {
        const e = entry(dates);
        historical.push(e);
        await run({ type: 'entry', entry: e });
      }
    }
    const october = entry();
    await run({ type: 'entry', entry: october });
    await run(period('2026-09-01', true, 0));
    const snapshot = async () => {
      const d = await f.read(manager.token, branch, {
        start_date: '2026-09-01',
        end_date: '2026-09-30',
      });
      // as_of is clock time; all financial results and journal evidence must remain identical.
      const stable = { ...d };
      delete stable.as_of;
      return stable;
    };
    const before = await snapshot();
    const counts = async () =>
      (
        await cloud.pool.query(`SELECT
      (SELECT count(*) FROM bo_finance_entries)::int AS entries,
      (SELECT count(*) FROM bo_finance_voids)::int AS voids,
      (SELECT count(*) FROM bo_finance_accounts)::int AS accounts,
      (SELECT count(*) FROM bo_audit)::int AS audit,
      (SELECT count(*) FROM bo_finance_commands)::int AS commands`)
      ).rows[0];
    const countBefore = await counts();
    for (const old of historical) {
      await assert.rejects(run({ type: 'entry', entry: { ...old, id: randomUUID() } }), /CONFLICT/);
      await assert.rejects(run({ type: 'void', id: old.id }), /CONFLICT/);
      // Neither moving an old transaction forward nor an October transaction backward bypasses close.
      await assert.rejects(run({ type: 'replace', id: old.id, entry: entry() }), /CONFLICT/);
      await assert.rejects(
        run({ type: 'replace', id: october.id, entry: { ...old, id: randomUUID() } }),
        /CONFLICT/,
      );
    }
    for (const date of ['2025-12-31', '2026-08-31', '2026-09-01', '2026-09-30']) {
      await assert.rejects(run(account(date)), /CONFLICT/);
      for (const kind of ['accrual_income', 'accrual_expense']) {
        await assert.rejects(
          run({
            type: 'entry',
            entry: entry({
              kind,
              cash_date: null,
              account_id: null,
              recognition_date: date,
              category_id: kind === 'accrual_income' ? 'sales' : 'rent',
            }),
          }),
          /CONFLICT/,
        );
      }
      await assert.rejects(
        run({ type: 'entry', entry: entry({ cash_date: date, recognition_date: null }) }),
        /CONFLICT/,
      );
    }
    assert.deepEqual(
      await counts(),
      countBefore,
      'rejected commands have no partial financial/audit effects',
    );
    assert.deepEqual(
      await snapshot(),
      before,
      'September accounts, reports, timeline and journal stay unchanged',
    );
    await run(account('2026-10-01'));
    const next = entry();
    await run({ type: 'entry', entry: next });
    const replacement = entry({ amount_minor: '25000' });
    await run({ type: 'replace', id: next.id, entry: replacement });
    await run({ type: 'void', id: replacement.id });
    await run(period('2026-10-01', true, 0));
    await assert.rejects(run({ type: 'entry', entry: entry() }), /CONFLICT/);
    await assert.rejects(run(period('2026-09-01', false, 1)), /CONFLICT/);
    await assert.rejects(run(period('2026-08-01', false, 0)), /CONFLICT/);
    await assert.rejects(run(period('2026-10-01', false, 0)), /CONFLICT/);
    await assert.rejects(run(period('2026-10-01', false, 1), '  '), /INVALID_REQUEST/);
    await grantBackoffice(cloud.pool, manager.actor_id, branch, 'analyst');
    await assert.rejects(run(period('2026-10-01', false, 1)), /FORBIDDEN/);
    await grantBackoffice(cloud.pool, manager.actor_id, branch, 'manager');
    const reopen = request(period('2026-10-01', false, 1), 'Synthetic October correction');
    const result = await f.command(manager.token, branch, reopen);
    assert.equal(result.revision, 2);
    assert.deepEqual(
      await f.command(manager.token, branch, reopen),
      result,
      'reopen retry is idempotent',
    );
    await assert.rejects(run({ type: 'void', id: historical[0].id }), /CONFLICT/);
    await run(period('2026-09-01', false, 1), 'Synthetic September correction');
    const audit = (
      await cloud.pool.query(
        'SELECT actor_id,reason,before_value,after_value FROM bo_audit WHERE request_id=$1',
        [reopen.request_id],
      )
    ).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_id, manager.actor_id);
    assert.equal(audit[0].reason, 'Synthetic October correction');
    assert.deepEqual(audit[0].before_value, { closed: true, revision: 1 });
    assert.deepEqual(audit[0].after_value, reopen.command);
    await run({ type: 'void', id: historical[0].id });
    await run({
      type: 'replace',
      id: historical[1].id,
      entry: entry({ cash_date: '2026-08-01', recognition_date: '2026-08-01' }),
    });
    await run({
      type: 'entry',
      entry: entry({ cash_date: '2026-09-01', recognition_date: '2026-08-01' }),
    });
    await run(account('2026-08-01'));
    assert.notDeepEqual(
      await snapshot(),
      before,
      'authorized corrections take effect after relevant periods reopen',
    );
  }));
