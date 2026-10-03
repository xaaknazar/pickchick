import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { createPool } from '@pickchick/database';

// Explicit provisioning only. No automatic device registration or secret stdout.
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
if (
  args.length !== 6 ||
  args[0] !== '--organization' ||
  args[2] !== '--branch' ||
  args[4] !== '--output'
)
  throw new Error('Usage: --organization UUID --branch UUID --output PRIVATE_NEW_FILE');
const organizationId = value('--organization'),
  branchId = value('--branch'),
  output = value('--output');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!uuid.test(organizationId) || !uuid.test(branchId) || !output)
  throw new Error('Invalid provisioning arguments');
if (!process.env.CLOUD_DATABASE_URL) throw new Error('CLOUD_DATABASE_URL required');
const deviceId = randomUUID(),
  deviceToken = randomBytes(32).toString('hex');
const handle = await open(output, 'wx', 0o600);
const pool = createPool(process.env.CLOUD_DATABASE_URL);
let provisioned = false;
try {
  await handle.writeFile(
    JSON.stringify({ deviceId, deviceToken, organizationId, branchId }) + '\n',
  );
  await handle.sync();
  await handle.close();
  await pool.query(
    `INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash)
  VALUES($1,$2,$3,$4)`,
    [deviceId, organizationId, branchId, createHash('sha256').update(deviceToken).digest('hex')],
  );
  provisioned = true;
  console.log('Kiosk device provisioned; credentials written to private output.');
} catch {
  throw new Error('Kiosk provisioning failed; no credential details emitted');
} finally {
  await handle.close().catch(() => {});
  if (!provisioned) await unlink(output).catch(() => {});
  await pool.end();
}
