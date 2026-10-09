import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { KioskEnrollment } from '@pickchick/commerce-core';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import {
  DEVICE_REGISTRY_ACL,
  deviceRegistryGrants,
} from '../../../infra/staging/device-registry-grants.mjs';
import { DeviceRegistry, PAIRING_ISSUE_LIMIT } from '../dist/device-registry.js';
import { Backoffice } from '../dist/index.js';

// Synthetic localhost databases only; no device, bank or private server env is touched.
process.env.APP_ENV ??= 'test';
process.env.CLOUD_DATABASE_URL ??=
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
process.env.EDGE_DATABASE_URL ??=
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55433/pickchick_edge';
process.env.EDGE_BRANCH_ID ??= randomUUID();
process.env.REDIS_URL ??= 'redis://127.0.0.1:56379/0';
for (const name of ['CLOUD_DATABASE_URL', 'EDGE_DATABASE_URL'])
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env[name]).hostname));

const sha = (v) => createHash('sha256').update(v).digest('hex');
const rejects = (code, reason) => (e) =>
  e.code === code && (reason === undefined || e.reason === reason);
const NEW_TABLES = ['device_pairing_codes', 'device_events'];

/**
 * Runs against a restricted runtime role holding only backofficeGrants, deviceRegistryGrants and
 * the kiosk release's alias-exchange columns, like the staging API.
 */
async function fixture(run) {
  await withSyncDatabases(async (f) => {
    const owner = f.cloud.pool,
      admin = f.cloud.admin,
      schema = f.cloud.schema;
    const role = 'dev_runtime_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    let pool;
    try {
      await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await owner.query(backofficeGrants(role, true));
      await owner.query(deviceRegistryGrants(role, true));
      await owner.query(
        `GRANT UPDATE(request_id,failed_attempts,locked_until) ON kiosk_enrollment_aliases TO ${role}`,
      );
      const url = new URL(f.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
      pool = createPool(url.toString());
      const encryptionKey = randomBytes(32),
        pepper = randomBytes(32);
      const kiosk = { encryptionKey, organizationId: f.org, branchId: f.branch };
      const registry = new DeviceRegistry(pool, { enabled: true, pepper, kiosk });
      const enrollment = new KioskEnrollment(pool, kiosk);
      async function manager(grant = 'manager', name = 'Synthetic ' + grant) {
        const id = randomUUID(),
          token = randomBytes(32).toString('hex');
        await owner.query(
          'INSERT INTO catalog_managers(id,organization_id,name,token_hash) VALUES($1,$2,$3,$4)',
          [id, f.org, name, sha(token)],
        );
        await owner.query(
          'INSERT INTO catalog_manager_branches(actor_id,organization_id,branch_id) VALUES($1,$2,$3)',
          [id, f.org, f.branch],
        );
        await owner.query(
          'INSERT INTO bo_access_grants(actor_id,branch_id,role) VALUES($1,$2,$3)',
          [id, f.branch, grant],
        );
        return { id, token };
      }
      const req = (extra = {}) => ({
        request_id: randomUUID(),
        reason: 'Синтетическая проверка устройств',
        ...extra,
      });
      await run({ ...f, owner, pool, role, registry, enrollment, kiosk, pepper, manager, req });
    } finally {
      await pool?.end();
      await owner.query(`DROP OWNED BY ${role}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    }
  });
}

test('kiosk pairing from the back office: one-time alias, exchange, list, revoke and journal', () =>
  fixture(async (f) => {
    const { token, id: actor } = await f.manager();
    const listed = await f.registry.list(token, f.branch);
    assert.equal(listed.kiosk_pairing, 'ready');
    const edge = listed.devices.find((d) => d.id === f.device);
    assert.equal(edge.kind, 'edge');
    assert.equal(edge.role, 'edge');
    assert.equal(edge.revocable, false);

    const created = await f.registry.create(
      token,
      f.branch,
      f.req({ role: 'kiosk', name: 'Киоск у входа' }),
    );
    assert.equal(created.device.status, 'pending');
    assert.match(created.pairing.login, /^kiosk-/);
    assert.equal(created.pairing.password.length, 12);
    const expires = Date.parse(created.pairing.expires_at) - Date.now();
    assert.ok(expires > 29 * 60_000 && expires <= 30 * 60_000);
    // Nothing persisted holds the plaintext password or device key.
    const stored = (
      await f.owner.query(
        `SELECT (SELECT row_to_json(c)::text FROM device_pairing_codes c WHERE device_id=$1) code,
          (SELECT result::text FROM bo_commands WHERE actor_id=$2) cmd,
          (SELECT string_agg(after_value::text,'') FROM bo_audit WHERE actor_id=$2) audit`,
        [created.device.id, actor],
      )
    ).rows[0];
    for (const text of Object.values(stored)) assert.ok(!text.includes(created.pairing.password));
    assert.match(stored.cmd, /"secret_issued": ?true/);

    const pending = (await f.registry.list(token, f.branch)).devices.find(
      (d) => d.id === created.device.id,
    );
    assert.equal(pending.status, 'pending');
    assert.equal(pending.pairing.state, 'open');
    assert.equal(pending.revocable, true);

    const exchanged = await f.enrollment.exchange({
      login: created.pairing.login,
      password: created.pairing.password,
      requestId: randomUUID(),
    });
    const kioskRow = (
      await f.owner.query('SELECT id,token_hash,active FROM kiosk_devices WHERE id=$1', [
        exchanged.deviceId,
      ])
    ).rows[0];
    assert.equal(kioskRow.token_hash, sha(exchanged.key));
    const active = (await f.registry.list(token, f.branch)).devices.find(
      (d) => d.id === created.device.id,
    );
    assert.equal(active.status, 'active');
    assert.equal(active.pairing.state, 'consumed');
    // A paired kiosk never gets a second code (it would clone its key onto another iPad).
    await assert.rejects(
      f.registry.issueCode(token, f.branch, created.device.id, f.req()),
      rejects('CONFLICT', 'DEVICE_NOT_PENDING'),
    );
    await f.registry.rename(token, f.branch, created.device.id, f.req({ name: 'Киоск 1' }));
    await assert.rejects(
      f.registry.revoke(
        token,
        f.branch,
        created.device.id,
        f.req({ confirm_name: 'Киоск у входа' }),
      ),
      rejects('INVALID_REQUEST', 'CONFIRM_NAME_MISMATCH'),
    );
    const revoked = await f.registry.revoke(
      token,
      f.branch,
      created.device.id,
      f.req({ confirm_name: 'Киоск 1' }),
    );
    assert.equal(revoked.device.status, 'revoked');
    assert.equal(
      (await f.owner.query('SELECT active FROM kiosk_devices WHERE id=$1', [exchanged.deviceId]))
        .rows[0].active,
      false,
    );
    const row = (
      await f.owner.query('SELECT status,revoked_by,revoked_at FROM devices WHERE id=$1', [
        created.device.id,
      ])
    ).rows[0];
    assert.equal(row.status, 'revoked');
    assert.equal(row.revoked_by, actor);
    assert.ok(row.revoked_at);
    await assert.rejects(
      f.registry.revoke(token, f.branch, created.device.id, f.req({ confirm_name: 'Киоск 1' })),
      rejects('CONFLICT', 'DEVICE_REVOKED'),
    );
    const journal = await f.registry.events(token, f.branch, created.device.id);
    assert.deepEqual(journal.events.map((e) => e.action).reverse(), [
      'created',
      'code_issued',
      'paired',
      'renamed',
      'revoked',
    ]);
    for (const e of journal.events)
      assert.equal(e.actor_name, e.actor_kind === 'backoffice' ? 'Synthetic manager' : null);
    assert.deepEqual(
      (
        await f.owner.query(
          'SELECT state,consumed_request_id IS NOT NULL used FROM device_pairing_codes WHERE device_id=$1',
          [created.device.id],
        )
      ).rows,
      [{ state: 'consumed', used: true }],
    );
    const audit = (
      await f.owner.query('SELECT action FROM bo_audit WHERE actor_id=$1 ORDER BY created_at', [
        actor,
      ])
    ).rows.map((r) => r.action);
    assert.deepEqual(audit, ['device_create', 'device_rename', 'device_revoke']);
  }));

test('reissue and cancel close the previous alias; replays are idempotent without the secret', () =>
  fixture(async (f) => {
    const { token } = await f.manager();
    const request = f.req({ role: 'kiosk', name: 'Киоск 2' });
    const first = await f.registry.create(token, f.branch, request);
    // The code was shown once; a replay cannot return it and creates nothing new.
    await assert.rejects(
      f.registry.create(token, f.branch, request),
      rejects('CONFLICT', 'CODE_ALREADY_ISSUED'),
    );
    await assert.rejects(
      f.registry.create(token, f.branch, { ...request, name: 'Другое имя' }),
      rejects('CONFLICT'),
    );
    assert.equal(
      Number(
        (await f.owner.query("SELECT count(*) FROM devices WHERE kind='kiosk'")).rows[0].count,
      ),
      1,
    );
    const second = await f.registry.issueCode(token, f.branch, first.device.id, f.req());
    assert.notEqual(second.pairing.login, first.pairing.login);
    await assert.rejects(
      f.enrollment.exchange({
        login: first.pairing.login,
        password: first.pairing.password,
        requestId: randomUUID(),
      }),
    );
    const cancelRequest = f.req();
    const cancelled = await f.registry.cancelCode(
      token,
      f.branch,
      first.device.id,
      second.pairing.id,
      cancelRequest,
    );
    assert.equal(cancelled.code.state, 'cancelled');
    assert.deepEqual(
      await f.registry.cancelCode(
        token,
        f.branch,
        first.device.id,
        second.pairing.id,
        cancelRequest,
      ),
      cancelled,
    );
    await assert.rejects(
      f.registry.cancelCode(token, f.branch, first.device.id, second.pairing.id, f.req()),
      rejects('CONFLICT', 'CODE_NOT_OPEN'),
    );
    await assert.rejects(
      f.enrollment.exchange({
        login: second.pairing.login,
        password: second.pairing.password,
        requestId: randomUUID(),
      }),
    );
    // Still pending: a new code works and pairs with the same sealed kiosk key.
    const third = await f.registry.issueCode(token, f.branch, first.device.id, f.req());
    const paired = await f.enrollment.exchange({
      login: third.pairing.login,
      password: third.pairing.password,
      requestId: randomUUID(),
    });
    const kioskId = (
      await f.owner.query('SELECT kiosk_device_id FROM devices WHERE id=$1', [first.device.id])
    ).rows[0].kiosk_device_id;
    assert.equal(paired.deviceId, kioskId);
    const states = (
      await f.owner.query(
        'SELECT state FROM device_pairing_codes WHERE device_id=$1 ORDER BY created_at',
        [first.device.id],
      )
    ).rows.map((r) => r.state);
    assert.deepEqual(states, ['cancelled', 'cancelled', 'open']);
    const renameRequest = f.req({ name: 'Киоск 2Б' });
    const renamed = await f.registry.rename(token, f.branch, first.device.id, renameRequest);
    assert.deepEqual(
      await f.registry.rename(token, f.branch, first.device.id, renameRequest),
      renamed,
    );
  }));

test('edge cannot be revoked by the registry nor the legacy command; kiosk uses the registry', () =>
  fixture(async (f) => {
    const { token } = await f.manager();
    await assert.rejects(
      f.registry.revoke(token, f.branch, f.device, f.req({ confirm_name: 'Synthetic' })),
      rejects('CONFLICT', 'EDGE_REVOKE_REQUIRES_REPLACEMENT_PROTOCOL'),
    );
    const legacy = new Backoffice(f.pool, true);
    await assert.rejects(
      legacy.command(token, f.branch, {
        request_id: randomUUID(),
        reason: 'Синтетическая проверка',
        command: { type: 'revoke_device', id: f.device },
      }),
      rejects('CONFLICT', 'EDGE_REVOKE_REQUIRES_REPLACEMENT_PROTOCOL'),
    );
    const kiosk = await f.registry.create(token, f.branch, f.req({ role: 'kiosk', name: 'К' }));
    await assert.rejects(
      legacy.command(token, f.branch, {
        request_id: randomUUID(),
        reason: 'Синтетическая проверка',
        command: { type: 'revoke_device', id: kiosk.device.id },
      }),
      rejects('CONFLICT', 'KIOSK_REVOKE_USES_REGISTRY'),
    );
    // A non-edge, non-kiosk device is still revocable by the legacy command with audit.
    const display = randomUUID();
    await f.owner.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES($1,$2,$3,'display','Табло')",
      [display, f.branch, f.org],
    );
    await legacy.command(token, f.branch, {
      request_id: randomUUID(),
      reason: 'Синтетическая проверка',
      command: { type: 'revoke_device', id: display },
    });
    const audit = (
      await f.owner.query("SELECT before_value FROM bo_audit WHERE action='revoke_device'")
    ).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].before_value.kind, 'display');
    const states = (
      await f.owner.query('SELECT id,status,role FROM devices WHERE id=ANY($1)', [
        [f.device, display],
      ])
    ).rows;
    assert.deepEqual(Object.fromEntries(states.map((r) => [r.id, [r.status, r.role]])), {
      [f.device]: ['pending', 'edge'],
      [display]: ['revoked', 'board'],
    });
  }));

test('access, configuration and limits: analyst reads only, other branches and roles refuse', () =>
  fixture(async (f) => {
    const analyst = await f.manager('analyst');
    const { token } = await f.manager();
    assert.equal((await f.registry.list(analyst.token, f.branch)).role, 'analyst');
    await assert.rejects(
      f.registry.create(analyst.token, f.branch, f.req({ role: 'kiosk', name: 'X' })),
      rejects('FORBIDDEN'),
    );
    await assert.rejects(
      f.registry.list(randomBytes(32).toString('hex'), f.branch),
      rejects('UNAUTHORIZED'),
    );
    await assert.rejects(f.registry.list(token, randomUUID()), rejects('FORBIDDEN'));
    await assert.rejects(
      new DeviceRegistry(f.pool, { enabled: false, pepper: f.pepper, kiosk: f.kiosk }).list(
        token,
        f.branch,
      ),
      rejects('SERVICE_UNAVAILABLE'),
    );
    const other = new DeviceRegistry(f.pool, {
      enabled: true,
      pepper: f.pepper,
      kiosk: { ...f.kiosk, branchId: randomUUID() },
    });
    assert.equal((await other.list(token, f.branch)).kiosk_pairing, 'not_configured');
    await assert.rejects(
      other.create(token, f.branch, f.req({ role: 'kiosk', name: 'X' })),
      rejects('NOT_READY', 'KIOSK_NOT_CONFIGURED'),
    );
    await assert.rejects(
      new DeviceRegistry(f.pool, { enabled: true, pepper: null, kiosk: f.kiosk }).create(
        token,
        f.branch,
        f.req({ role: 'kiosk', name: 'X' }),
      ),
      rejects('NOT_READY', 'PAIRING_NOT_CONFIGURED'),
    );
    for (const role of ['board', 'kitchen_prep', 'pos', 'edge'])
      await assert.rejects(
        f.registry.create(token, f.branch, f.req({ role, name: 'X' })),
        rejects('NOT_READY', 'ROLE_PAIRING_NOT_READY'),
      );
    for (const bad of [{ role: 'printer' }, { name: '' }, { reason: 'x' }, { extra: 1 }])
      await assert.rejects(
        f.registry.create(token, f.branch, { ...f.req({ role: 'kiosk', name: 'X' }), ...bad }),
        rejects('INVALID_REQUEST'),
      );
    const device = await f.registry.create(token, f.branch, f.req({ role: 'kiosk', name: 'Л' }));
    for (let i = 1; i < PAIRING_ISSUE_LIMIT; i++)
      await f.registry.issueCode(token, f.branch, device.device.id, f.req());
    await assert.rejects(
      f.registry.issueCode(token, f.branch, device.device.id, f.req()),
      rejects('CONFLICT', 'PAIRING_RATE_LIMITED'),
    );
  }));

test('a kiosk provisioned before cloud051 is listed and adopted on rename or revoke', () =>
  fixture(async (f) => {
    const { token } = await f.manager();
    const kioskId = randomUUID();
    await f.owner.query(
      'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
      [kioskId, f.org, f.branch, sha(randomBytes(32).toString('hex'))],
    );
    const shown = (await f.registry.list(token, f.branch)).devices.find((d) => d.id === kioskId);
    assert.equal(shown.registered, false);
    assert.equal(shown.status, 'active');
    assert.equal(shown.revocable, true);
    await f.registry.revoke(token, f.branch, kioskId, f.req({ confirm_name: shown.name }));
    const after = (await f.registry.list(token, f.branch)).devices.filter(
      (d) => d.id === kioskId || d.name === shown.name,
    );
    assert.equal(after.length, 1);
    assert.equal(after[0].registered, true);
    assert.equal(after[0].status, 'revoked');
    assert.equal(
      (await f.owner.query('SELECT active FROM kiosk_devices WHERE id=$1', [kioskId])).rows[0]
        .active,
      false,
    );
    const journal = await f.registry.events(token, f.branch, kioskId);
    assert.deepEqual(journal.events.map((e) => e.action).reverse(), ['created', 'revoked']);
  }));

test('migration 051 guards: append-only journal, immutable codes, lifetimes and role checks', () =>
  fixture(async (f) => {
    const { token, id: actor } = await f.manager();
    const created = await f.registry.create(token, f.branch, f.req({ role: 'kiosk', name: 'М' }));
    const sql = (text, args = []) => f.owner.query(text, args);
    const code = created.pairing.id;
    const invalid = (e) => e.code === '23514';
    await assert.rejects(sql('UPDATE device_events SET reason=$1', ['подмена']), invalid);
    await assert.rejects(sql('DELETE FROM device_events'), invalid);
    await assert.rejects(sql('DELETE FROM device_pairing_codes WHERE id=$1', [code]), invalid);
    await assert.rejects(
      sql('UPDATE device_pairing_codes SET code_hash=$2 WHERE id=$1', [code, randomBytes(32)]),
      invalid,
    );
    await assert.rejects(
      sql("UPDATE device_pairing_codes SET expires_at=expires_at+interval '1 minute' WHERE id=$1", [
        code,
      ]),
      invalid,
    );
    await sql("UPDATE device_pairing_codes SET state='cancelled' WHERE id=$1", [code]);
    await assert.rejects(
      sql("UPDATE device_pairing_codes SET state='open' WHERE id=$1", [code]),
      invalid,
    );
    const insert = (purpose, minutes) =>
      sql(
        `INSERT INTO device_pairing_codes(id,organization_id,branch_id,device_id,purpose,code_hash,created_by,expires_at,request_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+make_interval(mins=>$8),$9)`,
        [
          randomUUID(),
          f.org,
          f.branch,
          created.device.id,
          purpose,
          randomBytes(32),
          actor,
          minutes,
          randomUUID(),
        ],
      );
    await assert.rejects(insert('kiosk', 31), invalid);
    await assert.rejects(insert('edge_terminal', 16), invalid);
    await insert('kiosk', 5);
    // At most one open code per device.
    await assert.rejects(insert('kiosk', 5), (e) => e.code === '23505');
    await assert.rejects(
      sql("UPDATE devices SET role='board' WHERE id=$1", [created.device.id]),
      invalid,
    );
    await assert.rejects(
      sql('UPDATE devices SET kiosk_device_id=$2 WHERE id=$1', [f.device, randomUUID()]),
      (e) => ['23503', '23514'].includes(e.code),
    );
    await assert.rejects(
      sql("UPDATE devices SET revoked_at=clock_timestamp() WHERE id=$1 AND status<>'revoked'", [
        f.device,
      ]),
      invalid,
    );
    const kitchen = randomUUID();
    await sql(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES($1,$2,$3,'kitchen','Кухня')",
      [kitchen, f.branch, f.org],
    );
    assert.equal(
      (await sql('SELECT role FROM devices WHERE id=$1', [kitchen])).rows[0].role,
      'kitchen_prep',
    );
  }));

test('a fresh role receives exactly the documented device registry ACL', () =>
  fixture(async (f) => {
    const role = 'dev_acl_' + randomUUID().replaceAll('-', '');
    await f.cloud.admin.query(`CREATE ROLE ${role} NOLOGIN`);
    try {
      await f.owner.query(deviceRegistryGrants(role, true));
      const tables = [...new Set(DEVICE_REGISTRY_ACL.map(([t]) => t))];
      const acl = async () =>
        (
          await f.owner.query(
            `SELECT c.relname,NULL::text col,a.privilege_type FROM pg_class c,aclexplode(c.relacl) a
              WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($2) AND a.grantee=to_regrole($1)
             UNION ALL
             SELECT c.relname,t.attname::text,a.privilege_type FROM pg_class c JOIN pg_attribute t ON t.attrelid=c.oid,aclexplode(t.attacl) a
              WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($2) AND a.grantee=to_regrole($1)`,
            [role, tables],
          )
        ).rows
          .map((r) => [r.relname, r.col, r.privilege_type].join('|'))
          .sort();
      assert.deepEqual(await acl(), DEVICE_REGISTRY_ACL.map((r) => r.join('|')).sort());
      await f.owner.query(deviceRegistryGrants(role, false));
      // Disabling leaves only what other helpers own (here: nothing beyond those shared rows).
      assert.deepEqual(
        await acl(),
        [
          'devices|status|UPDATE',
          'device_credentials|device_id|SELECT',
          'device_credentials|expires_at|SELECT',
          'kiosk_devices||SELECT',
          'kiosk_enrollment_aliases||SELECT',
          'kiosk_sessions||SELECT',
        ].sort(),
      );
      for (const table of NEW_TABLES)
        assert.ok(!(await acl()).some((r) => r.startsWith(table + '|')));
    } finally {
      await f.owner.query(
        `REVOKE ALL ON device_pairing_codes,device_events,devices,kiosk_devices,kiosk_enrollment_aliases,kiosk_sessions,device_credentials FROM ${role}`,
      );
      await f.cloud.admin.query(`DROP ROLE ${role}`);
    }
  }));
