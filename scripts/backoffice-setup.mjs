import { readFile, stat } from 'node:fs/promises';
import { createPool } from '@pickchick/database';
import { designateBackoffice, grantBackoffice } from '@pickchick/backoffice-core';
import { RestoredShiftReportError, acceptRestoredShiftReport } from '@pickchick/pos-order-sync';
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
// CR cloud-5 item 2 (option A): the cloud database owner accepts, as written, the parked Z of a
// sales shift that was open across an edge database restore (docs/operations/backoffice-cutover.md
// «Восстановление базы кассы»). --event is the outbox row exported on the edge.
const restoredZ =
  args.length === 13 &&
  args[0] === '--accept-restored-z' &&
  args[1] === '--branch' &&
  args[3] === '--device' &&
  args[5] === '--actor' &&
  args[7] === '--request' &&
  args[9] === '--event' &&
  args[11] === '--reason';
if (!grant && !designation && !restoredZ)
  throw new Error(
    'Usage: --actor UUID --branch UUID --role manager|analyst\n' +
      '   or: --actor UUID --branch UUID --designation shift_manager|accountant|none --reason TEXT\n' +
      '   or: --accept-restored-z --branch UUID --device UUID --actor UUID --request UUID --event FILE --reason TEXT',
  );
/**
 * The exported outbox row: the wire event plus the payload_hash the edge stored with it. An
 * empty, oversized or unparsable file is refused like an event that fails the wire model.
 */
async function exportedEvent(file) {
  let row;
  try {
    if ((await stat(file)).size <= 256 * 1024) row = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (!row || typeof row !== 'object' || Array.isArray(row))
    throw new RestoredShiftReportError('INVALID_REQUEST', 'model');
  const { payload_hash: payloadHash, ...event } = row;
  return { payloadHash, event };
}
const url = process.env.CLOUD_DATABASE_URL;
if (!url) throw new Error('CLOUD_DATABASE_URL required');
const pool = createPool(url);
try {
  if (grant) {
    await grantBackoffice(pool, args[1], args[3], args[5]);
    console.log(
      'Backoffice branch grant recorded. Existing private manager credential remains unchanged.',
    );
  } else if (restoredZ) {
    try {
      const result = await acceptRestoredShiftReport(pool, {
        branchId: args[2],
        deviceId: args[4],
        actorId: args[6],
        requestId: args[8],
        reason: args[12],
        ...(await exportedEvent(args[10])),
      });
      // Money in minor units; ids and per-method sums only (no names, no receipt numbers).
      console.log(JSON.stringify({ event: 'pos_sales_restored_z', ...result }));
    } catch (error) {
      if (!(error instanceof RestoredShiftReportError)) throw error;
      console.error(
        JSON.stringify({
          event: 'pos_sales_restored_z_refused',
          code: error.code,
          reason: error.reason,
        }),
      );
      process.exitCode = 1;
    }
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
