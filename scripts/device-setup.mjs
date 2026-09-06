import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { provisionDevice } from '@pickchick/menu-sync';
import { prepareIdentityFile, saveIdentity } from './private-identity.mjs';

const config = loadConfig('api');
const edge = loadConfig('edge');
const deviceId = process.argv[2];
const rotate = process.argv.slice(3).includes('--rotate');
const pool = createPool(config.databaseUrl);
try {
  if (!deviceId) throw new Error('Usage: pnpm device:setup DEVICE_UUID [--rotate]');
  await prepareIdentityFile(rotate);
  const binding = await pool.query('SELECT branch_id FROM devices WHERE id = $1', [deviceId]);
  if (binding.rows[0]?.branch_id !== edge.branchId)
    throw new Error('Device does not match local branch binding');
  const identity = await provisionDevice(pool, deviceId, rotate);
  await saveIdentity(identity);
  console.log(
    JSON.stringify({
      event: 'device_identity_saved',
      device_id: identity.device_id,
      branch_id: identity.branch_id,
      expires_at: identity.expires_at,
      file: '.local/edge-identity.json',
    }),
  );
} catch {
  console.error(
    'Device setup failed. Check UUID, branch binding, pending/active status and private file permissions. After a file-write failure, retry with --rotate.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
