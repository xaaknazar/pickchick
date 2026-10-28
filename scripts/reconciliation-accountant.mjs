import { createPool } from '@pickchick/database';
import { grantReconciliationAccountant } from '@pickchick/backoffice-core/reconciliation';
// Operator step (owner database role): designate an analyst of a branch as its accountant for
// the daily payment reconciliation, or withdraw it. Other sections stay read-only for that person.
const args = process.argv.slice(2);
if (
  args.length !== 6 ||
  args[0] !== '--actor' ||
  args[2] !== '--branch' ||
  args[4] !== '--enabled' ||
  !['true', 'false'].includes(args[5])
)
  throw new Error('Usage: --actor UUID --branch UUID --enabled true|false');
const url = process.env.CLOUD_DATABASE_URL;
if (!url) throw new Error('CLOUD_DATABASE_URL required');
const pool = createPool(url);
try {
  await grantReconciliationAccountant(pool, args[1], args[3], args[5] === 'true');
  console.log('Reconciliation accountant designation recorded.');
} finally {
  await pool.end();
}
