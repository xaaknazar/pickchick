import { createPool } from '@pickchick/database';
import { designateBackoffice, grantBackoffice } from '@pickchick/backoffice-core';
const args = process.argv.slice(2);
const grant =
  args.length === 6 && args[0] === '--actor' && args[2] === '--branch' && args[4] === '--role';
// Cutover CC-5 (contracts 5.10): a designation is in force only while BACKOFFICE_ROLES_ENABLED
// is true on the API, and never replaces the bo_access_grants role.
const designation =
  args.length === 8 &&
  args[0] === '--actor' &&
  args[2] === '--branch' &&
  args[4] === '--designation' &&
  ['shift_manager', 'accountant', 'none'].includes(args[5]) &&
  args[6] === '--reason';
if (!grant && !designation)
  throw new Error(
    'Usage: --actor UUID --branch UUID --role manager|analyst\n' +
      '   or: --actor UUID --branch UUID --designation shift_manager|accountant|none --reason TEXT',
  );
const url = process.env.CLOUD_DATABASE_URL;
if (!url) throw new Error('CLOUD_DATABASE_URL required');
const pool = createPool(url);
try {
  if (grant) {
    await grantBackoffice(pool, args[1], args[3], args[5]);
    console.log(
      'Backoffice branch grant recorded. Existing private manager credential remains unchanged.',
    );
  } else {
    const result = await designateBackoffice(
      pool,
      args[1],
      args[3],
      args[5] === 'none' ? null : args[5],
      args[7],
    );
    console.log(
      JSON.stringify({
        event: 'backoffice_designation_recorded',
        actor_id: result.actor_id,
        branch_id: result.branch_id,
        grant: result.grant,
        previous_role: result.previous_role,
        role: result.role,
        note: 'In force only while BACKOFFICE_ROLES_ENABLED=true on the API',
      }),
    );
  }
} finally {
  await pool.end();
}
