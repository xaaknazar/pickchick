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
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.bootstrap) throw new Error('Bootstrap file required');
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
  let password = await readHiddenPassword('New staff PIN (4 digits, hidden): ');
  let confirmation = await readHiddenPassword('Repeat staff PIN (hidden): ');
  if (!/^\d{4}$/.test(password) || password !== confirmation)
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
      JSON.stringify({ event: 'staff_pin_saved', ...result, previous_sessions_revoked: true }),
    );
  } finally {
    password = '';
    confirmation = '';
  }
} catch {
  // Do not print exceptions, validation input, connection strings or subprocess output.
  console.error(
    'Staff PIN setup failed. Use the local protected owner configuration, a current private bootstrap session, an unused PIN and matching confirmation. Existing PINs require --replace; expired/revoked bootstrap sessions require operator staff renewal first. No PIN is printed or saved in a file.',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
