import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import { Finance } from '../../packages/backoffice-core/dist/finance.js';
import { createPool } from '../../packages/database/dist/index.js';
import { backofficeGrants } from '../../infra/staging/backoffice-grants.mjs';

const query = { start_date: '2026-10-01', end_date: '2026-10-31' };
test('durable financial records, exact cash/P&L, branch isolation, retry and period concurrency', () =>
  withSyncDatabases(async (c) => {
    const manager = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Synthetic accountant',
      branch_ids: [c.branch],
    });
    const f = new Finance(c.cloud.pool, true),
      token = manager.token;
    const req = (command, reason = 'Synthetic accounting') => ({
      request_id: randomUUID(),
      reason,
      command,
    });
    await assert.rejects(f.read(token, c.branch, query), /FORBIDDEN/);
    await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
    const cash = randomUUID(),
      bank = randomUUID();
    await f.command(
      token,
      c.branch,
      req({
        type: 'account',
        id: cash,
        name: 'Synthetic cash',
        kind: 'cash',
        opening_date: '2026-09-01',
        opening_minor: '100000',
      }),
    );
    await f.command(
      token,
      c.branch,
      req({
        type: 'account',
        id: bank,
        name: 'Synthetic bank',
        kind: 'bank',
        opening_date: '2026-10-01',
        opening_minor: '0',
      }),
    );
    const entry = (patch = {}) => ({
      id: randomUUID(),
      kind: 'expense',
      amount_minor: '10000',
      cash_date: '2026-10-06',
      recognition_date: '2026-10-06',
      account_id: cash,
      to_account_id: null,
      category_id: 'rent',
      center: 'restaurant',
      counterparty: 'Synthetic',
      reference: randomUUID(),
      note: '',
      ...patch,
    });
    const command = (entry) => req({ type: 'entry', entry });
    const rent = command(entry({ recognition_date: '2026-09-30' }));
    const first = await Promise.all([
      f.command(token, c.branch, rent),
      f.command(token, c.branch, rent),
    ]);
    assert.deepEqual(first[0], first[1]);
    await assert.rejects(
      f.command(token, c.branch, { ...rent, reason: 'Changed payload' }),
      /CONFLICT/,
    );
    await f.command(
      token,
      c.branch,
      command(entry({ kind: 'income', category_id: 'sales', amount_minor: '50000' })),
    );
    await f.command(
      token,
      c.branch,
      command(
        entry({
          kind: 'transfer',
          category_id: null,
          recognition_date: null,
          to_account_id: bank,
          amount_minor: '20000',
        }),
      ),
    );
    await f.command(
      token,
      c.branch,
      command(entry({ category_id: 'ingredients', recognition_date: null, amount_minor: '15000' })),
    );
    await f.command(
      token,
      c.branch,
      command(
        entry({
          kind: 'accrual_expense',
          category_id: 'cogs',
          cash_date: null,
          account_id: null,
          amount_minor: '9000',
          center: 'workshop',
        }),
      ),
    );
    let d = await new Finance(c.cloud.pool, true).read(token, c.branch, query);
    assert.equal(d.total, 5);
    assert.equal(d.accounts.find((a) => a.id === cash).before_minor, '100000');
    assert.equal(d.accounts.find((a) => a.id === cash).after_minor, '105000');
    assert.equal(d.accounts.find((a) => a.id === bank).after_minor, '20000');
    assert.equal(d.summaries.find((s) => s.category_id === 'rent').pnl_minor, '0');
    assert.equal(d.summaries.find((s) => s.category_id === 'rent').cash_minor, '10000');
    assert.equal(d.summaries.find((s) => s.category_id === 'cogs').cash_minor, '0');
    assert.equal(d.summaries.find((s) => s.category_id === 'cogs').pnl_minor, '9000');
    assert.deepEqual(d.timeline, [
      { date: '2026-10-06', basis: 'cash', in_minor: '50000', out_minor: '25000' },
      { date: '2026-10-06', basis: 'pnl', in_minor: '50000', out_minor: '9000' },
    ]);
    assert.equal(
      d.summaries.some((s) => s.category_id === null),
      false,
    );
    const center = await f.read(token, c.branch, { ...query, center: 'workshop' });
    assert.equal(center.summaries.length, 1);
    assert.equal(center.total, 1);
    assert.deepEqual(center.timeline, [
      { date: '2026-10-06', basis: 'pnl', in_minor: '0', out_minor: '9000' },
    ]);
    assert.equal(center.accounts.find((a) => a.id === cash).after_minor, '105000');
    const filtered = await f.read(token, c.branch, {
      ...query,
      category: 'rent',
      basis: 'cash',
      search: 'SYNTHETIC',
    });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.journal[0].id, rent.command.entry.id);
    assert.deepEqual(filtered.summaries, d.summaries);
    assert.deepEqual(filtered.timeline, d.timeline);
    assert.equal(
      (
        await f.read(token, c.branch, {
          ...query,
          category: 'rent',
          basis: 'pnl',
        })
      ).total,
      0,
    );
    assert.equal((await f.read(token, c.branch, { ...query, search: '%' })).total, 0);
    await assert.rejects(
      f.command(token, c.branch, command(entry({ account_id: randomUUID() }))),
      /INVALID_REQUEST/,
    );
    await assert.rejects(
      f.command(token, c.branch, command(entry({ cash_date: '2026-08-31' }))),
      /INVALID_REQUEST/,
    );
    await assert.rejects(f.read(token, randomUUID(), query), /FORBIDDEN/);
    await assert.rejects(f.command(token, randomUUID(), rent), /FORBIDDEN/);
    const close = req({ type: 'period', month: '2026-09-01', closed: true, expected_revision: 0 });
    await f.command(token, c.branch, close);
    await assert.rejects(
      f.command(token, c.branch, req({ type: 'void', id: rent.command.entry.id })),
      /CONFLICT/,
    );
    await assert.rejects(
      f.command(
        token,
        c.branch,
        req({ type: 'period', month: '2026-09-01', closed: false, expected_revision: 0 }),
      ),
      /CONFLICT/,
    );
    await f.command(
      token,
      c.branch,
      req({ type: 'period', month: '2026-09-01', closed: false, expected_revision: 1 }),
    );
    const cancel = req({ type: 'void', id: rent.command.entry.id });
    await f.command(token, c.branch, cancel);
    await f.command(token, c.branch, cancel);
    d = await f.read(token, c.branch, query);
    assert.equal(d.total, 5);
    assert.equal(d.journal.filter((r) => r.void_reason).length, 1);
    assert.equal(d.accounts.find((a) => a.id === cash).after_minor, '115000');
    assert.equal(d.timeline.find((p) => p.basis === 'cash').out_minor, '15000');
    assert.equal(
      d.summaries.some((s) => s.category_id === 'rent'),
      false,
    );
    await assert.rejects(
      c.cloud.pool.query('UPDATE bo_finance_entries SET payload=payload WHERE id=$1', [
        rent.command.entry.id,
      ]),
      /immutable/i,
    );
    // A close racing a new posting has only two valid serialized outcomes.
    const race = await Promise.allSettled([
      f.command(
        token,
        c.branch,
        req({ type: 'period', month: '2026-10-01', closed: true, expected_revision: 0 }),
      ),
      f.command(token, c.branch, command(entry())),
    ]);
    assert.equal(race[0].status, 'fulfilled');
    if (race[1].status === 'rejected') assert.match(race[1].reason.message, /CONFLICT/);
    await assert.rejects(f.command(token, c.branch, command(entry())), /CONFLICT/);
    await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'analyst');
    await f.read(token, c.branch, query);
    await assert.rejects(f.command(token, c.branch, command(entry())), /FORBIDDEN/);
    assert.ok(
      (
        await c.cloud.pool.query(
          "SELECT count(*)::int n FROM bo_audit WHERE action LIKE 'finance.%'",
        )
      ).rows[0].n >= 10,
    );
    assert.equal(
      (await c.cloud.pool.query('SELECT count(*)::int n FROM commerce_captures')).rows[0].n,
      0,
    );
  }));

test('finance runtime has append-only rights, aggregates all pages and rolls back failed audit', () =>
  withSyncDatabases(async (c) => {
    const manager = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Synthetic finance manager',
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
    const role = 'finance_' + randomUUID().replaceAll('-', '');
    const schema = new URL(c.cloud.config.databaseUrl).searchParams.get('options').split('=')[1];
    await c.cloud.pool.query(`CREATE ROLE ${role} NOLOGIN`);
    await c.cloud.pool.query(
      `GRANT USAGE ON SCHEMA ${schema} TO ${role};${backofficeGrants(role, true)}`,
    );
    const url = new URL(c.cloud.config.databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
    const pool = createPool(url.toString());
    try {
      const f = new Finance(pool, true),
        account = randomUUID();
      const req = (command) => ({ request_id: randomUUID(), reason: 'Synthetic runtime', command });
      await f.command(
        manager.token,
        c.branch,
        req({
          type: 'account',
          id: account,
          name: 'Runtime',
          kind: 'cash',
          opening_date: '2026-10-01',
          opening_minor: '0',
        }),
      );
      const entry = () => ({
        id: randomUUID(),
        kind: 'income',
        amount_minor: '101',
        cash_date: '2026-10-06',
        recognition_date: '2026-10-06',
        account_id: null,
        to_account_id: null,
        category_id: 'sales',
        center: 'restaurant',
        counterparty: '',
        reference: 'Synthetic',
        note: '',
      });
      for (let i = 0; i < 105; i++)
        await f.command(manager.token, c.branch, req({ type: 'entry', entry: entry() }));
      const a = await f.read(manager.token, c.branch, query),
        b = await f.read(manager.token, c.branch, { ...query, page: 1 });
      assert.equal(a.journal.length, 100);
      assert.equal(b.journal.length, 5);
      assert.equal(a.total, 105);
      assert.equal(a.summaries[0].pnl_minor, '10605');
      assert.equal(a.accounts[0].after_minor, '0');
      assert.deepEqual(a.unassigned, { entries: 105, in_minor: '10605', out_minor: '0' });
      assert.deepEqual(a.timeline, b.timeline);
      assert.equal(a.timeline.find((p) => p.basis === 'cash').in_minor, '10605');
      const last = b.journal[0].id;
      const cancellation = req({ type: 'void', id: last });
      await f.command(manager.token, c.branch, cancellation);
      await f.command(manager.token, c.branch, cancellation);
      const afterVoid = await f.read(manager.token, c.branch, query);
      assert.equal(afterVoid.unassigned.in_minor, '10504');
      assert.equal(afterVoid.timeline.find((p) => p.basis === 'pnl').in_minor, '10504');
      await assert.rejects(pool.query('DELETE FROM bo_finance_entries'), /permission denied/);
      await assert.rejects(
        pool.query('UPDATE bo_finance_accounts SET name=name'),
        /permission denied/,
      );
      const toEdit = afterVoid.journal.find((r) => !r.void_reason);
      await c.cloud.pool.query(`REVOKE INSERT ON bo_audit FROM ${role}`);
      const replacement = req({
        type: 'replace',
        id: toEdit.id,
        entry: { ...toEdit.payload, id: randomUUID(), amount_minor: '202' },
      });
      await assert.rejects(f.command(manager.token, c.branch, replacement), /permission denied/);
      assert.equal(
        (await c.cloud.pool.query('SELECT 1 FROM bo_finance_voids WHERE entry_id=$1', [toEdit.id]))
          .rowCount,
        0,
      );
      assert.equal(
        (
          await c.cloud.pool.query('SELECT 1 FROM bo_finance_entries WHERE id=$1', [
            replacement.command.entry.id,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await c.cloud.pool.query('SELECT 1 FROM bo_finance_commands WHERE request_id=$1', [
            replacement.request_id,
          ])
        ).rowCount,
        0,
      );
      await c.cloud.pool.query(`GRANT INSERT ON bo_audit TO ${role}`);
      await f.command(manager.token, c.branch, replacement);
      const historyPage = await f.read(manager.token, c.branch, { ...query, search: 'Synthetic' });
      assert.equal(
        historyPage.journal.find((r) => r.id === replacement.command.entry.id).history.length,
        2,
      );
      assert.equal(historyPage.unassigned.in_minor, '10605');
      await c.cloud.pool.query(`REVOKE INSERT ON bo_audit FROM ${role}`);
      const failed = req({ type: 'entry', entry: entry() });
      await assert.rejects(f.command(manager.token, c.branch, failed), /permission denied/);
      assert.equal(
        (
          await c.cloud.pool.query('SELECT 1 FROM bo_finance_entries WHERE id=$1', [
            failed.command.entry.id,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await c.cloud.pool.query('SELECT 1 FROM bo_finance_commands WHERE request_id=$1', [
            failed.request_id,
          ])
        ).rowCount,
        0,
      );
    } finally {
      await pool.end();
      await c.cloud.pool.query(`DROP OWNED BY ${role};DROP ROLE ${role}`);
    }
  }));

test('corrections are atomic revisions with complete cross-period history and stale-write protection', () =>
  withSyncDatabases(async (c) => {
    const manager = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Synthetic editor',
      branch_ids: [c.branch],
    });
    const reviewer = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Synthetic reviewer',
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
    await grantBackoffice(c.cloud.pool, reviewer.actor_id, c.branch, 'manager');
    const f = new Finance(c.cloud.pool, true);
    const req = (command, reason = 'Synthetic correction') => ({
      request_id: randomUUID(),
      reason,
      command,
    });
    const post = (r, token = manager.token) => f.command(token, c.branch, r);
    const original = {
      id: randomUUID(),
      kind: 'expense',
      amount_minor: '50025',
      cash_date: '2026-10-06',
      recognition_date: '2026-09-30',
      account_id: null,
      to_account_id: null,
      category_id: 'rent',
      center: 'restaurant',
      counterparty: 'Synthetic supplier',
      reference: 'Original document',
      note: '',
    };
    await post(req({ type: 'entry', entry: original }, 'Initial input'));
    const revised = {
      ...original,
      id: randomUUID(),
      amount_minor: '60025',
      reference: 'Corrected document',
      cash_date: '2026-11-01',
      recognition_date: '2026-11-01',
      center: 'workshop',
    };
    // Closing either an old or a new date prevents moving money across the boundary.
    for (const month of ['2026-09-01', '2026-11-01']) {
      await post(req({ type: 'period', month, closed: true, expected_revision: 0 }));
      await assert.rejects(
        post(req({ type: 'replace', id: original.id, entry: revised })),
        /CONFLICT/,
      );
      await post(req({ type: 'period', month, closed: false, expected_revision: 1 }));
    }
    await assert.rejects(
      post(req({ type: 'replace', id: randomUUID(), entry: revised })),
      /NOT_FOUND/,
    );
    await assert.rejects(
      post(req({ type: 'replace', id: original.id, entry: original })),
      /CONFLICT/,
    );
    const invalidAccount = { ...revised, account_id: randomUUID() };
    await assert.rejects(
      post(req({ type: 'replace', id: original.id, entry: invalidAccount })),
      /INVALID_REQUEST/,
    );
    assert.equal((await f.read(manager.token, c.branch, query)).summaries[0].cash_minor, '50025');
    const correction = req(
      { type: 'replace', id: original.id, entry: revised },
      'Invoice amount and date corrected',
    );
    const results = await Promise.all([
      post(correction, reviewer.token),
      post(correction, reviewer.token),
    ]);
    assert.deepEqual(results[0], { id: revised.id, replaced_id: original.id });
    assert.deepEqual(results[0], results[1]);
    await assert.rejects(
      post(req({ type: 'replace', id: original.id, entry: { ...revised, id: randomUUID() } })),
      /CONFLICT/,
    );
    await assert.rejects(post(req({ type: 'void', id: original.id })), /CONFLICT/);
    let d = await f.read(manager.token, c.branch, query);
    assert.deepEqual(d.summaries, []);
    assert.equal(d.journal[0].replaced_by, revised.id);
    const history = d.journal[0].history;
    assert.deepEqual(
      history.map((e) => e.action),
      ['finance.entry', 'finance.replace'],
    );
    assert.deepEqual(history[1].before, original);
    assert.deepEqual(history[1].after, revised);
    assert.equal(history[1].author, 'Synthetic reviewer');
    assert.equal(history[1].actor_id, reviewer.actor_id);
    const november = {
      start_date: '2026-11-01',
      end_date: '2026-11-30',
      search: 'Corrected',
      center: 'workshop',
    };
    d = await f.read(manager.token, c.branch, november);
    assert.equal(d.summaries[0].cash_minor, '60025');
    assert.deepEqual(d.journal[0].history, history);
    // Two editors cannot silently overwrite each other; one replacement wins.
    const candidates = [1, 2].map((n) => ({
      ...revised,
      id: randomUUID(),
      amount_minor: String(70000 + n),
    }));
    const race = await Promise.allSettled(
      candidates.map((entry) => post(req({ type: 'replace', id: revised.id, entry }))),
    );
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
    assert.match(race.find((r) => r.status === 'rejected').reason.message, /CONFLICT/);
    const winner = candidates[race.findIndex((r) => r.status === 'fulfilled')];
    const removal = req({ type: 'void', id: winner.id }, 'Duplicate invoice removed');
    await post(removal, reviewer.token);
    await post(removal, reviewer.token);
    d = await f.read(manager.token, c.branch, query);
    assert.deepEqual(
      d.journal[0].history.map((e) => e.action),
      ['finance.entry', 'finance.replace', 'finance.replace', 'finance.void'],
    );
    assert.equal(d.journal[0].history[3].reason, 'Duplicate invoice removed');
    assert.deepEqual(d.journal[0].history[3].before, winner);
    assert.equal(d.journal[0].history[3].after, null);
    assert.equal(d.journal[0].history[3].actor_id, reviewer.actor_id);
    assert.deepEqual((await f.read(manager.token, c.branch, november)).summaries, []);
    // Another branch cannot edit or see these revisions even with a valid manager.
    const other = randomUUID();
    await c.cloud.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'OTHER','Synthetic other')",
      [other, c.org, c.legal],
    );
    const outsider = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Synthetic other',
      branch_ids: [other],
    });
    await grantBackoffice(c.cloud.pool, outsider.actor_id, other, 'manager');
    await assert.rejects(
      f.command(
        outsider.token,
        other,
        req({ type: 'replace', id: original.id, entry: { ...revised, id: randomUUID() } }),
      ),
      /NOT_FOUND/,
    );
    assert.deepEqual((await f.read(outsider.token, other, query)).journal, []);
    await grantBackoffice(c.cloud.pool, reviewer.actor_id, c.branch, 'analyst');
    assert.equal((await f.read(reviewer.token, c.branch, query)).journal[0].history.length, 4);
    await assert.rejects(
      post(
        req({ type: 'replace', id: winner.id, entry: { ...revised, id: randomUUID() } }),
        reviewer.token,
      ),
      /FORBIDDEN/,
    );
  }));
