import { readFile, stat } from 'node:fs/promises';
import { StaffSetupSchema } from '@pickchick/contracts';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { provisionStaff } from '@pickchick/local-orders';
import { prepareStaffFile, saveStaffCredential } from './staff-credential.mjs';

const config = loadConfig('edge'),
  pool = createPool(config.databaseUrl);
try {
  const file = process.argv[2];
  if (!file || (await stat(file)).size > 10000) throw new Error('Expected bounded setup file');
  const setup = StaffSetupSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  await prepareStaffFile(setup.staff_id, process.argv.includes('--renew'));
  const credential = await provisionStaff(pool, config.branchId, setup);
  await saveStaffCredential(credential);
  console.log(
    JSON.stringify({
      event: 'staff_session_saved',
      staff_id: credential.staff_id,
      role: credential.role,
      expires_at: credential.expires_at,
      file: `.local/staff-${credential.staff_id}.json`,
    }),
  );
} catch {
  console.error(
    'Staff setup failed. Check input, branch, active staff/terminal, unchanged role and private file permissions. For renewal or recovery after file-write failure use --renew.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
