import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { StaffCredentialSchema } from '@pickchick/contracts';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { setStaffPin } from '@pickchick/local-orders';
import { assertPrivateStaffPath } from './staff-file-permissions.mjs';
import { readHiddenPassword } from './hidden-password.mjs';

let pool;
try {
  const { values } = parseArgs({
    options: {
      bootstrap: { type: 'string' },
      replace: { type: 'boolean', default: false },
      // 6-digit PINs (finding 6.5) need owner setup: the PIN pad types only its configured
      // pinLength (default 4; installed POS builds have no 6-digit pad). Pass --digits 6 when
      // re-enrolling a branch for pinLength 6. Existing 4-digit PINs keep working either way.
      digits: { type: 'string', default: '4' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.bootstrap) throw new Error('Bootstrap file required');
  if (!['4', '6'].includes(values.digits)) throw new Error('PIN length must be 4 or 6');
  const digits = Number(values.digits);
  await assertPrivateStaffPath(values.bootstrap, 'file');
  if ((await stat(values.bootstrap)).size > 10000)
    throw new Error('Bounded bootstrap file required');
  const credential = StaffCredentialSchema.parse(
    JSON.parse(await readFile(values.bootstrap, 'utf8')),
  );
  const config = loadConfig('edge'),
    database = new URL(config.databaseUrl);
  if (
    database.hostname !== '127.0.0.1' ||
    database.port !== '55433' ||
    database.pathname !== '/pickchick_edge' ||
    credential.branch_id !== config.branchId
  )
    throw new Error('Local edge owner connection and matching branch required');
  pool = createPool(config.databaseUrl);
  const owner = await pool.query(
    "SELECT pg_get_userbyid(relowner)=current_user AS allowed FROM pg_class WHERE oid='local_staff_pins'::regclass",
  );
  if (owner.rows[0]?.allowed !== true) throw new Error('Operator database owner required');
  let password = await readHiddenPassword(`New staff PIN (${digits} digits, hidden): `);
  let confirmation = await readHiddenPassword('Repeat staff PIN (hidden): ');
  if (!new RegExp(`^[0-9]{${digits}}$`).test(password) || password !== confirmation)
    throw new Error('PIN confirmation failed');
  try {
    const result = await setStaffPin(
      pool,
      config.branchId,
      { sessionId: credential.session_id, token: credential.token },
      password,
      values.replace,
    );
    console.log(
      JSON.stringify({
        event: 'staff_pin_saved',
        ...result,
        pin_digits: digits,
        previous_sessions_revoked: true,
      }),
    );
  } finally {
    password = '';
    confirmation = '';
  }
} catch {
  // Do not print exceptions, validation input, connection strings or subprocess output.
  console.error(
    'Staff PIN setup failed. Use the local protected owner configuration, a current private bootstrap session, an unused PIN of --digits length (default 4, 6 only for a pinLength 6 POS) and matching confirmation. Existing PINs require --replace; expired/revoked bootstrap sessions require operator staff renewal first. No PIN is printed or saved in a file.',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
