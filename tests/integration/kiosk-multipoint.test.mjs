// ADR-0019: an iPad kiosk on any point. A manager switches «Киоски на этой точке» on in
// «Устройства», issues «Подключить киоск» for that point, and the kiosk's terminal payments reach
// that point's kitchen exactly as on the env point. Real PostgreSQL, the real commerce core and
// back-office registry, the restricted API role.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { provisionDevice } from '@pickchick/menu-sync';
import { withSyncDatabases } from '../helpers/sync.mjs';
import {
  KioskCheckout,
  KioskEnrollment,
  KioskSessions,
  kioskMultiBranchEnabled,
} from '../../packages/commerce-core/dist/index.js';
import { publishCatalog } from '../../packages/commerce-core/tests/catalog-fixture.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import { DeviceRegistry } from '../../packages/backoffice-core/dist/device-registry.js';
import { kioskPairingOptions } from '../../services/api/dist/device-registry-controller.js';
import {
  kioskBranchSettingsGrants,
  kioskBranchSettingsPrivileges,
} from '../../infra/staging/kiosk-branch-settings-grants.mjs';

const NOW = () => new Date('2026-11-16T10:00:00Z');
const HOURS = { openingTime: '10:00', closingTime: '00:00', timeZone: 'Asia/Almaty' };
const code = (expected) => (error) => error.code === expected;

async function fixture(run) {
  await withSyncDatabases(async (f) => {
    const pool = f.cloud.pool,
      qrAccount = randomUUID(),
      posAccount = randomUUID(),
      second = randomUUID(),
      secondEdge = randomUUID();
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'SYNC2','Synthetic second point')",
      [second, f.org, f.legal],
    );
    await pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES ($1,$2,$3,'edge','Synthetic second')",
      [secondEdge, second, f.org],
    );
    // Each point's kitchen: its own point server binding and fresh availability.
    for (const [branch, device] of [
      [f.branch, f.device],
      [second, secondEdge],
    ]) {
      await provisionDevice(pool, device);
      await pool.query(
        'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
        [branch, f.org, device, randomUUID()],
      );
      await pool.query(
        "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}')",
        [branch, device],
      );
      await publishCatalog({ pool, scope: { organizationId: f.org, branchId: branch } });
    }
    for (const [id, provider] of [
      [qrAccount, 'kaspi-qr'],
      [posAccount, 'kaspi-pos'],
    ])
      await pool.query(
        "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1::uuid,$2,$3,'payment',$4,$1::text,true,$5)",
        [id, f.org, f.branch, provider, f.legal],
      );
    const manager = await provisionCatalogManager(pool, {
      organization_id: f.org,
      name: 'Synthetic chain manager',
      branch_ids: [f.branch, second],
    });
    for (const branch of [f.branch, second])
      await grantBackoffice(pool, manager.actor_id, branch, 'manager');
    const encryptionKey = randomBytes(32);
    const options = {
      organizationId: f.org,
      branchId: f.branch,
      paymentAccountId: qrAccount,
      paymentMethod: 'kaspi_qr',
      fiscalPolicy: 'deferred_pilot',
      approvalReference: 'Synthetic kiosk multipoint only',
      taxCode: 'PENDING_PILOT',
      maxOrderMinor: '50000',
      hours: HOURS,
    };
    const pairing = (multiBranch = true) => ({
      encryptionKey,
      organizationId: f.org,
      branchId: f.branch,
      multiBranch,
      terminalAccountId: posAccount,
    });
    const piiKey = randomBytes(32);
    const build = (multiBranch = true, db = pool) => {
      const sessions = new KioskSessions(db, { piiKey });
      return {
        sessions,
        checkout: new KioskCheckout(
          db,
          options,
          sessions,
          NOW,
          { accountId: posAccount },
          multiBranch,
        ),
        registry: new DeviceRegistry(db, true, true, pairing(multiBranch)),
        enrollment: new KioskEnrollment(db, {
          encryptionKey,
          organizationId: f.org,
          branchId: f.branch,
          multiBranch,
        }),
      };
    };
    const body = (extra = {}) => ({
      request_id: randomUUID(),
      reason: 'Новая точка сети',
      ...extra,
    });
    /** «Подключить киоск» for a point, then the iPad's exchange: the kiosk's credentials. */
    const enroll = async (parts, branch) => {
      const issued = await parts.registry.issueKiosk(manager.token, branch, {
        request_id: randomUUID(),
        name: 'Киоск у входа',
        reason: 'Новый iPad на точке',
      });
      const credentials = await parts.enrollment.exchange({
        login: issued.login,
        password: issued.password,
        requestId: randomUUID(),
      });
      return { id: credentials.deviceId, key: credentials.key };
    };
    const guest = async (parts, device) => {
      const token = randomBytes(32).toString('hex');
      await parts.sessions.start(device.id, device.key, { sessionId: randomUUID(), token });
      return parts.sessions.authenticate(device.id, device.key, token, { allowExpired: true });
    };
    const order = async (parts, who) => {
      const quote = await parts.checkout.quote(who, {
        key: randomUUID(),
        branchId: who.branchId,
        catalog_version: 1,
        serviceMode: 'takeaway',
        items: [
          {
            productId: 'BURGER',
            quantity: 1,
            selections: [{ group_id: 'extra', option_id: 'sauce', quantity: 1 }],
          },
        ],
      });
      return parts.checkout.create(who, { key: randomUUID(), quoteId: quote.quoteId });
    };
    await run({
      ...f,
      pool,
      second,
      secondEdge,
      qrAccount,
      posAccount,
      manager,
      options,
      build,
      body,
      enroll,
      guest,
      order,
    });
  });
}

test('flag: off, true, and anything else stops startup', () => {
  assert.equal(kioskMultiBranchEnabled({}), false);
  assert.equal(kioskMultiBranchEnabled({ KIOSK_MULTI_BRANCH_ENABLED: 'false' }), false);
  assert.equal(kioskMultiBranchEnabled({ KIOSK_MULTI_BRANCH_ENABLED: 'true' }), true);
  for (const flag of ['1', 'TRUE', 'yes', ''])
    assert.throws(() => kioskMultiBranchEnabled({ KIOSK_MULTI_BRANCH_ENABLED: flag }));
  const env = {
    BACKOFFICE_KIOSK_PAIRING_ENABLED: 'true',
    KIOSK_CHECKOUT_ENABLED: 'true',
    KIOSK_CHECKOUT_ORGANIZATION_ID: randomUUID(),
    KIOSK_CHECKOUT_BRANCH_ID: randomUUID(),
    KASPI_REMOTE_ACCOUNT_ID: randomUUID(),
    KIOSK_CHECKOUT_FISCAL_POLICY: 'deferred_pilot',
    CUSTOMER_KASPI_OPENING_TIME: '10:00',
    CUSTOMER_KASPI_CLOSING_TIME: '00:00',
    CUSTOMER_KASPI_TIMEZONE: 'Asia/Almaty',
    KIOSK_CHECKOUT_APPROVAL_REFERENCE: 'Synthetic approval',
    KIOSK_CHECKOUT_TAX_CODE: 'VAT0',
    KIOSK_ENROLLMENT_KEY: randomBytes(32).toString('hex'),
  };
  assert.equal(kioskPairingOptions(env, true).multiBranch, false);
  const account = randomUUID();
  const on = kioskPairingOptions(
    {
      ...env,
      KIOSK_MULTI_BRANCH_ENABLED: 'true',
      KIOSK_KASPI_TERMINAL_ENABLED: 'true',
      KIOSK_KASPI_TERMINAL_ACCOUNT_ID: account,
    },
    true,
  );
  assert.equal(on.multiBranch, true);
  assert.equal(on.terminalAccountId, account);
  // A broken flag keeps «Устройства» up: kiosk pairing simply stays off.
  assert.equal(kioskPairingOptions({ ...env, KIOSK_MULTI_BRANCH_ENABLED: 'on' }, true), null);
});

test('another point: switched on in the back office, paired, paid on its terminal, to its kitchen', () =>
  fixture(async (f) => {
    const parts = f.build();
    // Before: the point is listed as off and «Подключить киоск» is not offered there.
    const before = await parts.registry.read(f.manager.token, f.second);
    assert.equal(before.kiosk_pairing_enabled, false);
    assert.deepEqual(before.kiosk_branch, {
      primary: false,
      enabled: false,
      version: 0,
      payment_account: null,
    });
    await assert.rejects(
      parts.registry.issueKiosk(f.manager.token, f.second, {
        request_id: randomUUID(),
        name: 'Киоск',
        reason: 'Новый iPad',
      }),
      { code: 'CONFLICT', reason: 'KIOSK_BRANCH_NOT_SERVED' },
    );
    // The env point is always on and is not switched here.
    const primary = await parts.registry.read(f.manager.token, f.branch);
    assert.equal(primary.kiosk_branch.primary, true);
    assert.equal(primary.kiosk_branch.payment_account.id, f.posAccount);
    await assert.rejects(
      parts.registry.kioskBranch(
        f.manager.token,
        f.branch,
        f.body({ enabled: false, expected_version: 0 }),
      ),
      { code: 'CONFLICT', reason: 'KIOSK_BRANCH_PRIMARY' },
    );

    // Switch on: the point gets its own 'kaspi-pos' account of its legal entity.
    const request = f.body({ enabled: true, expected_version: 0 });
    const on = await parts.registry.kioskBranch(f.manager.token, f.second, request);
    assert.equal(on.enabled, true);
    assert.equal(on.version, 1);
    assert.equal(on.payment_account.enabled, true);
    assert.equal(on.payment_account.reference, 'kiosk-terminal:' + f.second);
    const account = (
      await f.pool.query('SELECT * FROM commerce_provider_accounts WHERE id=$1', [
        on.payment_account.id,
      ])
    ).rows[0];
    assert.equal(account.branch_id, f.second);
    assert.equal(account.provider, 'kaspi-pos');
    assert.equal(account.kind, 'payment');
    assert.equal(account.legal_entity_id, f.legal);
    // A replay answers the same; a stale screen is refused.
    assert.deepEqual(await parts.registry.kioskBranch(f.manager.token, f.second, request), on);
    await assert.rejects(
      parts.registry.kioskBranch(
        f.manager.token,
        f.second,
        f.body({ enabled: false, expected_version: 0 }),
      ),
      { code: 'CONFLICT', reason: 'KIOSK_BRANCH_VERSION' },
    );
    const audit = (
      await f.pool.query(
        "SELECT * FROM bo_audit WHERE action='kiosk_branch_settings' AND branch_id=$1",
        [f.second],
      )
    ).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].entity_id, f.second);
    assert.equal(audit[0].before_value, null);
    assert.equal(audit[0].after_value.enabled, true);

    // «Подключить киоск» now works for the point; the iPad enrolls through the same exchange.
    const listed = await parts.registry.read(f.manager.token, f.second);
    assert.equal(listed.kiosk_pairing_enabled, true);
    const device = await f.enroll(parts, f.second);
    const who = await f.guest(parts, device);
    assert.equal(who.branchId, f.second);

    // Config: this point's name, terminal only, no QR and no invoice.
    const config = await parts.checkout.kioskConfig(who);
    assert.equal(config.branchId, f.second);
    assert.equal(config.restaurant, 'Synthetic second point');
    assert.deepEqual(config.paymentMethods, []);
    assert.deepEqual(config.kaspi_terminal, { enabled: true, terminal: null, only: true });
    assert.equal(config.enabled, true);
    assert.equal((await parts.checkout.catalog(who)).branch.id, f.second);

    const created = await f.order(parts, who);
    // No QR here, and the terminal needs a link first.
    await assert.rejects(
      parts.checkout.pay(who, created.orderId, { method: 'kaspi_qr' }),
      code('NOT_READY'),
    );
    await assert.rejects(
      parts.checkout.pay(who, created.orderId, {
        method: 'kaspi_terminal',
        request_id: randomUUID(),
      }),
      code('KIOSK_TERMINAL_NOT_LINKED'),
    );
    await parts.checkout.terminal.link(
      { deviceId: device.id, organizationId: f.org, branchId: f.second },
      { terminal_id: 'T-200', serial: 'SN-2', host: '192.168.5.40' },
    );
    const attempt = await parts.checkout.pay(who, created.orderId, {
      method: 'kaspi_terminal',
      request_id: randomUUID(),
    });
    assert.equal(attempt.terminal_id, 'T-200');
    assert.equal(attempt.amount_tenge, 110);
    await parts.checkout.terminalEvent(who, created.orderId, {
      attempt_id: attempt.attempt_id,
      kind: 'started',
      process_id: 'P-1',
      terminal_id: 'T-200',
    });
    const paid = await parts.checkout.terminalEvent(who, created.orderId, {
      attempt_id: attempt.attempt_id,
      kind: 'result',
      process_id: 'P-1',
      terminal_id: 'T-200',
      status: 'success',
      transaction_id: 'TX-2',
      method: 'card',
      amount_tenge: 110,
    });
    assert.equal(paid.phase, 'paid');
    const capture = (
      await f.pool.query('SELECT * FROM commerce_captures WHERE order_id=$1', [created.orderId])
    ).rows;
    assert.equal(capture.length, 1);
    assert.equal(capture[0].account_id, on.payment_account.id, "the point's own account");
    assert.equal(capture[0].operation_id, 'TX-2');

    // The kitchen of this point admits it, through the same command as on the env point.
    const row = (
      await f.pool.query('SELECT branch_id,quote_digest FROM commerce_orders WHERE id=$1', [
        created.orderId,
      ])
    ).rows[0];
    assert.equal(row.branch_id, f.second);
    await parts.checkout.repository.confirmAdmission(
      { organizationId: f.org, branchId: f.second, deviceId: f.secondEdge },
      {
        eventId: randomUUID(),
        orderId: created.orderId,
        reservationId: randomUUID(),
        quoteDigest: row.quote_digest,
      },
    );
    const kitchen = (
      await f.pool.query(
        "SELECT payload FROM commerce_outbox WHERE order_id=$1 AND event_type='edge.kitchen_admission_requested'",
        [created.orderId],
      )
    ).rows;
    assert.equal(kitchen.length, 1);
    assert.equal(kitchen[0].payload.branchId, f.second);
    assert.equal(kitchen[0].payload.deviceId, f.secondEdge, "this point's server");
    // The env point's kitchen never takes it.
    await assert.rejects(
      parts.checkout.repository.confirmAdmission(
        { organizationId: f.org, branchId: f.branch, deviceId: f.device },
        {
          eventId: randomUUID(),
          orderId: created.orderId,
          reservationId: randomUUID(),
          quoteDigest: row.quote_digest,
        },
      ),
    );

    // Switched off: the enrolled kiosk waits (NOT_READY), pairing is refused again.
    await parts.registry.kioskBranch(
      f.manager.token,
      f.second,
      f.body({ enabled: false, expected_version: 1 }),
    );
    await assert.rejects(parts.checkout.kioskConfig(who), code('NOT_READY'));
    await assert.rejects(parts.checkout.catalog(who), code('NOT_READY'));
    await assert.rejects(
      parts.registry.issueKiosk(f.manager.token, f.second, {
        request_id: randomUUID(),
        name: 'Киоск',
        reason: 'Новый iPad',
      }),
      { reason: 'KIOSK_BRANCH_NOT_SERVED' },
    );
    // Switched on again: the same account, never a second one.
    const again = await parts.registry.kioskBranch(
      f.manager.token,
      f.second,
      f.body({ enabled: true, expected_version: 2 }),
    );
    assert.equal(again.payment_account.id, on.payment_account.id);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM commerce_provider_accounts WHERE branch_id=$1 AND provider='kaspi-pos'",
          [f.second],
        )
      ).rows[0].n,
      1,
    );
    // The env point keeps its QR and its own account.
    const envDevice = await f.enroll(parts, f.branch);
    const envGuest = await f.guest(parts, envDevice);
    const envConfig = await parts.checkout.kioskConfig(envGuest);
    assert.deepEqual(envConfig.paymentMethods, ['kaspi_qr']);
    assert.deepEqual(envConfig.kaspi_terminal, { enabled: true, terminal: null });
    // History is kept: no delete, no identity change, version grows by one.
    await assert.rejects(f.pool.query('DELETE FROM kiosk_branch_settings'), /never deleted/);
    await assert.rejects(
      f.pool.query('UPDATE kiosk_branch_settings SET enabled=false WHERE branch_id=$1', [f.second]),
      /version grows by one/,
    );
  }));

test('a point not switched on: NOT_READY with the flag, FORBIDDEN without it (as before)', () =>
  fixture(async (f) => {
    // A kiosk device of the second point, as the offline procedure would create it.
    const key = randomBytes(32).toString('hex');
    const id = randomUUID();
    await f.pool.query(
      'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
      [
        id,
        f.org,
        f.second,
        (await import('node:crypto')).createHash('sha256').update(key).digest('hex'),
      ],
    );
    const on = f.build(true);
    const who = await f.guest(on, { id, key });
    await assert.rejects(on.checkout.kioskConfig(who), code('NOT_READY'));
    await assert.rejects(
      on.checkout.config({ ...who, sessionId: id }),
      code('NOT_READY'),
      'enrollment/check and terminal routes refuse the same way',
    );
    // Flag off: exactly the previous single-point answer, even once the point is switched on.
    await on.registry.kioskBranch(
      f.manager.token,
      f.second,
      f.body({ enabled: true, expected_version: 0 }),
    );
    assert.equal((await on.checkout.kioskConfig(who)).kaspi_terminal.only, true);
    const off = f.build(false);
    await assert.rejects(off.checkout.kioskConfig(who), code('FORBIDDEN'));
    await assert.rejects(off.checkout.catalog(who), code('FORBIDDEN'));
    const list = await off.registry.read(f.manager.token, f.second);
    assert.equal(list.kiosk_pairing_enabled, false);
    assert.equal('kiosk_branch' in list, false, 'the list keeps its previous shape');
    assert.equal(
      'kiosk_branch' in (await off.registry.read(f.manager.token, f.branch)),
      false,
      'also on the env point',
    );
    await assert.rejects(
      off.registry.kioskBranch(
        f.manager.token,
        f.second,
        f.body({ enabled: false, expected_version: 1 }),
      ),
      { code: 'SERVICE_UNAVAILABLE', reason: 'KIOSK_MULTI_BRANCH_DISABLED' },
    );
    await assert.rejects(
      off.registry.issueKiosk(f.manager.token, f.second, {
        request_id: randomUUID(),
        name: 'Киоск',
        reason: 'Новый iPad',
      }),
      { reason: 'KIOSK_BRANCH_NOT_SERVED' },
    );
    // An ID/key issued while the point was on is refused by a single-point server.
    const issued = await on.registry.issueKiosk(f.manager.token, f.second, {
      request_id: randomUUID(),
      name: 'Киоск',
      reason: 'Новый iPad',
    });
    await assert.rejects(
      off.enrollment.exchange({
        login: issued.login,
        password: issued.password,
        requestId: randomUUID(),
      }),
      code('FORBIDDEN'),
    );
    // Only a manager switches; an analyst sees the state.
    await grantBackoffice(f.pool, f.manager.actor_id, f.second, 'analyst');
    await assert.rejects(
      on.registry.kioskBranch(
        f.manager.token,
        f.second,
        f.body({ enabled: false, expected_version: 1 }),
      ),
      { code: 'FORBIDDEN' },
    );
    assert.equal((await on.registry.read(f.manager.token, f.second)).kiosk_branch.enabled, true);
  }));

test('grants: exact SQL, flag off revokes, and the restricted API role switches and serves', () =>
  fixture(async (f) => {
    assert.deepEqual(kioskBranchSettingsPrivileges({ multiBranch: false, backoffice: true }), {});
    assert.deepEqual(kioskBranchSettingsPrivileges({ multiBranch: true, backoffice: false }), {
      kiosk_branch_settings: ['SELECT'],
    });
    const sql = kioskBranchSettingsGrants('pickchick_app', { multiBranch: true, backoffice: true });
    assert.match(sql, /to_regclass\('public\.kiosk_branch_settings'\)/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION "public"\.kiosk_branch_terminal_account/);
    assert.ok(!/DELETE|TRUNCATE|commerce_provider_accounts/.test(sql));
    assert.ok(
      !/GRANT/.test(
        kioskBranchSettingsGrants('pickchick_app', { multiBranch: false, backoffice: true }),
      ),
    );
    assert.throws(() =>
      kioskBranchSettingsGrants('x"; DROP', { multiBranch: true, backoffice: true }),
    );
    assert.throws(() => kioskBranchSettingsGrants('pickchick_app', { multiBranch: 'yes' }));

    const role = 'kiosk_branch_' + randomBytes(4).toString('hex');
    const password = randomBytes(12).toString('hex');
    const schema = new URL(f.cloud.config.databaseUrl).searchParams
      .get('options')
      .match(/search_path=(\S+)/)[1];
    const admin = f.pool;
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    let pool;
    try {
      // Baseline: the shared role reads (and row-locks) the tables, as the back-office profiles
      // do, and writes the back-office journal.
      await admin.query(
        `GRANT USAGE ON SCHEMA "${schema}" TO ${role}; GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO ${role};
         GRANT INSERT ON "${schema}".bo_audit, "${schema}".bo_commands TO ${role};
         REVOKE ALL ON "${schema}".kiosk_branch_settings FROM ${role}`,
      );
      const url = new URL(f.cloud.config.databaseUrl);
      url.username = role;
      url.password = password;
      pool = createPool(url.toString());
      const parts = f.build(true, pool);
      // Without the 081 rights the point is not offered and not served.
      assert.equal('kiosk_branch' in (await parts.registry.read(f.manager.token, f.second)), false);
      await assert.rejects(
        parts.registry.kioskBranch(
          f.manager.token,
          f.second,
          f.body({ enabled: true, expected_version: 0 }),
        ),
        { reason: 'KIOSK_MULTI_BRANCH_DISABLED' },
      );
      await admin.query(
        kioskBranchSettingsGrants(role, { multiBranch: true, backoffice: true }, schema),
      );
      const on = await parts.registry.kioskBranch(
        f.manager.token,
        f.second,
        f.body({ enabled: true, expected_version: 0 }),
      );
      assert.equal(on.payment_account.enabled, true);
      // The role creates no account of its own and never deletes a setting.
      await assert.rejects(
        pool.query(
          "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1,$2,$3,'payment','kaspi-qr','x',true,$4)",
          [randomUUID(), f.org, f.second, f.legal],
        ),
        { code: '42501' },
      );
      await assert.rejects(pool.query('DELETE FROM kiosk_branch_settings'), { code: '42501' });
      // The kiosk API (read only) serves the point.
      await admin.query(
        kioskBranchSettingsGrants(role, { multiBranch: true, backoffice: false }, schema),
      );
      await assert.rejects(pool.query('UPDATE kiosk_branch_settings SET version=version+1'), {
        code: '42501',
      });
      await assert.rejects(
        pool.query('SELECT kiosk_branch_terminal_account($1,$2)', [f.org, f.second]),
        { code: '42501' },
      );
      const key = randomBytes(32).toString('hex'),
        id = randomUUID();
      await admin.query(
        'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
        [
          id,
          f.org,
          f.second,
          (await import('node:crypto')).createHash('sha256').update(key).digest('hex'),
        ],
      );
      // The guest session itself is written by the admin pool (kiosk grants are not under test).
      const adminParts = f.build(true);
      const who = await f.guest(adminParts, { id, key });
      assert.equal((await parts.checkout.catalog(who)).branch.id, f.second);
      // Flag off: the rights are taken back and the point is no longer served.
      await admin.query(
        kioskBranchSettingsGrants(role, { multiBranch: false, backoffice: true }, schema),
      );
      await assert.rejects(parts.checkout.catalog(who), code('NOT_READY'));
    } finally {
      await pool?.end();
      await admin.query(`REASSIGN OWNED BY ${role} TO CURRENT_USER; DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
    }
  }));
