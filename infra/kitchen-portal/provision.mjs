/** Trusted Windows-local operator step. Does not change the owner's POS PINs. */
import { readFile, writeFile } from 'node:fs/promises';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { provisionStaff } from '@pickchick/local-orders';
import { assertPrivateStaffPath } from '../../scripts/staff-file-permissions.mjs';
const config = loadConfig('edge'),
  db = new URL(config.databaseUrl);
if (db.hostname !== '127.0.0.1' || db.port !== '55433' || db.pathname !== '/pickchick_edge')
  throw new Error('Local owner database required');
const root = process.argv[2];
await assertPrivateStaffPath(root, 'directory');
const plan = JSON.parse(await readFile(root + '/portal-plan.json', 'utf8'));
const pool = createPool(config.databaseUrl);
try {
  const owner = await pool.query(
    "SELECT pg_get_userbyid(relowner)=current_user AS allowed FROM pg_class WHERE oid='local_staff'::regclass",
  );
  if (!owner.rows[0]?.allowed || plan.branchId !== config.branchId)
    throw new Error('Owner and branch must match');
  const staff = await pool.query(
    'SELECT name,role,active FROM local_staff WHERE id=$1 AND branch_id=$2',
    [plan.staffId, config.branchId],
  );
  if (staff.rows[0]?.role !== 'kitchen' || !staff.rows[0]?.active)
    throw new Error('Existing kitchen staff required');
  for (const [mode, terminal] of Object.entries(plan.terminals)) {
    if (!['prep', 'assembly', 'display'].includes(mode)) throw new Error('Invalid mode');
    const actor = await provisionStaff(pool, config.branchId, {
      staff_id: plan.staffId,
      terminal_id: terminal,
      name: staff.rows[0].name,
      role: 'kitchen',
    });
    await writeFile(root + '/bootstrap-' + mode + '.json', JSON.stringify(actor), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const password = await pool.query('SELECT login FROM local_staff_passwords WHERE staff_id=$1', [
    plan.staffId,
  ]);
  console.log(
    JSON.stringify({
      event: 'portal_terminals_ready',
      terminals: plan.terminals,
      passwordConfigured: password.rowCount > 0,
    }),
  );
} finally {
  await pool.end();
}
