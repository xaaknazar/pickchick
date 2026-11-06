// Cutover lane kds, KDS-3: the owner tool infra/windows/kds-switch.mjs on an edge at
// 025 + 026 + 027 (contracts section 7.3): layout-build, layout-apply, enable, disable, status.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { KdsLayoutSchema } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import {
  EdgeFulfillment,
  digest,
  kdsStationId,
  provisionFulfillment,
  provisionKdsStations,
} from '@pickchick/edge-fulfillment';
import { kdsRuntimeGrantSql, kdsWorkerGrantSql } from '../../infra/windows/kds-grants.mjs';
import {
  KDS_RUNTIME_ROLES,
  KDS_WORKER_ROLES,
  KdsSwitchError,
  applyKdsLayout,
  buildKdsLayout,
  formatBuildReport,
  kdsStatus,
  kdsSwitchConfig,
  parseChefTsv,
  parseKdsSwitchArgs,
  parseTerminalsTsv,
  setKdsLayoutEnabled,
} from '../../infra/windows/kds-switch.mjs';
import { seedEdge, withEdgeSchema } from '../../packages/edge-fulfillment/tests/kds-fixture.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const tool = fileURLToPath(new URL('../../infra/windows/kds-switch.mjs', import.meta.url));
const NO_SLUG_NAME = 'Синтетическая позиция без slug';
const CHEF_TSV = [
  'product_slug\tfunction\tunit\tcount',
  '# Панировка: фингерсов на 1 шт.',
  'pick-combo\tbreading\tfinger\t3',
  'strips-3\tbreading\tfinger\t3',
  'pick-burger\ttoasts\tburger\t1',
  'toast-chicken\ttoasts\ttoast\t1',
  ...['pick-combo', 'pick-burger', 'toast-chicken', 'strips-3'].flatMap((slug) => [
    `${slug}\tassembly_hall`,
    `${slug}\tassembly_delivery\t\t`,
  ]),
  'cola\tissue',
  'sauce-cheese\tissue',
].join('\n');

/** Fails with a KdsSwitchError whose code (and optional detail codes) match. */
const kdsError =
  (code, details = []) =>
  (error) => {
    assert.ok(error instanceof KdsSwitchError, String(error));
    assert.equal(error.code, code, JSON.stringify(error.errors));
    for (const detail of details)
      assert.ok(
        error.errors.some((e) => e.code === detail),
        `${detail} in ${JSON.stringify(error.errors)}`,
      );
    return true;
  };

async function withSwitchEdge(run) {
  await withEdgeSchema(async (ctx) => {
    const chain = await ctx.migrateWith({ below: '026', with026: true, with027: true });
    assert.equal(chain.applied.length, 27);
    const seeded = await seedEdge(ctx.pool, { provisionFulfillment });
    const branchId = seeded.scope.branchId;
    await transaction(ctx.pool, (client) => provisionKdsStations(client, branchId));
    const release = randomUUID(),
      category = randomUUID();
    const item = (slug, name) => ({
      product_id: randomUUID(),
      variant_id: randomUUID(),
      category_id: category,
      name: { ru: name, kk: '' },
      price_minor: '150000',
      currency: 'KZT',
      ...(slug ? { source_id: slug } : {}),
    });
    const payload = {
      schema_version: 1,
      release_id: release,
      branch_id: branchId,
      version: 1,
      published_at: '2026-11-10T00:00:00.000Z',
      items: [
        item('pick-combo', 'Pick Combo'),
        item('strips-3', 'Стрипсы 3 шт.'),
        item('pick-burger', 'Pick Burger'),
        item('toast-chicken', 'Тост с курицей'),
        item('cola', 'Кола 0,5'),
        item('sauce-cheese', 'Соус сырный'),
        item('fries', 'Картофель фри'),
        item(null, NO_SLUG_NAME),
      ],
    };
    await ctx.pool.query(
      'INSERT INTO menu_snapshots(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,1,1,$3,$4,$5)',
      [release, branchId, payload, 'f'.repeat(64), payload.published_at],
    );
    await ctx.pool.query('INSERT INTO active_menu(branch_id,release_id) VALUES($1,$2)', [
      branchId,
      release,
    ]);
    const terminal = async ({ active = true, managed } = {}) => {
      const id = randomUUID();
      await ctx.pool.query(
        'INSERT INTO local_terminals(id,branch_id,active,device_access_managed) VALUES($1,$2,$3,$4)',
        [id, branchId, active, Boolean(managed)],
      );
      if (managed) {
        const command = randomUUID();
        await ctx.pool.query(
          "INSERT INTO terminal_access_commands(command_id,branch_id,edge_device_id,terminal_id,generation,payload,state) VALUES($1,$2,$3,$4,1,'{}','applied')",
          [command, branchId, seeded.scope.deviceId, id],
        );
        await ctx.pool.query(
          `INSERT INTO terminal_access_registry(terminal_id,branch_id,edge_device_id,mode,name,generation,command_id,state,code_hash,key_hash,expires_at)
           VALUES($1,$2,$3,$4,'Synthetic screen',1,$5,$6,$7,$8,clock_timestamp()+interval '1 day')`,
          [
            id,
            branchId,
            seeded.scope.deviceId,
            managed.mode,
            command,
            managed.state,
            managed.state === 'pending' ? randomUUID().replaceAll('-', '').repeat(2) : null,
            managed.state === 'paired' ? randomUUID().replaceAll('-', '').repeat(2) : null,
          ],
        );
      }
      return id;
    };
    const screens = {
      t6: await terminal({ managed: { mode: 'prep', state: 'paired' } }),
      t5: await terminal(),
      t1: await terminal({ managed: { mode: 'assembly', state: 'paired' } }),
      t2: await terminal(),
      t3: await terminal(),
      display: await terminal({ managed: { mode: 'display', state: 'paired' } }),
      revoked: await terminal({ managed: { mode: 'assembly', state: 'revoked' } }),
      pending: await terminal({ managed: { mode: 'assembly', state: 'pending' } }),
      off: await terminal({ active: false }),
    };
    const screensTsv = (extra = []) =>
      [
        'function\tterminal_id',
        `breading\t${screens.t6}`,
        `toasts\t${screens.t5}`,
        `assembly_hall\t${screens.t1}`,
        `assembly_delivery\t${screens.t2}`,
        `issue\t${screens.t3}`,
        `issue\t${screens.t1}`,
        `delivery_handover\t${screens.t2}`,
        ...extra,
      ].join('\n');
    const count = async (table) =>
      (await ctx.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    const settings = async () => (await ctx.pool.query('SELECT * FROM kds_settings')).rows[0];
    await run({ ...ctx, ...seeded, branchId, screens, screensTsv, count, settings });
  });
}

test('status and layout-build: the next layout from the chef file and the operator report', () =>
  withSwitchEdge(async (ctx) => {
    const status = await kdsStatus(ctx.pool, { branchId: ctx.branchId });
    assert.equal(status.schema_ready, true);
    assert.equal(status.provisioned, true);
    assert.deepEqual(
      [
        status.settings.layout_enabled,
        status.settings.active_layout_version,
        status.settings.version,
      ],
      [false, null, 1],
    );
    assert.equal(status.active_layout, null);
    assert.ok(status.stations.every((s) => s.present && s.kitchen_access));
    assert.equal(status.kitchen_login, ctx.kitchen);
    assert.deepEqual(
      status.changes.map((c) => c.field),
      ['provisioned'],
    );
    assert.equal(status.summary[0], 'Раскладка KDS: выключена');

    const built = await buildKdsLayout(ctx.pool, {
      branchId: ctx.branchId,
      tsv: CHEF_TSV,
      terminalsTsv: ctx.screensTsv(),
    });
    assert.deepEqual(KdsLayoutSchema.parse(built.layout), built.layout);
    const byFunction = Object.fromEntries(built.layout.stations.map((s) => [s.function, s]));
    assert.equal(built.layout.version, 1);
    assert.deepEqual(Object.keys(byFunction), [
      'breading',
      'toasts',
      'assembly_hall',
      'assembly_delivery',
      'issue',
      'delivery_handover',
    ]);
    for (const station of built.layout.stations)
      assert.equal(station.edge_station_id, kdsStationId(ctx.branchId, station.function));
    assert.deepEqual(byFunction.breading.counts, [
      { product_id: 'pick-combo', unit: 'finger', count: 3 },
      { product_id: 'strips-3', unit: 'finger', count: 3 },
    ]);
    assert.deepEqual(byFunction.toasts.product_ids, ['pick-burger', 'toast-chicken']);
    assert.equal(byFunction.assembly_hall.counts, undefined);
    assert.deepEqual(byFunction.issue.product_ids, ['cola', 'sauce-cheese']);
    assert.deepEqual(byFunction.issue.terminal_ids, [ctx.screens.t3, ctx.screens.t1]);
    assert.deepEqual(byFunction.delivery_handover.product_ids, []);
    assert.deepEqual(built.report.unmapped, ['fries', NO_SLUG_NAME]);
    assert.deepEqual(built.report.warnings, []);
    assert.equal(built.report.terminalsFrom, 'file');
    const text = formatBuildReport(built.report, 'layout-v1.json');
    assert.match(text, /^Позиции меню без раскладки: 2$/m);
    assert.match(text, /^ {2}- fries$/m);
    assert.match(text, /^Панировка \(6\): позиций 2, с количеством 2, экранов 1$/m);
    assert.match(text, /layout-apply --file layout-v1.json/);
    assert.doesNotMatch(text, /[‒-―−]/);

    // Without screens and without an active layout: still built, with a warning.
    const bare = await buildKdsLayout(ctx.pool, { branchId: ctx.branchId, tsv: CHEF_TSV });
    assert.equal(bare.report.terminalsFrom, 'none');
    assert.ok(bare.report.warnings.some((w) => w.code === 'STATION_WITHOUT_SCREEN'));
    // layout-build is read-only.
    assert.deepEqual([await ctx.count('kds_layouts'), (await ctx.settings()).version], [0, 1]);
    await assert.rejects(
      buildKdsLayout(ctx.pool, {
        branchId: ctx.branchId,
        tsv: CHEF_TSV + '\nunknown-burger\tassembly_hall',
      }),
      kdsError('LAYOUT_REJECTED', ['UNKNOWN_PRODUCT']),
    );
    await assert.rejects(
      buildKdsLayout(ctx.pool, {
        branchId: ctx.branchId,
        tsv: CHEF_TSV,
        terminalsTsv: ctx.screensTsv([`issue\t${randomUUID()}`]),
      }),
      kdsError('LAYOUT_REJECTED', ['UNKNOWN_TERMINAL']),
    );
    await assert.rejects(
      buildKdsLayout(ctx.pool, { branchId: randomUUID(), tsv: CHEF_TSV }),
      kdsError('BRANCH_MISMATCH'),
    );
  }));

test('layout-build: station 3 is a tab on the table-2 screen unless the screens file names it', () =>
  withSwitchEdge(async (ctx) => {
    const lines = ctx
      .screensTsv()
      .split('\n')
      .filter((line) => !line.startsWith('delivery_handover\t'));
    const built = await buildKdsLayout(ctx.pool, {
      branchId: ctx.branchId,
      tsv: CHEF_TSV,
      terminalsTsv: lines.join('\n'),
    });
    const at = (fn) => built.layout.stations.find((s) => s.function === fn);
    assert.deepEqual(at('delivery_handover').terminal_ids, [ctx.screens.t2]);
    assert.deepEqual(at('assembly_delivery').terminal_ids, [ctx.screens.t2]);
    assert.equal(built.report.handoverOnTable2, true);
    assert.match(
      formatBuildReport(built.report),
      /^Выдача доставки \(3\): вкладка на экране стола 2 \(по умолчанию\)$/m,
    );
    // An explicit line wins; a table-2 screen that already has two tabs gets no third one.
    const explicit = await buildKdsLayout(ctx.pool, {
      branchId: ctx.branchId,
      tsv: CHEF_TSV,
      terminalsTsv: ctx.screensTsv(),
    });
    assert.equal(explicit.report.handoverOnTable2, false);
    assert.doesNotMatch(formatBuildReport(explicit.report), /по умолчанию/);
    const full = await buildKdsLayout(ctx.pool, {
      branchId: ctx.branchId,
      tsv: CHEF_TSV,
      terminalsTsv: [...lines, `issue\t${ctx.screens.t2}`].join('\n'),
    });
    assert.deepEqual(
      full.layout.stations.find((s) => s.function === 'delivery_handover').terminal_ids,
      [],
    );
    assert.equal(full.report.handoverOnTable2, false);
    // Without a screens file nothing is invented.
    const bare = await buildKdsLayout(ctx.pool, { branchId: ctx.branchId, tsv: CHEF_TSV });
    assert.deepEqual(
      bare.layout.stations.find((s) => s.function === 'delivery_handover').terminal_ids,
      [],
    );
  }));

test('chef and screens TSV problems are reported with their line numbers', () => {
  assert.throws(
    () => parseChefTsv('slug\tfunction\nx\tissue'),
    kdsError('TSV_INVALID', ['TSV_HEADER']),
  );
  const text = [
    'product_slug\tfunction\tunit\tcount',
    'cola\tbar',
    'cola\tissue\tfinger\t1',
    'pick-combo\tbreading\tfinger',
    'pick-combo\tbreading\tfinger\t101',
    'pick-burger\ttoasts\tburger\t1',
    'pick-burger\ttoasts\ttoast\t2',
    'Pick Combo\tassembly_hall',
    'a\tb\tc\td\te',
    'strips-3\tbreading\tfinger\t0',
  ].join('\n');
  let error;
  try {
    parseChefTsv(text);
  } catch (caught) {
    error = caught;
  }
  kdsError('TSV_INVALID', [
    'TSV_FUNCTION',
    'TSV_UNIT',
    'TSV_COUNT',
    'TSV_DUPLICATE',
    'TSV_SLUG',
    'TSV_COLUMNS',
  ])(error);
  const messages = error.errors.map((e) => e.message);
  for (const expected of [
    /^Строка 2: неизвестная функция «bar»/,
    /^Строка 3: единица «finger» не подходит для функции issue \(без количества\)$/,
    /^Строка 4: единица и количество указываются вместе$/,
    /^Строка 5: количество - целое число от 1 до 100$/,
    /^Строка 7: позиция «pick-burger» уже указана для функции toasts \(строка 6\)$/,
    /^Строка 8: неверный slug «Pick Combo»$/,
    /^Строка 9: нужно от 2 до 4 колонок через Tab$/,
    /^Строка 10: количество - целое число от 1 до 100$/,
  ])
    assert.ok(
      messages.some((m) => expected.test(m)),
      `${expected} in ${messages.join(' | ')}`,
    );
  // Spreadsheet exports: BOM, CRLF, trailing tabs, comments and blank lines are fine.
  assert.deepEqual(
    parseChefTsv(
      '﻿product_slug\tfunction\tunit\tcount\t\r\n\r\n# комментарий\r\ncola\tissue\t\t\r\n',
    ),
    [{ line: 4, product_slug: 'cola', function: 'issue' }],
  );
  const id = randomUUID();
  assert.deepEqual(
    [...parseTerminalsTsv(`function\tterminal_id\nissue\t${id}\ntoasts\t${id}`)],
    [
      ['issue', [id]],
      ['toasts', [id]],
    ],
  );
  for (const bad of [
    'terminal\tfunction',
    `function\tterminal_id\nissue\tscreen-1`,
    `function\tterminal_id\nbar\t${id}`,
    `function\tterminal_id\nissue\t${id}\nissue\t${id}`,
  ])
    assert.throws(() => parseTerminalsTsv(bad), kdsError('TSV_INVALID'));
});

test('layout-apply refuses layouts that do not fit this edge and changes nothing', () =>
  withSwitchEdge(async (ctx) => {
    const { layout } = await buildKdsLayout(ctx.pool, {
      branchId: ctx.branchId,
      tsv: CHEF_TSV,
      terminalsTsv: ctx.screensTsv(),
    });
    const variant = (mutate) => {
      const copy = clone(layout);
      mutate(copy);
      return copy;
    };
    const at = (copy, fn) => copy.stations.find((s) => s.function === fn);
    const apply = (value, reason = 'Раскладка шефа для Т9') =>
      applyKdsLayout(ctx.pool, { branchId: ctx.branchId, layout: value, reason });
    await assert.rejects(apply(layout, 'ok'), kdsError('REASON_INVALID'));
    await assert.rejects(apply(layout, 'Причина\nс переносом'), kdsError('REASON_INVALID'));
    await assert.rejects(
      apply(variant((l) => l.stations.splice(4, 1))),
      kdsError('LAYOUT_INVALID'),
    );
    await assert.rejects(apply({ ...layout, extra: 1 }), kdsError('LAYOUT_INVALID'));
    await assert.rejects(
      apply(variant((l) => (l.branch_id = randomUUID()))),
      kdsError('LAYOUT_REJECTED', ['BRANCH_MISMATCH']),
    );
    await assert.rejects(
      apply(variant((l) => (at(l, 'toasts').edge_station_id = randomUUID()))),
      kdsError('LAYOUT_REJECTED', ['STATION_MISMATCH']),
    );
    await assert.rejects(
      apply(variant((l) => at(l, 'assembly_hall').product_ids.push('unknown-burger'))),
      kdsError('LAYOUT_REJECTED', ['UNKNOWN_PRODUCT']),
    );
    for (const [screen, code] of [
      [randomUUID(), 'UNKNOWN_TERMINAL'],
      [ctx.screens.off, 'UNKNOWN_TERMINAL'],
      [ctx.screens.display, 'TERMINAL_MODE_MISMATCH'],
      [ctx.screens.revoked, 'TERMINAL_REVOKED'],
    ])
      await assert.rejects(
        apply(variant((l) => (at(l, 'issue').terminal_ids = [screen]))),
        kdsError('LAYOUT_REJECTED', [code]),
      );
    // A screen paired for assembly cannot open a prep station.
    await assert.rejects(
      apply(variant((l) => (at(l, 'toasts').terminal_ids = [ctx.screens.pending]))),
      kdsError('LAYOUT_REJECTED', ['TERMINAL_MODE_MISMATCH']),
    );
    // One screen on a prep and an assembly station is refused by the schema already.
    await assert.rejects(
      apply(variant((l) => (at(l, 'breading').terminal_ids = [ctx.screens.t3]))),
      kdsError('LAYOUT_INVALID'),
    );
    await assert.rejects(apply({ ...layout, version: 2 }), kdsError('VERSION_NOT_NEXT'));
    assert.deepEqual(
      [await ctx.count('kds_layouts'), await ctx.count('kds_setting_changes')],
      [0, 1],
    );
    assert.equal((await ctx.settings()).version, 1);
  }));

test('apply, replay, enable preconditions, enable and disable: every change is audited', () =>
  withSwitchEdge(async (ctx) => {
    const reason = (text) => `${text} (синтетика)`;
    const enable = (enabled, text = 'Т9 учение') =>
      setKdsLayoutEnabled(ctx.pool, { branchId: ctx.branchId, enabled, reason: reason(text) });
    await assert.rejects(enable(true), kdsError('NO_LAYOUT'));
    assert.deepEqual((await enable(false)).changed, false);
    assert.equal(await ctx.count('kds_setting_changes'), 1);

    // v1 without screens: accepted with a warning, but it cannot be switched on.
    const first = await buildKdsLayout(ctx.pool, { branchId: ctx.branchId, tsv: CHEF_TSV });
    const applied = await applyKdsLayout(ctx.pool, {
      branchId: ctx.branchId,
      layout: first.layout,
      reason: reason('Черновик шефа'),
    });
    assert.deepEqual(
      [applied.applied, applied.version, applied.settings_version, applied.layout_enabled],
      [true, 1, 2, false],
    );
    assert.ok(applied.warnings.some((w) => w.code === 'STATION_WITHOUT_SCREEN'));
    assert.deepEqual(applied.unmapped, ['fries', NO_SLUG_NAME]);
    const replay = await applyKdsLayout(ctx.pool, {
      branchId: ctx.branchId,
      layout: JSON.parse(JSON.stringify(first.layout)),
      reason: reason('Повтор после обрыва'),
    });
    assert.deepEqual([replay.replayed, replay.settings_version], [true, 2]);
    const changed = clone(first.layout);
    changed.stations[4].product_ids.push('fries');
    await assert.rejects(
      applyKdsLayout(ctx.pool, {
        branchId: ctx.branchId,
        layout: changed,
        reason: reason('x y z'),
      }),
      kdsError('VERSION_CONFLICT'),
    );
    await assert.rejects(enable(true), kdsError('ENABLE_REJECTED', ['STATION_WITHOUT_SCREEN']));

    // v2 with screens (one still waiting for pairing: a warning, not a blocker).
    const second = await buildKdsLayout(ctx.pool, {
      branchId: ctx.branchId,
      tsv: CHEF_TSV,
      terminalsTsv: ctx.screensTsv([`delivery_handover\t${ctx.screens.pending}`]),
    });
    assert.equal(second.layout.version, 2);
    const secondApplied = await applyKdsLayout(ctx.pool, {
      branchId: ctx.branchId,
      layout: second.layout,
      reason: reason('Раскладка шефа'),
    });
    assert.ok(secondApplied.warnings.some((w) => w.code === 'TERMINAL_NOT_PAIRED'));
    // The kitchen login must open every station before KDS goes live.
    const toasts = kdsStationId(ctx.branchId, 'toasts');
    await ctx.pool.query('DELETE FROM fulfillment_station_grants WHERE station_id=$1', [toasts]);
    await assert.rejects(enable(true), kdsError('ENABLE_REJECTED', ['KITCHEN_GRANTS_MISSING']));
    await transaction(ctx.pool, (client) => provisionKdsStations(client, ctx.branchId));

    const on = await enable(true);
    assert.deepEqual(
      [on.changed, on.layout_enabled, on.active_layout_version, on.settings_version],
      [true, true, 2, 4],
    );
    assert.ok(on.warnings.some((w) => w.code === 'TERMINAL_NOT_PAIRED'));
    assert.equal((await enable(true)).changed, false);
    assert.equal(await ctx.count('kds_setting_changes'), 4);

    // A chef fix while live: screens carried over from the active layout, KDS stays on.
    const third = await buildKdsLayout(ctx.pool, {
      branchId: ctx.branchId,
      tsv: CHEF_TSV + '\nfries\tissue',
    });
    assert.equal(third.report.terminalsFrom, 'active_layout');
    assert.deepEqual(third.report.unmapped, [NO_SLUG_NAME]);
    assert.deepEqual(
      third.layout.stations.map((s) => s.terminal_ids),
      second.layout.stations.map((s) => s.terminal_ids),
    );
    const live = await applyKdsLayout(ctx.pool, {
      branchId: ctx.branchId,
      layout: third.layout,
      reason: reason('Фри на выдаче'),
    });
    assert.deepEqual([live.version, live.layout_enabled, live.settings_version], [3, true, 5]);

    const off = await enable(false, 'Возврат до 19.11');
    assert.deepEqual([off.changed, off.layout_enabled, off.settings_version], [true, false, 6]);
    assert.equal((await enable(false)).changed, false);

    const settings = await ctx.settings();
    assert.deepEqual(
      [settings.layout_enabled, settings.active_layout_version, settings.version],
      [false, 3, 6],
    );
    const changes = (
      await ctx.pool.query(
        'SELECT version,field,value,actor,staff_id,reason FROM kds_setting_changes ORDER BY version',
      )
    ).rows;
    assert.deepEqual(
      changes.map((c) => [c.version, c.field, c.value]),
      [
        [1, 'provisioned', null],
        [2, 'active_layout_version', '1'],
        [3, 'active_layout_version', '2'],
        [4, 'layout_enabled', 'true'],
        [5, 'active_layout_version', '3'],
        [6, 'layout_enabled', 'false'],
      ],
    );
    assert.ok(changes.every((c) => c.actor === 'operator' && c.staff_id === null));
    assert.equal(changes[5].reason, 'Возврат до 19.11 (синтетика)');
    const layouts = (
      await ctx.pool.query(
        'SELECT version,layout,checksum,source FROM kds_layouts ORDER BY version',
      )
    ).rows;
    assert.deepEqual(
      layouts.map((l) => [l.version, l.source, l.checksum === digest(l.layout)]),
      [
        [1, 'operator', true],
        [2, 'operator', true],
        [3, 'operator', true],
      ],
    );
    const status = await kdsStatus(ctx.pool, { branchId: ctx.branchId });
    assert.equal(status.active_layout.version, 3);
    assert.deepEqual(
      status.changes.map((c) => c.version),
      [6, 5, 4, 3, 2, 1],
    );
    assert.deepEqual(status.summary.slice(0, 2), [
      'Раскладка KDS: выключена',
      'Активная раскладка: версия 3',
    ]);
  }));

/** A cloud order admitted on the old stations (layout off), optionally an aggregator order. */
async function oldStationOrder(ctx, delivery) {
  await ctx.pool.query('UPDATE branch_config SET ordering_enabled=true WHERE id=$1', [
    ctx.branchId,
  ]);
  const repo = new EdgeFulfillment(ctx.pool);
  const snapshot = {
    organizationId: ctx.scope.organizationId,
    branchId: ctx.branchId,
    legalEntityId: randomUUID(),
    customerId: randomUUID(),
    channel: 'mobile',
    serviceMode: 'takeaway',
    currency: 'KZT',
    totalMinor: '150000',
    ttlSeconds: 300,
    ...(delivery ? { delivery } : {}),
    lines: [
      {
        lineId: randomUUID(),
        productId: 'synthetic-burger',
        title: 'Synthetic burger',
        description: '',
        quantity: 1,
        unitPriceMinor: '150000',
        discountMinor: '0',
        grossMinor: '150000',
        totalMinor: '150000',
        taxCode: 'SYNTHETIC',
      },
    ],
  };
  const payload = {
    orderId: randomUUID(),
    branchId: ctx.branchId,
    quoteId: randomUUID(),
    quoteDigest: digest(snapshot),
    snapshot,
    owner: 'cloud',
  };
  const held = await repo.acceptCloud(ctx.scope, {
    eventId: randomUUID(),
    type: 'edge.admission_requested',
    payload,
  });
  return repo.acceptCloud(ctx.scope, {
    eventId: randomUUID(),
    type: 'edge.kitchen_admission_requested',
    payload: {
      orderId: payload.orderId,
      branchId: ctx.branchId,
      reservationId: held.reservationId,
      deviceId: ctx.scope.deviceId,
      quoteDigest: payload.quoteDigest,
      snapshot,
      owner: 'cloud',
    },
  });
}

test('enable: the fulfillment worker must read the layout; open orders on old stations are reported', () =>
  withSwitchEdge(async (ctx) => {
    assert.deepEqual(KDS_WORKER_ROLES, [
      'pickchick_fulfillment_sync',
      'pickchick_fulfillment_worker',
    ]);
    const role = 'kds_switch_worker_' + randomUUID().replaceAll('-', '').slice(0, 16);
    const absent = 'kds_switch_absent_' + randomUUID().replaceAll('-', '').slice(0, 16);
    await ctx.admin.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT`);
    try {
      const built = await buildKdsLayout(ctx.pool, {
        branchId: ctx.branchId,
        tsv: CHEF_TSV,
        terminalsTsv: ctx.screensTsv(),
      });
      await applyKdsLayout(ctx.pool, {
        branchId: ctx.branchId,
        layout: built.layout,
        reason: 'Раскладка шефа (синтетика)',
      });
      // The runtime role is covered by its own test; here it is absent (a development edge).
      const enable = (workerRoles) =>
        setKdsLayoutEnabled(ctx.pool, {
          branchId: ctx.branchId,
          enabled: true,
          reason: 'Т9 учение (синтетика)',
          workerRoles,
          runtimeRoles: [absent],
        });
      const status = (workerRoles) =>
        kdsStatus(ctx.pool, { branchId: ctx.branchId, workerRoles, runtimeRoles: [absent] });
      const blindText =
        'У воркера fulfillment нет прав чтения раскладки KDS - заказы приложения и киоска уйдут на старые станции' +
        ` (роль ${role})`;

      // A worker role without the KDS rights: cloud orders would stay on the old stations.
      await assert.rejects(
        enable([role, absent]),
        kdsError('ENABLE_REJECTED', ['WORKER_GRANTS_MISSING']),
      );
      await ctx.pool.query(`GRANT USAGE ON SCHEMA ${ctx.schema} TO ${role}`);
      await assert.rejects(enable([role]), kdsError('ENABLE_REJECTED', ['WORKER_GRANTS_MISSING']));
      const before = await status([role, absent]);
      assert.deepEqual(before.worker_roles, [{ role, layout_read: false }]);
      assert.equal(before.summary[3], blindText);
      assert.equal((await ctx.settings()).layout_enabled, false, 'nothing changed');
      assert.equal(await ctx.count('kds_setting_changes'), 2);

      // Open orders on the old stations (one of them an aggregator order): reported, not refused.
      await oldStationOrder(ctx);
      await oldStationOrder(ctx, { provider: 'glovo', externalNumber: 'G-777' });
      assert.deepEqual((await status([role])).orders_on_old_stations, {
        orders: 2,
        delivery: 1,
      });
      await ctx.pool.query(kdsWorkerGrantSql(role, ctx.schema));
      const on = await enable([role, absent]);
      assert.equal(on.changed, true);
      const warning = on.warnings.find((w) => w.code === 'OPEN_ORDERS_ON_OLD_STATIONS');
      assert.equal(
        warning?.message,
        'Открытых заказов на старых станциях: 2 (из них агрегаторов: 1) - их завершает начальник смены через переключатель станций',
      );
      const after = await status([role]);
      assert.deepEqual(after.worker_roles, [{ role, layout_read: true }]);
      assert.deepEqual(after.summary.slice(0, 1).concat(after.summary.slice(3)), [
        'Раскладка KDS: включена',
        'Воркер fulfillment читает раскладку KDS',
        'Роль рантайма edge на сервере точки не найдена',
        'Открытых заказов на старых станциях: 2 (из них агрегаторов: 1) - их завершает начальник смены через переключатель станций',
      ]);
      // No worker role on this server (a development edge): reported, never a blocker.
      assert.equal(
        (await status([absent])).summary[3],
        'Роль воркера fulfillment на сервере точки не найдена',
      );
      for (const text of [...on.warnings.map((w) => w.message), ...after.summary])
        assert.doesNotMatch(text, /[‒-―−]/);
    } finally {
      await ctx.admin.query(`DROP OWNED BY ${role}`).catch(() => {});
      await ctx.admin.query(`DROP ROLE IF EXISTS ${role}`);
    }
  }));

test('enable: the edge runtime must hold its KDS rights, or the kitchen and the cashier keep the old stations', () =>
  withSwitchEdge(async (ctx) => {
    assert.deepEqual(KDS_RUNTIME_ROLES, ['pickchick_edge_runtime']);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const runtime = 'kds_switch_runtime_' + suffix,
      worker = 'kds_switch_worker_' + suffix;
    await ctx.admin.query(`CREATE ROLE ${runtime} NOLOGIN NOINHERIT`);
    await ctx.admin.query(`CREATE ROLE ${worker} NOLOGIN NOINHERIT`);
    try {
      await ctx.pool.query(`GRANT USAGE ON SCHEMA ${ctx.schema} TO ${runtime}, ${worker}`);
      await ctx.pool.query(kdsWorkerGrantSql(worker, ctx.schema));
      const built = await buildKdsLayout(ctx.pool, {
        branchId: ctx.branchId,
        tsv: CHEF_TSV,
        terminalsTsv: ctx.screensTsv(),
      });
      await applyKdsLayout(ctx.pool, {
        branchId: ctx.branchId,
        layout: built.layout,
        reason: 'Раскладка шефа (синтетика)',
      });
      const roles = { workerRoles: [worker], runtimeRoles: [runtime] };
      const enable = () =>
        setKdsLayoutEnabled(ctx.pool, {
          branchId: ctx.branchId,
          enabled: true,
          reason: 'Т9 учение (синтетика)',
          ...roles,
        });
      const status = () => kdsStatus(ctx.pool, { branchId: ctx.branchId, ...roles });
      const missing =
        'У рантайма edge нет прав на таблицы KDS - экраны кухни и касса останутся на старых станциях, передача курьеру не запишется' +
        ` (роль ${runtime})`;
      const onlyRuntime = (error) => {
        kdsError('ENABLE_REJECTED', ['RUNTIME_GRANTS_MISSING'])(error);
        assert.deepEqual(
          error.errors.map((e) => e.code),
          ['RUNTIME_GRANTS_MISSING'],
        );
        return true;
      };

      // No KDS rights: readKdsLayout reports the layout as off to the kitchen API and the cashier.
      await assert.rejects(enable(), onlyRuntime);
      // Reading the layout is not enough: the courier journals need SELECT and INSERT.
      await ctx.pool.query(kdsWorkerGrantSql(runtime, ctx.schema));
      await assert.rejects(enable(), onlyRuntime);
      const before = await status();
      assert.deepEqual(before.runtime_roles, [{ role: runtime, kds_rights: false }]);
      assert.equal(before.summary[3], 'Воркер fulfillment читает раскладку KDS');
      assert.equal(before.summary[4], missing);
      assert.equal((await ctx.settings()).layout_enabled, false, 'nothing changed');

      // RUNTIME_PRIVILEGES exactly as kds-upgrade-db installs them (CR kds-1).
      await ctx.pool.query(kdsRuntimeGrantSql(runtime, ctx.schema));
      const on = await enable();
      assert.equal(on.changed, true);
      const after = await status();
      assert.deepEqual(after.runtime_roles, [{ role: runtime, kds_rights: true }]);
      assert.equal(after.summary[4], 'Рантайм edge читает раскладку KDS и пишет журналы передачи');
      // A later partial reset of the runtime rights shows up in status.
      await ctx.pool.query(`REVOKE INSERT ON ${ctx.schema}.courier_incidents FROM ${runtime}`);
      assert.equal((await status()).summary[4], missing);
      for (const text of [...before.summary, ...after.summary]) assert.doesNotMatch(text, /[‒-―−]/);
    } finally {
      await ctx.admin.query(`DROP OWNED BY ${runtime}, ${worker}`).catch(() => {});
      await ctx.admin.query(`DROP ROLE IF EXISTS ${runtime}`);
      await ctx.admin.query(`DROP ROLE IF EXISTS ${worker}`);
    }
  }));

test('status before 027 reports the old kitchen; no tool command works before provisioning', () =>
  withEdgeSchema(async ({ pool, migrateWith }) => {
    await migrateWith({ below: '026', with026: true });
    const { scope } = await seedEdge(pool, { provisionFulfillment });
    const status = await kdsStatus(pool, { branchId: scope.branchId });
    assert.deepEqual([status.schema_ready, status.provisioned], [false, false]);
    await assert.rejects(
      setKdsLayoutEnabled(pool, { branchId: scope.branchId, enabled: false, reason: 'Проверка' }),
      kdsError('SCHEMA_NOT_READY'),
    );
    await migrateWith({ below: '026', with026: true, with027: true });
    assert.equal((await kdsStatus(pool, { branchId: scope.branchId })).provisioned, false);
    for (const call of [
      () =>
        setKdsLayoutEnabled(pool, { branchId: scope.branchId, enabled: false, reason: 'Проверка' }),
      () => buildKdsLayout(pool, { branchId: scope.branchId, tsv: CHEF_TSV }),
    ])
      await assert.rejects(call(), kdsError('NOT_PROVISIONED'));
  }));

test('command line: strict arguments, owner environment only, no network code', async () => {
  assert.deepEqual(parseKdsSwitchArgs(['status']), { command: 'status' });
  assert.deepEqual(parseKdsSwitchArgs(['layout-build', '--out', 'v.json', '--tsv', 'chef.tsv']), {
    command: 'layout-build',
    tsv: 'chef.tsv',
    out: 'v.json',
  });
  assert.deepEqual(parseKdsSwitchArgs(['enable', '--reason', '  Т9 учение ']), {
    command: 'enable',
    reason: 'Т9 учение',
  });
  for (const bad of [
    [],
    ['provision'],
    ['status', '--reason', 'abc'],
    ['enable'],
    ['enable', '--reason'],
    ['enable', '--reason', '--file'],
    ['disable', '--reason', 'abc', '--reason', 'abd'],
    ['layout-apply', '--file', 'v.json'],
    ['layout-build', '--tsv', 'chef.tsv'],
  ])
    assert.throws(() => parseKdsSwitchArgs(bad), kdsError('USAGE'), bad.join(' '));
  assert.throws(
    () => parseKdsSwitchArgs(['disable', '--reason', 'no']),
    kdsError('REASON_INVALID'),
  );

  const branch = '10000000-0000-4000-8000-000000000003';
  const owner = {
    APP_ENV: 'local',
    EDGE_DATABASE_URL: 'postgresql://pickchick_edge_owner:synthetic@127.0.0.1:55433/pickchick_edge',
    EDGE_BRANCH_ID: branch,
  };
  assert.equal(kdsSwitchConfig(owner).branchId, branch);
  assert.throws(
    () =>
      kdsSwitchConfig({
        ...owner,
        EDGE_DATABASE_URL:
          'postgresql://pickchick_edge_runtime:synthetic@127.0.0.1:55433/pickchick_edge',
      }),
    kdsError('OWNER_REQUIRED'),
  );
  assert.throws(() => kdsSwitchConfig({ ...owner, APP_ENV: 'test' }), kdsError('OWNER_REQUIRED'));

  const run = (args, env) =>
    promisify(execFile)(process.execPath, [tool, ...args], {
      env: { PATH: process.env.PATH, ...env },
    }).then(
      () => ({ code: 0 }),
      (error) => ({ code: error.code, stderr: JSON.parse(error.stderr) }),
    );
  const usage = await run(['provision'], owner);
  assert.deepEqual([usage.code, usage.stderr.code], [1, 'USAGE']);
  const runtime = await run(['status'], {
    ...owner,
    EDGE_DATABASE_URL:
      'postgresql://pickchick_edge_runtime:synthetic@127.0.0.1:55433/pickchick_edge',
  });
  assert.deepEqual([runtime.code, runtime.stderr.code], [1, 'OWNER_REQUIRED']);
  // Refusals happen before any connection and never echo the connection string.
  assert.doesNotMatch(JSON.stringify(runtime.stderr), /synthetic|postgresql:/);

  const source = await readFile(tool, 'utf8');
  assert.doesNotMatch(source, /\bfetch\(|node:https?|node:net|node:dgram|WebSocket/);
});
