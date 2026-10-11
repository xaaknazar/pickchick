import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import {
  KitchenScreens,
  PAIRING_MAX_FAILURES,
  normalizePairingCode,
  provisionCloudKitchen,
} from '@pickchick/cloud-kitchen';
import {
  AvailabilityError,
  assertBranchItemsAvailable,
} from '../../packages/commerce-core/dist/index.js';
import { cloudKitchenGrants } from '../../infra/staging/cloud-kitchen-grants.mjs';
import { cloudKitchenScreenGrants } from '../../infra/staging/cloud-kitchen-screen-grants.mjs';
import { runScreenOwner, parseArgs } from '../../infra/staging/cloud-kitchen-screen-owner.mjs';

// Cloud 056 kitchen screens (ADR-0014 S4): pairing codes, screen keys, revocation, heartbeat.
const admin = createPool(loadConfig('api').databaseUrl);
after(() => admin.end());
const migrations = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));

async function withCloud(run) {
  const schema = `ck_screens_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const base = new URL(loadConfig('api').databaseUrl);
  const urlFor = (role) => {
    const url = new URL(base);
    url.searchParams.set('options', `-c search_path=${schema}${role ? ` -c role=${role}` : ''}`);
    return url.toString();
  };
  const pool = createPool(urlFor(), 12);
  const pools = [pool];
  try {
    await migrate(pool, migrations, 'cloud');
    const org = randomUUID(),
      legal = randomUUID(),
      branchId = randomUUID(),
      prep = randomUUID(),
      prep2 = randomUUID(),
      assembly = randomUUID();
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Screens synthetic')", [org]);
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
      [legal, org],
    );
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'CKS','Synthetic')",
      [branchId, org, legal],
    );
    await provisionCloudKitchen(pool, {
      branchId,
      stations: [
        { id: prep, kind: 'prep', name: 'Горячий цех' },
        { id: prep2, kind: 'prep', name: 'Фритюр' },
        { id: assembly, kind: 'assembly', name: 'Сборка' },
      ],
      routing: {
        version: 1,
        assemblyStationId: assembly,
        routes: [{ productId: 'burger', stationId: prep, kind: 'prep' }],
      },
    });
    const poolAs = (role) => {
      const p = createPool(urlFor(role), 4);
      pools.push(p);
      return p;
    };
    const screens = new KitchenScreens(pool);
    const create = (role, stationIds, name = 'Экран ' + role) =>
      screens.create({
        branchId,
        role,
        stationIds,
        name,
        actor: 'owner:synthetic',
        reason: 'Synthetic screen',
      });
    const code = (screenId) =>
      screens.issuePairingCode({
        branchId,
        screenId,
        actor: 'owner:synthetic',
        reason: 'Synthetic pairing',
      });
    const events = async (screenId) =>
      (
        await pool.query(
          'SELECT action FROM cloud_kitchen_screen_events WHERE screen_id=$1 ORDER BY created_at,action',
          [screenId],
        )
      ).rows.map((r) => r.action);
    await run({
      pool,
      schema,
      branchId,
      prep,
      prep2,
      assembly,
      screens,
      create,
      code,
      events,
      poolAs,
    });
  } finally {
    for (const p of pools) await p.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}
const forbidden = { code: 'FORBIDDEN' };
const wrongSecret = (pairing) => {
  const [selector, secret] = pairing.split('-');
  const other = secret[0] === '2' ? '3' : '2';
  return `${selector}-${other}${secret.slice(1)}`;
};

test('screens: stations must belong to the branch and match the role', () =>
  withCloud(async ({ create, prep, assembly, pool, branchId }) => {
    for (const [role, stations] of [
      ['prep', [assembly]],
      ['assembly', [prep]],
      ['prep', []],
      ['display', [prep]],
      ['prep', [prep, prep]],
      ['prep', [randomUUID()]],
    ])
      await assert.rejects(create(role, stations), { code: 'INVALID' }, role);
    const screen = await create('prep', [prep]);
    assert.equal(screen.paired, false);
    assert.equal(screen.generation, 0);
    // The guard holds without the module too: identity is immutable, rows are never deleted.
    for (const sql of [
      `UPDATE cloud_kitchen_screens SET station_ids='{}'::uuid[] WHERE id='${screen.screenId}'`,
      `UPDATE cloud_kitchen_screens SET role='assembly' WHERE id='${screen.screenId}'`,
      `DELETE FROM cloud_kitchen_screens WHERE id='${screen.screenId}'`,
      `INSERT INTO cloud_kitchen_screens(id,branch_id,role,station_ids,name,created_by,created_reason) VALUES(gen_random_uuid(),'${branchId}','assembly','{${prep}}','x','x','Synthetic')`,
    ])
      await assert.rejects(pool.query(sql), { code: '23514' }, sql);
  }));

test('pairing: code once, key works, replay refused, code never stored in clear', () =>
  withCloud(async ({ screens, create, code, prep, pool, events }) => {
    const screen = await create('prep', [prep]);
    const issued = await code(screen.screenId);
    assert.match(issued.pairingCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{6}$/);
    assert.ok(Date.parse(issued.expiresAt) - Date.now() <= 600_000);
    const stored = JSON.stringify(
      (await pool.query('SELECT * FROM cloud_kitchen_pairing_codes')).rows,
    );
    assert.doesNotMatch(stored, new RegExp(issued.pairingCode.split('-')[1]));
    // Typed by a person: lower case, spaces, O for 0.
    const typed = issued.pairingCode.toLowerCase().replace('-', ' ').replace(/0/g, 'o');
    assert.deepEqual(normalizePairingCode(typed), normalizePairingCode(issued.pairingCode));
    const paired = await screens.exchange({ pairingCode: typed });
    assert.match(paired.screenKey, /^pcks_[A-Za-z0-9_-]{43}$/);
    assert.equal(paired.screen.generation, 1);
    assert.equal(paired.screen.role, 'prep');
    const keyRow = JSON.stringify(
      (await pool.query('SELECT * FROM cloud_kitchen_screens WHERE id=$1', [screen.screenId])).rows,
    );
    assert.doesNotMatch(keyRow, new RegExp(paired.screenKey.slice(5)));
    const auth = await screens.authenticate(paired.screenKey);
    assert.deepEqual(auth.actor, {
      branchId: screen.branchId,
      deviceId: screen.screenId,
      stationIds: [prep],
      manager: false,
    });
    await assert.rejects(screens.exchange({ pairingCode: issued.pairingCode }), forbidden);
    await assert.rejects(
      screens.exchange({ pairingCode: issued.pairingCode, extra: 1 }),
      forbidden,
    );
    for (const key of [undefined, '', 'pcks_short', paired.screenKey + 'x', 'Bearer x'])
      await assert.rejects(screens.authenticate(key), forbidden, String(key));
    assert.deepEqual((await events(screen.screenId)).sort(), ['code_issued', 'created', 'paired']);
    // Used code cannot be reopened by SQL either.
    await assert.rejects(pool.query('UPDATE cloud_kitchen_pairing_codes SET used_at=NULL'), {
      code: '23514',
    });
  }));

test('pairing: five wrong secrets burn the code, then even the right one fails', () =>
  withCloud(async ({ screens, create, code, prep, pool, events }) => {
    const screen = await create('prep', [prep]);
    const issued = await code(screen.screenId);
    for (let i = 0; i < PAIRING_MAX_FAILURES; i++)
      await assert.rejects(
        screens.exchange({ pairingCode: wrongSecret(issued.pairingCode) }),
        forbidden,
      );
    const row = (
      await pool.query('SELECT failed_attempts,burned_at FROM cloud_kitchen_pairing_codes')
    ).rows[0];
    assert.equal(row.failed_attempts, PAIRING_MAX_FAILURES);
    assert.ok(row.burned_at);
    await assert.rejects(screens.exchange({ pairingCode: issued.pairingCode }), forbidden);
    assert.ok((await events(screen.screenId)).includes('code_burned'));
    // Four failures still let the right code through.
    const again = await code(screen.screenId);
    for (let i = 0; i < PAIRING_MAX_FAILURES - 1; i++)
      await assert.rejects(
        screens.exchange({ pairingCode: wrongSecret(again.pairingCode) }),
        forbidden,
      );
    assert.equal((await screens.exchange({ pairingCode: again.pairingCode })).screen.generation, 1);
  }));

test('pairing: an expired code is refused and burned; a new code replaces the open one', () =>
  withCloud(async ({ screens, create, code, prep, pool }) => {
    const screen = await create('prep', [prep]);
    const first = await code(screen.screenId);
    const second = await code(screen.screenId);
    await assert.rejects(screens.exchange({ pairingCode: first.pairingCode }), forbidden);
    // Age the open code past its 10 minutes (replica role skips the immutability trigger only).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL session_replication_role='replica'");
      await client.query(
        "UPDATE cloud_kitchen_pairing_codes SET issued_at=issued_at-interval '11 minutes',expires_at=expires_at-interval '11 minutes' WHERE used_at IS NULL AND burned_at IS NULL",
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await assert.rejects(screens.exchange({ pairingCode: second.pairingCode }), forbidden);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM cloud_kitchen_pairing_codes WHERE burned_at IS NOT NULL',
        )
      ).rows[0].n,
      2,
    );
    // The CHECK pins the TTL even for direct writes.
    await assert.rejects(
      pool.query(
        `INSERT INTO cloud_kitchen_pairing_codes(id,screen_id,branch_id,selector,salt,code_hash,issued_by,reason,expires_at)
         VALUES(gen_random_uuid(),$1,$2,'ABCD',repeat('a',32),repeat('b',64),'x','Synthetic',clock_timestamp()+interval '11 minutes')`,
        [screen.screenId, screen.branchId],
      ),
      { code: '23514' },
    );
  }));

test('rotation and revocation: old key stops at the new pairing, revoked key at once', () =>
  withCloud(async ({ screens, create, code, prep, pool, events, branchId }) => {
    const screen = await create('prep', [prep]);
    const first = await screens.exchange({
      pairingCode: (await code(screen.screenId)).pairingCode,
    });
    const rotation = await code(screen.screenId);
    // Until the new code is used the old key keeps working (no gap on the line).
    assert.equal((await screens.authenticate(first.screenKey)).generation, 1);
    const second = await screens.exchange({ pairingCode: rotation.pairingCode });
    assert.equal(second.screen.generation, 2);
    await assert.rejects(screens.authenticate(first.screenKey), forbidden);
    assert.equal((await screens.authenticate(second.screenKey)).generation, 2);
    const pending = await code(screen.screenId);
    const revoked = await screens.revoke({
      branchId,
      screenId: screen.screenId,
      actor: 'owner:synthetic',
      reason: 'Tablet lost',
    });
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.revokedReason, 'Tablet lost');
    await assert.rejects(screens.authenticate(second.screenKey), forbidden);
    await assert.rejects(screens.exchange({ pairingCode: pending.pairingCode }), forbidden);
    await assert.rejects(code(screen.screenId), { code: 'CONFLICT' });
    await assert.rejects(
      pool.query(
        'UPDATE cloud_kitchen_screens SET revoked_at=NULL,revoked_by=NULL,revoked_reason=NULL',
      ),
      { code: '23514' },
    );
    assert.deepEqual(
      (await events(screen.screenId)).filter((e) => e === 'revoked'),
      ['revoked'],
    );
    const other = await screens
      .revoke({
        branchId: randomUUID(),
        screenId: screen.screenId,
        actor: 'owner:synthetic',
        reason: 'Other branch',
      })
      .catch((e) => e);
    assert.equal(other.code, 'NOT_FOUND');
  }));

test('heartbeat: only feed polls of prep and assembly screens open the KITCHEN_OFFLINE gate', () =>
  withCloud(async ({ pool, screens, create, code, prep, prep2, assembly, branchId }) => {
    await pool.query('SELECT * FROM cloud_kitchen_set_mode($1,$2,$3,$4)', [
      branchId,
      'cloud',
      'synthetic',
      'Synthetic switch',
    ]);
    const pair = async (role, stations) => {
      const screen = await create(role, stations);
      return (await screens.exchange({ pairingCode: (await code(screen.screenId)).pairingCode }))
        .screenKey;
    };
    const cook = await pair('prep', [prep, prep2]),
      packer = await pair('assembly', [assembly]),
      board = await pair('display', []);
    const gate = () =>
      assertBranchItemsAvailable(pool, branchId, [{ productId: randomUUID(), selections: [] }]);
    const offline = (e) => e instanceof AvailabilityError && e.code === 'KITCHEN_OFFLINE';
    // No screen polled yet.
    await assert.rejects(gate(), offline);
    await screens.authenticate(cook);
    await screens.authenticate(packer);
    await screens.authenticate(board, { heartbeat: true });
    await assert.rejects(gate(), offline, 'reads without heartbeat do not count');
    await screens.authenticate(cook, { heartbeat: true });
    await assert.rejects(gate(), offline, 'prep without assembly');
    await screens.authenticate(packer, { heartbeat: true });
    await gate();
    const presence = (
      await pool.query(
        'SELECT station_id FROM cloud_kitchen_station_presence WHERE branch_id=$1 ORDER BY station_id',
        [branchId],
      )
    ).rows.map((r) => r.station_id);
    assert.deepEqual(presence, [prep, prep2, assembly].sort());
    // A poll older than 30 s closes the gate again.
    await pool.query(
      "UPDATE cloud_kitchen_station_presence SET seen_at=clock_timestamp()-interval '31 seconds' WHERE station_id=$1",
      [assembly],
    );
    await assert.rejects(gate(), offline);
  }));

test('owner operator script and restricted runtime role with the 054 + 056 grants', () =>
  withCloud(async ({ pool, schema, branchId, prep, assembly, poolAs, events }) => {
    assert.throws(() => parseArgs(['create', '--branch', branchId]));
    assert.throws(() => parseArgs(['drop', '--branch', branchId]));
    assert.throws(() => parseArgs(['revoke', '--branch', branchId, '--operator', 'x']));
    const created = await runScreenOwner(pool, [
      'create',
      '--branch',
      branchId,
      '--role',
      'assembly',
      '--station',
      assembly,
      '--name',
      'Сборка 1',
      '--operator',
      'owner-synthetic',
      '--reason',
      'Owner bootstrap',
    ]);
    assert.match(created.pairingCode, /^[0-9A-Z]{4}-[0-9A-Z]{6}$/);
    assert.equal(
      (await pool.query('SELECT created_by FROM cloud_kitchen_screens')).rows[0].created_by,
      'owner:owner-synthetic',
    );
    const role = 'kitchen_screens_' + randomUUID().replaceAll('-', '');
    await pool.query(`CREATE ROLE ${role} NOLOGIN`);
    try {
      await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await pool.query(cloudKitchenGrants(role, true));
      await pool.query(cloudKitchenScreenGrants(role, true));
      const runtime = new KitchenScreens(poolAs(role));
      const paired = await runtime.exchange({ pairingCode: created.pairingCode });
      await runtime.authenticate(paired.screenKey, { heartbeat: true });
      const second = await runtime.create({
        branchId,
        role: 'prep',
        stationIds: [prep],
        name: 'Горячий',
        actor: 'bo:synthetic',
        reason: 'Runtime create',
      });
      await runtime.issuePairingCode({
        branchId,
        screenId: second.screenId,
        actor: 'bo:synthetic',
        reason: 'Runtime code',
      });
      await runtime.revoke({
        branchId,
        screenId: second.screenId,
        actor: 'bo:synthetic',
        reason: 'Runtime revoke',
      });
      assert.deepEqual((await events(second.screenId)).sort(), [
        'code_issued',
        'created',
        'revoked',
      ]);
      const runtimePool = poolAs(role);
      for (const sql of [
        'DELETE FROM cloud_kitchen_screens',
        'DELETE FROM cloud_kitchen_pairing_codes',
        'UPDATE cloud_kitchen_screen_events SET actor=actor',
        "UPDATE cloud_kitchen_screens SET station_ids='{}'::uuid[]",
        "UPDATE cloud_kitchen_pairing_codes SET code_hash=repeat('0',64)",
        'TRUNCATE cloud_kitchen_screen_events',
      ])
        await assert.rejects(runtimePool.query(sql), { code: '42501' }, sql);
    } finally {
      await pool.query(`DROP OWNED BY ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  }));
