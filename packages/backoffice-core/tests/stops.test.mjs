/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { branchAvailability } from '@pickchick/commerce-core';
import { localCatalogId, localSelectionIds, projectCatalogMenu } from '@pickchick/menu-sync';
import { fixture } from '../../fulfillment-transport/tests/cloud-fixture.mjs';
import { pullFulfillment } from '../../fulfillment-transport/dist/index.js';
import { CatalogAdmin, provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { previewId } from '../../../scripts/local-pos-draft.mjs';
import { Backoffice, BackofficeError, backofficeOptions, grantBackoffice } from '../dist/index.js';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import { backofficeStopGrants } from '../../../infra/staging/backoffice-stop-grants.mjs';
import { fulfillmentTransportGrants } from '../../../infra/staging/fulfillment-transport-grants.mjs';
import { createApi } from '../../../services/api/dist/index.js';

const failure = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;

async function publishCatalog(pool, token, branch) {
  const catalog = new CatalogAdmin(pool, { enabled: true });
  let state = await catalog.seed(token, branch, { expected_revision: 0, request_id: randomUUID() });
  const payload = structuredClone(state.draft.payload);
  payload.content_reviewed = true;
  state = await catalog.save(token, branch, {
    expected_revision: state.draft.revision,
    request_id: randomUUID(),
    payload,
  });
  await catalog.publish(token, branch, {
    expected_revision: state.draft.revision,
    expected_published_version: 0,
    request_id: randomUUID(),
    confirmation: 'publish_catalog',
  });
  return payload;
}

function stopFixture(run, { publish = true, heartbeat = true } = {}) {
  return fixture(async (f) => {
    const branch = f.scope.branchId;
    const manager = await provisionCatalogManager(f.pool, {
      organization_id: f.scope.organizationId,
      name: 'Synthetic shift lead',
      branch_ids: [branch],
    });
    const analyst = await provisionCatalogManager(f.pool, {
      organization_id: f.scope.organizationId,
      name: 'Synthetic analyst',
      branch_ids: [branch],
    });
    await grantBackoffice(f.pool, manager.actor_id, branch, 'manager');
    await grantBackoffice(f.pool, analyst.actor_id, branch, 'analyst');
    const payload = publish ? await publishCatalog(f.pool, manager.token, branch) : null;
    let revision = 0;
    /** One heartbeat from the bound edge, exactly as the Windows worker sends it. */
    const heartbeat4 = (body = {}, protocolVersion = 4) =>
      pullFulfillment(f.pool, f.auth, {
        workerId: f.workerId,
        leaseSeconds: 15,
        availability: { revision: String(++revision), stoppedIds: body.stoppedIds ?? [] },
        ...(protocolVersion === 4
          ? {
              protocolVersion,
              stopStates: body.stopStates ?? [],
              ...(body.stopReceipts ? { stopReceipts: body.stopReceipts } : {}),
            }
          : {}),
      });
    if (heartbeat) await heartbeat4();
    const bo = new Backoffice(f.pool, true, { remoteStopsEnabled: true });
    const stop = (patch = {}) => ({
      request_id: randomUUID(),
      catalog_ref: { product_id: 'burger' },
      stopped: true,
      duration: 'manual',
      reason: 'Закончились булочки',
      expected_version: 0,
      ...patch,
    });
    const commands = async () =>
      (await f.pool.query('SELECT * FROM cloud_stop_commands ORDER BY created_at,id')).rows;
    await run({ ...f, branch, manager, analyst, payload, bo, stop, commands, heartbeat4 });
  });
}
/** Simulated clock: the guard owns created_at/expires_at, so tests move them with it disabled. */
async function age(pool, id, seconds) {
  await pool.query('ALTER TABLE cloud_stop_commands DISABLE TRIGGER cloud_stop_command_guard');
  try {
    await pool.query(
      `UPDATE cloud_stop_commands SET created_at=created_at-$2*interval '1 second',expires_at=expires_at-$2*interval '1 second',
      delivered_at=delivered_at-$2*interval '1 second' WHERE id=$1`,
      [id, seconds],
    );
  } finally {
    await pool.query('ALTER TABLE cloud_stop_commands ENABLE TRIGGER cloud_stop_command_guard');
  }
}

test('BACKOFFICE_REMOTE_STOPS_ENABLED defaults off and accepts only true or false', () => {
  assert.deepEqual(backofficeOptions({}), { remoteStopsEnabled: false });
  assert.deepEqual(backofficeOptions({ BACKOFFICE_REMOTE_STOPS_ENABLED: 'false' }), {
    remoteStopsEnabled: false,
  });
  assert.deepEqual(backofficeOptions({ BACKOFFICE_REMOTE_STOPS_ENABLED: 'true' }), {
    remoteStopsEnabled: true,
  });
  for (const value of ['1', 'TRUE', 'yes', ''])
    assert.throws(() => backofficeOptions({ BACKOFFICE_REMOTE_STOPS_ENABLED: value }));
  assert.match(
    backofficeStopGrants('pickchick_app', false),
    /^REVOKE INSERT ON cloud_stop_commands/,
  );
  assert.doesNotMatch(backofficeStopGrants('pickchick_app', false), /SELECT|UPDATE/);
  assert.throws(() => backofficeStopGrants('bad role', true));
  assert.throws(() => backofficeStopGrants('pickchick_app', 'true'));
});

test('stop commands need the flag, a manager, a publication and a protocol-4 edge', () =>
  stopFixture(
    async (f) => {
      const off = new Backoffice(f.pool, true);
      await assert.rejects(
        off.requestStop(f.manager.token, f.branch, f.stop()),
        failure('SERVICE_UNAVAILABLE', 'REMOTE_STOPS_DISABLED'),
      );
      await assert.rejects(
        f.bo.requestStop(f.analyst.token, f.branch, f.stop()),
        (e) => e instanceof BackofficeError && e.code === 'FORBIDDEN',
      );
      await assert.rejects(f.bo.requestStop('0'.repeat(64), f.branch, f.stop()), /UNAUTHORIZED/);
      await assert.rejects(f.bo.requestStop(f.manager.token, randomUUID(), f.stop()), /FORBIDDEN/);
      await assert.rejects(
        f.bo.requestStop(f.manager.token, f.branch, f.stop()),
        failure('NOT_READY', 'CATALOG_NOT_PUBLISHED'),
      );
      await publishCatalog(f.pool, f.manager.token, f.branch);
      // No protocol-4 heartbeat yet: nothing would deliver the command.
      await assert.rejects(
        f.bo.requestStop(f.manager.token, f.branch, f.stop()),
        failure('NOT_READY', 'EDGE_STOPS_NOT_READY'),
      );
      // A protocol-2 heartbeat refreshes availability but cannot carry commands.
      await f.heartbeat4({}, 2);
      await assert.rejects(
        f.bo.requestStop(f.manager.token, f.branch, f.stop()),
        failure('NOT_READY', 'EDGE_STOPS_NOT_READY'),
      );
      await f.heartbeat4();
      for (const invalid of [
        { catalog_ref: { product_id: 'burger', group_id: 'drink' } },
        { catalog_ref: { product_id: 'Burger' } },
        { catalog_ref: { product_id: 'burger', extra: true } },
        { stopped: false, duration: 'hour' },
        { reason: ' x ' },
        { expected_version: -1 },
        { expected_version: 1.5 },
        { duration: 'day' },
      ])
        await assert.rejects(
          f.bo.requestStop(f.manager.token, f.branch, f.stop(invalid)),
          /INVALID_REQUEST/,
        );
      assert.deepEqual(await f.commands(), []);
      const created = await f.bo.requestStop(f.manager.token, f.branch, f.stop());
      assert.equal(created.state, 'pending');
      // The device that answered is revoked: no edge can take the next command.
      await f.pool.query("UPDATE devices SET status='revoked' WHERE id=$1", [f.auth.deviceId]);
      await assert.rejects(
        f.bo.requestStop(
          f.manager.token,
          f.branch,
          f.stop({ catalog_ref: { product_id: 'toast' } }),
        ),
        failure('NOT_READY', 'EDGE_STOPS_NOT_READY'),
      );
    },
    { publish: false, heartbeat: false },
  ));

test('a stop resolves the POS identity from the publication, is idempotent and audited', () =>
  stopFixture(async (f) => {
    await assert.rejects(
      f.bo.requestStop(
        f.manager.token,
        f.branch,
        f.stop({ catalog_ref: { product_id: 'no-such-item' } }),
      ),
      failure('NOT_FOUND', 'CATALOG_ITEM_NOT_FOUND'),
    );
    await assert.rejects(
      f.bo.requestStop(
        f.manager.token,
        f.branch,
        f.stop({ catalog_ref: { product_id: 'pick-combo', group_id: 'drink', option_id: 'nope' } }),
      ),
      failure('NOT_FOUND', 'CATALOG_ITEM_NOT_FOUND'),
    );
    const request = f.stop({ expected_version: 7, duration: 'hour' });
    const created = await f.bo.requestStop(f.manager.token, f.branch, request);
    const variant = localCatalogId(f.branch, 'base-preview', 'burger');
    // Same id as the installed POS draft (scripts/local-pos-draft.mjs) and the menu projection.
    assert.equal(variant, previewId(f.branch, 'base-preview', 'burger'));
    const menu = projectCatalogMenu(f.payload, f.branch, 3, new Date().toISOString());
    assert.equal(menu.items.find((i) => i.source_id === 'burger').variant_id, variant);
    assert.equal(created.variant_id, variant);
    assert.deepEqual(created.catalog_ref, { product_id: 'burger' });
    assert.equal(created.expected_version, 7);
    assert.equal(created.state, 'pending');
    const [row] = await f.commands();
    assert.equal(row.id, created.command_id);
    assert.equal(row.variant_id, variant);
    assert.equal(row.catalog_ref, 'burger');
    assert.equal(row.stopped, true);
    assert.equal(row.duration, 'hour');
    assert.equal(row.expected_version, 7);
    assert.equal(row.reason, 'Закончились булочки');
    assert.equal(row.actor_id, f.manager.actor_id);
    assert.equal(row.actor_label, 'Synthetic shift lead');
    assert.equal(row.organization_id, f.scope.organizationId);
    assert.equal(row.expires_at - row.created_at, 120000);
    // Replay returns the stored result; the same request id with another body conflicts.
    assert.deepEqual(
      await f.bo.requestStop(f.manager.token, f.branch, request),
      JSON.parse(JSON.stringify(created)),
    );
    await assert.rejects(
      f.bo.requestStop(f.manager.token, f.branch, { ...request, reason: 'Другая причина' }),
      (e) => e instanceof BackofficeError && e.code === 'CONFLICT' && e.reason === undefined,
    );
    // One open command per variant: the next one waits for the edge verdict or expiry.
    await assert.rejects(
      f.bo.requestStop(f.manager.token, f.branch, f.stop({ stopped: false })),
      failure('CONFLICT', 'STOP_COMMAND_IN_PROGRESS'),
    );
    assert.equal((await f.commands()).length, 1);
    const audit = (await f.pool.query('SELECT * FROM bo_audit ORDER BY created_at')).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'remote_stop:stop');
    assert.equal(audit[0].entity_id, created.command_id);
    assert.equal(audit[0].actor_id, f.manager.actor_id);
    assert.equal(audit[0].reason, 'Закончились булочки');
    assert.equal(audit[0].before_value, null);
    assert.equal(audit[0].after_value.command_id, created.command_id);
    // Fail closed: mobile and kiosk stop selling before the edge answers.
    assert.ok((await branchAvailability(f.pool, f.branch)).stoppedIds.includes(variant));

    // Options hash with the product, group and option slug, like the POS modifier ids.
    const option = await f.bo.requestStop(
      f.manager.token,
      f.branch,
      f.stop({
        catalog_ref: { product_id: 'pick-combo', group_id: 'drink', option_id: 'cola-bottle' },
      }),
    );
    const [, optionId] = localSelectionIds(f.branch, 'pick-combo', [
      { group_id: 'drink', option_id: 'cola-bottle' },
    ]);
    assert.equal(option.variant_id, optionId);
    assert.equal(
      option.variant_id,
      previewId(f.branch, 'modifier-option', 'pick-combo:drink:cola-bottle'),
    );
    assert.ok(
      menu.items
        .find((i) => i.source_id === 'pick-combo')
        .modifier_groups.some((g) => g.options.some((o) => o.id === optionId)),
    );
    assert.equal((await f.commands())[1].catalog_ref, 'pick-combo:drink:cola-bottle');

    // A command the edge never picked up lapses; the next request closes it and may proceed.
    await age(f.pool, created.command_id, 121);
    const next = await f.bo.requestStop(
      f.manager.token,
      f.branch,
      f.stop({ stopped: false, expected_version: 0 }),
    );
    const rows = await f.commands();
    assert.equal(rows.find((r) => r.id === created.command_id).state, 'expired');
    assert.equal(rows.find((r) => r.id === next.command_id).state, 'pending');
    // A pending UNSTOP never unblocks sales by itself.
    assert.ok(!(await branchAvailability(f.pool, f.branch)).stoppedIds.includes(variant));
  }));

test('concurrent commands for one variant: exactly one is queued', () =>
  stopFixture(async (f) => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => f.bo.requestStop(f.manager.token, f.branch, f.stop())),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results.filter((r) => r.status === 'rejected'))
      assert.ok(failure('CONFLICT', 'STOP_COMMAND_IN_PROGRESS')(r.reason), String(r.reason));
    assert.equal((await f.commands()).length, 1);
  }));

test('stop list v2 shows catalog names, edge versions, open commands and edge verdicts', () =>
  stopFixture(async (f) => {
    const burger = localCatalogId(f.branch, 'base-preview', 'burger'),
      toast = localCatalogId(f.branch, 'base-preview', 'toast'),
      legacy = randomUUID(),
      stranger = randomUUID();
    const category = randomUUID();
    await f.pool.query(
      "INSERT INTO categories(id,organization_id,name_ru,name_kk) VALUES($1,$2,'Synthetic','Synthetic')",
      [category, f.scope.organizationId],
    );
    await f.pool.query(
      "INSERT INTO products(id,organization_id,category_id,name_ru,name_kk) VALUES($1,$2,$3,'Legacy item','Legacy item')",
      [legacy, f.scope.organizationId, category],
    );
    const cashierStop = {
      id: burger,
      version: 2,
      stopped: true,
      source: 'pos',
      expiresAt: null,
      shiftScoped: true,
    };
    await f.heartbeat4({ stoppedIds: [burger, legacy, stranger], stopStates: [cashierStop] });
    let view = await f.bo.stops(f.analyst.token, f.branch);
    assert.equal(view.schema_version, 2);
    assert.equal(view.role, 'analyst');
    assert.deepEqual(view.remote_stops, { enabled: true, edge_ready: true, writable: false });
    assert.equal(view.catalog.version, 1);
    assert.equal(view.availability.fresh, true);
    assert.equal(view.availability.states_reported, true);
    assert.equal(view.availability.stopped_count, 3);
    const products = view.items.filter((i) => i.kind === 'product');
    assert.equal(products.length, f.payload.products.length);
    assert.equal(
      view.items.length,
      f.payload.products.reduce(
        (n, p) => n + 1 + p.modifier_groups.reduce((m, g) => m + g.options.length, 0),
        0,
      ),
    );
    let row = view.items.find((i) => i.variant_id === burger);
    assert.deepEqual(row, {
      catalog_ref: { product_id: 'burger' },
      variant_id: burger,
      kind: 'product',
      name_ru: 'Бургер, 1 шт',
      product_name_ru: 'Бургер, 1 шт',
      group_name_ru: null,
      listed: true,
      stopped: true,
      version: 2,
      source: 'pos',
      expires_at: null,
      shift_scoped: true,
      sales_blocked: true,
      pending: null,
      last_result: null,
    });
    const toastRow = view.items.find((i) => i.variant_id === toast);
    assert.equal(toastRow.stopped, false);
    assert.equal(toastRow.version, 0);
    const option = view.items.find(
      (i) => i.kind === 'option' && i.catalog_ref.product_id === 'pick-combo',
    );
    assert.equal(option.product_name_ru, 'Pick Combo');
    assert.ok(option.group_name_ru);
    assert.equal(
      option.variant_id,
      localCatalogId(
        f.branch,
        'modifier-option',
        `pick-combo:${option.catalog_ref.group_id}:${option.catalog_ref.option_id}`,
      ),
    );
    // Ids outside the publication keep the legacy-table fallback.
    assert.deepEqual(
      view.unknown_stops.map((s) => [s.variant_id, s.name_ru, s.kind]).sort(),
      [
        [legacy, 'Legacy item', 'product'],
        [stranger, null, null],
      ].sort(),
    );
    // v1 keeps its shape and now names catalog hashes too.
    const v1 = (await f.bo.read(f.manager.token, f.branch)).availability;
    assert.deepEqual(v1.stopped_ids, [burger, legacy, stranger].sort());
    assert.equal(v1.writable, false);
    assert.deepEqual(
      v1.stopped_items.map((i) => [i.id, i.name, i.kind]).sort(),
      [
        [burger, 'Бургер, 1 шт', 'variant'],
        [legacy, 'Legacy item', 'product'],
      ].sort(),
    );

    // The manager unstops it with the edge version shown in the list.
    const command = await f.bo.requestStop(
      f.manager.token,
      f.branch,
      f.stop({ stopped: false, expected_version: row.version, reason: 'Привезли булочки' }),
    );
    view = await f.bo.stops(f.manager.token, f.branch);
    assert.equal(view.remote_stops.writable, true);
    row = view.items.find((i) => i.variant_id === burger);
    assert.equal(row.pending.command_id, command.command_id);
    assert.equal(row.pending.state, 'pending');
    assert.equal(row.pending.stopped, false);
    assert.equal(row.pending.actor_label, 'Synthetic shift lead');
    assert.equal(row.stopped, true);
    assert.equal(row.sales_blocked, true);
    // The edge pulls it, applies it and reports the receipt with its new state.
    const delivered = await f.heartbeat4({ stoppedIds: [burger], stopStates: [cashierStop] });
    assert.deepEqual(
      delivered.stopCommands.map((c) => [c.commandId, c.variantId, c.expectedVersion, c.stopped]),
      [[command.command_id, burger, 2, false]],
    );
    assert.equal(delivered.stopCommands[0].actorLabel, 'Synthetic shift lead');
    row = (await f.bo.stops(f.manager.token, f.branch)).items.find((i) => i.variant_id === burger);
    assert.equal(row.pending.state, 'delivered');
    await f.heartbeat4({
      stoppedIds: [],
      stopReceipts: [{ commandId: command.command_id, result: 'applied', version: 3 }],
      stopStates: [{ ...cashierStop, version: 3, stopped: false, source: 'backoffice' }],
    });
    view = await f.bo.stops(f.manager.token, f.branch);
    row = view.items.find((i) => i.variant_id === burger);
    assert.equal(row.stopped, false);
    assert.equal(row.sales_blocked, false);
    assert.equal(row.version, 3);
    assert.equal(row.source, 'backoffice');
    assert.equal(row.pending, null);
    assert.equal(row.last_result.command_id, command.command_id);
    assert.equal(row.last_result.state, 'applied');
    assert.equal(row.last_result.result_version, 3);
    assert.ok(row.last_result.resolved_at);
    assert.deepEqual(view.unknown_stops, []);

    // A conflict verdict carries the edge version for the retry.
    const stale = await f.bo.requestStop(
      f.manager.token,
      f.branch,
      f.stop({ catalog_ref: { product_id: 'toast' }, expected_version: 0 }),
    );
    await f.heartbeat4();
    await f.heartbeat4({
      stopReceipts: [{ commandId: stale.command_id, result: 'conflict', version: 5 }],
    });
    row = (await f.bo.stops(f.manager.token, f.branch)).items.find((i) => i.variant_id === toast);
    assert.equal(row.last_result.state, 'conflict');
    assert.equal(row.version, 5);

    // An unanswered command shows as expired once its deadline passes.
    const lost = await f.bo.requestStop(
      f.manager.token,
      f.branch,
      f.stop({ catalog_ref: { product_id: 'coleslaw' } }),
    );
    await age(f.pool, lost.command_id, 121);
    row = (await f.bo.stops(f.manager.token, f.branch)).items.find(
      (i) => i.catalog_ref.product_id === 'coleslaw',
    );
    assert.equal(row.pending, null);
    assert.equal(row.last_result.state, 'expired');
    assert.equal(row.sales_blocked, false);

    // Freshness and the flag are reported as they are.
    await f.pool.query(
      "UPDATE cloud_branch_availability SET observed_at=clock_timestamp()-interval '31 seconds'",
    );
    view = await new Backoffice(f.pool, true).stops(f.manager.token, f.branch);
    assert.equal(view.availability.fresh, false);
    assert.deepEqual(view.remote_stops, { enabled: false, edge_ready: true, writable: false });
    await assert.rejects(f.bo.stops('0'.repeat(64), f.branch), /UNAUTHORIZED/);
    await assert.rejects(
      new Backoffice(f.pool, false).stops(f.manager.token, f.branch),
      /SERVICE_UNAVAILABLE/,
    );
  }));

test('production-shaped grants queue and read stops without rewriting command intent', () =>
  stopFixture(async (f) => {
    const role = 'bo_stops_' + randomUUID().replaceAll('-', '');
    let pool;
    await f.admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    try {
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
      // Same order as infra/staging/provision.mjs.
      await f.pool.query(fulfillmentTransportGrants(role, true));
      await f.pool.query(backofficeGrants(role, true));
      await f.pool.query(backofficeStopGrants(role, true));
      const url = new URL(f.url);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      pool = createPool(url.toString(), 4);
      const bo = new Backoffice(pool, true, { remoteStopsEnabled: true });
      const created = await bo.requestStop(f.manager.token, f.branch, f.stop());
      await age(f.pool, created.command_id, 121);
      // Closing a lapsed command needs only state/resolved_at.
      const next = await bo.requestStop(f.manager.token, f.branch, f.stop({ stopped: false }));
      const view = await bo.stops(f.manager.token, f.branch);
      assert.equal(view.catalog.version, 1);
      assert.equal(
        view.items.find((i) => i.catalog_ref.product_id === 'burger').pending.command_id,
        next.command_id,
      );
      for (const sql of [
        'UPDATE cloud_stop_commands SET stopped=false',
        'UPDATE cloud_stop_commands SET expected_version=9',
        'DELETE FROM cloud_stop_commands',
        'INSERT INTO catalog_publications SELECT * FROM catalog_publications',
      ])
        await assert.rejects(pool.query(sql), { code: '42501' }, sql);
      // Disabled, only INSERT goes: the transport keeps reading and closing commands.
      await f.pool.query(backofficeStopGrants(role, false));
      await age(f.pool, next.command_id, 121);
      await assert.rejects(bo.requestStop(f.manager.token, f.branch, f.stop()), {
        code: '42501',
      });
      assert.deepEqual(
        (
          await pool.query(
            "SELECT has_table_privilege(current_user,'cloud_stop_commands','SELECT') s, has_column_privilege(current_user,'cloud_stop_commands','delivered_at','UPDATE') u",
          )
        ).rows[0],
        { s: true, u: true },
      );
      assert.equal((await bo.stops(f.manager.token, f.branch)).remote_stops.enabled, true);
    } finally {
      await pool?.end();
      await f.pool.query(`DROP OWNED BY ${role}`);
      await f.admin.query(`DROP ROLE ${role}`);
    }
  }));

test('HTTP stop routes: v2 list, 202 queue, reason envelope and body cap', () =>
  stopFixture(async (f) => {
    const previous = process.env.BACKOFFICE_REMOTE_STOPS_ENABLED;
    process.env.BACKOFFICE_REMOTE_STOPS_ENABLED = 'true';
    let api;
    try {
      api = await createApi({
        service: 'api',
        environment: 'test',
        databaseUrl: f.url.toString(),
        port: 0,
        backofficeEnabled: true,
        catalogAdminEnabled: true,
      });
      await api.listen(0, '127.0.0.1');
      const base = (await api.getUrl()) + '/v1/admin/backoffice/branches/' + f.branch + '/stops';
      const headers = (token) => ({
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      });
      const post = (body, token = f.manager.token) =>
        fetch(base, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
      assert.equal((await fetch(base)).status, 401);
      const list = await fetch(base, { headers: headers(f.analyst.token) });
      assert.equal(list.status, 200);
      const data = await list.json();
      assert.equal(data.schema_version, 2);
      assert.equal(
        data.items.find((i) => i.catalog_ref.product_id === 'burger').name_ru,
        'Бургер, 1 шт',
      );
      assert.equal((await post(f.stop(), f.analyst.token)).status, 403);
      const body = f.stop();
      const created = await post(body);
      assert.equal(created.status, 202);
      const result = await created.json();
      assert.equal(result.state, 'pending');
      assert.deepEqual(await (await post(body)).json(), result);
      const busy = await post(f.stop({ stopped: false }));
      assert.equal(busy.status, 409);
      const envelope = await busy.json();
      assert.equal(envelope.code, 'CONFLICT');
      assert.deepEqual(envelope.error, { code: 'STOP_COMMAND_IN_PROGRESS' });
      assert.ok(envelope.trace_id);
      assert.equal(envelope.retryable, false);
      const unknown = await post(f.stop({ catalog_ref: { product_id: 'no-such-item' } }));
      assert.equal(unknown.status, 404);
      assert.deepEqual((await unknown.json()).error, { code: 'CATALOG_ITEM_NOT_FOUND' });
      const invalid = await post({ ...f.stop(), stopped: 'yes' });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error, undefined);
      const large = await post({ ...f.stop(), padding: 'x'.repeat(17 * 1024) });
      assert.equal(large.status, 413);
      assert.equal((await large.json()).code, 'PAYLOAD_TOO_LARGE');
      assert.equal((await f.commands()).length, 1);
    } finally {
      await api?.close();
      if (previous === undefined) delete process.env.BACKOFFICE_REMOTE_STOPS_ENABLED;
      else process.env.BACKOFFICE_REMOTE_STOPS_ENABLED = previous;
    }
  }));
