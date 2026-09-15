import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import {
  StaffCredentialSchema,
  StaffLoginNameSchema,
  StaffPasswordSchema,
} from '@pickchick/contracts';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { setStaffPassword } from '@pickchick/local-orders';
import { assertPrivateStaffPath } from './staff-file-permissions.mjs';
import { readHiddenPassword } from './hidden-password.mjs';

let pool;
try {
  const { values } = parseArgs({
    options: {
      bootstrap: { type: 'string' },
      login: { type: 'string' },
      replace: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const login = StaffLoginNameSchema.parse(values.login);
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
    "SELECT pg_get_userbyid(relowner)=current_user AS allowed FROM pg_class WHERE oid='local_staff_passwords'::regclass",
  );
  if (owner.rows[0]?.allowed !== true) throw new Error('Operator database owner required');
  let password = await readHiddenPassword('New staff password (12-128 characters, hidden): ');
  let confirmation = await readHiddenPassword('Repeat staff password (hidden): ');
  if (!StaffPasswordSchema.safeParse(password).success || password !== confirmation)
    throw new Error('Password confirmation failed');
  try {
    const result = await setStaffPassword(
      pool,
      config.branchId,
      { sessionId: credential.session_id, token: credential.token },
      login,
      password,
      values.replace,
    );
    console.log(
      JSON.stringify({ event: 'staff_password_saved', ...result, previous_sessions_revoked: true }),
    );
  } finally {
    password = '';
    confirmation = '';
  }
} catch {
  // Do not print exceptions, validation input, connection strings or subprocess output.
  console.error(
    'Staff password setup failed. Use the local protected owner configuration, a current private bootstrap session, an unused login and matching passwords. Existing passwords require --replace; expired/revoked bootstrap sessions require operator staff renewal first. No password is printed or saved in a file.',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
