// ADR-0018 kiosk Kaspi Smart POS terminal: grant SQL and the kiosk-reported shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kioskTerminalGrants,
  kioskTerminalPrivileges,
  TERMINAL_TABLES,
} from '../../infra/staging/kiosk-terminal-grants.mjs';
import {
  KioskTerminalEventSchema,
  KioskTerminalLinkSchema,
  KioskTerminalPaymentSchema,
} from '../../packages/commerce-core/dist/index.js';

test('terminal grants: guarded reset, exact enabled set, revoke-only when off', () => {
  const on = kioskTerminalGrants('api_runtime', true);
  assert.match(
    on,
    /^DO \$kiosk_terminal\$ BEGIN IF to_regclass\('public\.commerce_kiosk_terminal_events'\) IS NOT NULL THEN /,
  );
  for (const table of TERMINAL_TABLES)
    assert.ok(on.includes(`REVOKE ALL ON "public"."${table}" FROM "api_runtime";`), table);
  assert.ok(
    on.includes(
      'GRANT SELECT, INSERT, UPDATE(serial,host,updated_at,unlinked_at) ON "public"."kiosk_terminal_links" TO "api_runtime";',
    ),
  );
  assert.ok(
    on.includes(
      'GRANT SELECT, INSERT ON "public"."commerce_kiosk_terminal_events" TO "api_runtime";',
    ),
  );
  assert.ok(on.includes('GRANT UPDATE(state) ON "public"."commerce_payment_attempts"'));
  assert.doesNotMatch(on, /DELETE|TRUNCATE|GRANT ALL|REVOKE [^;]*commerce_captures/);
  const off = kioskTerminalGrants('api_runtime', false);
  assert.doesNotMatch(off, /GRANT/);
  assert.equal((off.match(/REVOKE ALL/g) ?? []).length, 3);
  assert.deepEqual(kioskTerminalPrivileges(false), {});
  assert.deepEqual(Object.keys(kioskTerminalPrivileges(true)).slice(0, 3), [...TERMINAL_TABLES]);
  assert.match(kioskTerminalGrants('api', true, 'sync_x1'), /"sync_x1"\."kiosk_terminal_links"/);
  for (const role of ['', null, 'Role', 'x;DROP ROLE api', 'a'.repeat(64), '1api'])
    assert.throws(() => kioskTerminalGrants(role, true));
  for (const enabled of [undefined, null, 'true', 1])
    assert.throws(() => kioskTerminalGrants('api', enabled));
  assert.throws(() => kioskTerminalGrants('api', true, 'bad schema'));
});

test('terminal link body: private IPv4 only, bounded identifiers', () => {
  const ok = { terminal_id: 'T-1', serial: 'SN1', host: '172.16.0.5' };
  assert.deepEqual(KioskTerminalLinkSchema.parse(ok), ok);
  assert.equal(KioskTerminalLinkSchema.parse({ ...ok, terminal_id: 1234 }).terminal_id, '1234');
  for (const host of [
    '172.32.0.1',
    '192.169.0.1',
    '11.0.0.1',
    '127.0.0.1',
    '10.0.0.256',
    '10.0.0',
    '010.0.0.1',
    '::1',
  ])
    assert.equal(KioskTerminalLinkSchema.safeParse({ ...ok, host }).success, false, host);
  assert.equal(KioskTerminalLinkSchema.safeParse({ ...ok, serial: 'x'.repeat(65) }).success, false);
});

test('terminal event: started carries no money, result needs a status; nulls equal absence', () => {
  const base = {
    attempt_id: '00000000-0000-4000-8000-000000000001',
    process_id: 'P-1',
    terminal_id: 'T-1',
  };
  assert.deepEqual(KioskTerminalEventSchema.parse({ ...base, kind: 'started' }), {
    ...base,
    kind: 'started',
  });
  assert.deepEqual(
    KioskTerminalEventSchema.parse({
      ...base,
      kind: 'result',
      status: 'fail',
      transaction_id: null,
      amount_tenge: null,
      process_id: 77,
    }),
    { ...base, process_id: '77', kind: 'result', status: 'fail' },
  );
  for (const bad of [
    { kind: 'started', status: 'success' },
    { kind: 'started', amount_tenge: 1 },
    { kind: 'result' },
    { kind: 'result', status: 'success', amount_tenge: 0 },
    { kind: 'result', status: 'success', amount_tenge: 1.5 },
    { kind: 'result', status: 'success', method: 'cash' },
    { kind: 'other' },
  ])
    assert.equal(KioskTerminalEventSchema.safeParse({ ...base, ...bad }).success, false);
  assert.equal(
    KioskTerminalPaymentSchema.safeParse({ method: 'kaspi_terminal', request_id: 'x' }).success,
    false,
  );
});
