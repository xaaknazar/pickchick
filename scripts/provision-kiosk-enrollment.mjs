#!/usr/bin/env node
// Offline only. Arguments are paths, never credentials. Retain output through lost ACK.
import { readFile, lstat, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createKioskEnrollmentMaterial } from '../packages/commerce-core/dist/kiosk-enrollment.js';
async function privatePath(path, existing) {
  let current = resolve(path);
  if (existing) {
    const info = await lstat(current);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077) throw new Error();
  }
  while (current !== dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error();
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    current = dirname(current);
  }
}
try {
  const args = process.argv.slice(2);
  if (args.length !== 8) throw new Error();
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--device', '--credentials', '--encryption-key', '--output-sql'].includes(args[i]) ||
      options[args[i]]
    )
      throw new Error();
    options[args[i]] = args[i + 1];
  }
  for (const flag of ['--device', '--credentials', '--encryption-key'])
    await privatePath(options[flag], true);
  await privatePath(options['--output-sql'], false);
  const profile = JSON.parse(await readFile(options['--device'], 'utf8'));
  const credentials = JSON.parse(await readFile(options['--credentials'], 'utf8'));
  const hex = (await readFile(options['--encryption-key'], 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error();
  const input = {
    deviceId: profile.deviceId,
    organizationId: profile.organizationId,
    branchId: profile.branchId,
    key: profile.deviceToken,
    login: credentials.login,
    password: credentials.password,
  };
  const material = await createKioskEnrollmentMaterial(input, Buffer.from(hex, 'hex'));
  const q = (value) => "'" + value.replaceAll("'", "''") + "'";
  const bytes = (value) => `decode('${value.toString('hex')}','hex')`;
  // UUID/login validated by material creation. SQL contains verifier/ciphertext, no password or token.
  const sql = `BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='5s';
DO $provision$
DECLARE old kiosk_enrollment_aliases%ROWTYPE;
BEGIN
 PERFORM id FROM kiosk_devices WHERE id=${q(input.deviceId)} AND organization_id=${q(input.organizationId)} AND branch_id=${q(input.branchId)} AND active AND token_hash=${q(material.tokenHash)} FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Enrollment device mismatch'; END IF;
 INSERT INTO kiosk_enrollment_aliases(login,device_id,organization_id,branch_id,password_salt,password_verifier,token_ciphertext,token_nonce,token_tag,created_at,expires_at)
 VALUES(${q(input.login)},${q(input.deviceId)},${q(input.organizationId)},${q(input.branchId)},${bytes(material.salt)},${bytes(material.verifier)},${bytes(material.ciphertext)},${bytes(material.nonce)},${bytes(material.tag)},statement_timestamp(),statement_timestamp()+interval '24 hours')
 ON CONFLICT(login) DO NOTHING;
 SELECT * INTO STRICT old FROM kiosk_enrollment_aliases WHERE login=${q(input.login)} FOR UPDATE;
 IF old.device_id<>${q(input.deviceId)}::uuid OR old.organization_id<>${q(input.organizationId)}::uuid OR old.branch_id<>${q(input.branchId)}::uuid
 OR old.password_salt<>${bytes(material.salt)} OR old.password_verifier<>${bytes(material.verifier)} OR old.token_ciphertext<>${bytes(material.ciphertext)} OR old.token_nonce<>${bytes(material.nonce)} OR old.token_tag<>${bytes(material.tag)} OR NOT old.active THEN
 RAISE EXCEPTION 'Enrollment alias conflict; no replacement'; END IF;
END $provision$;
COMMIT;
`;
  const file = await open(options['--output-sql'], 'wx', 0o600);
  try {
    await file.writeFile(sql);
    await file.sync();
  } finally {
    await file.close();
  }
  // No success output containing paths or credentials. Existing SQL is never overwritten.
} catch {
  console.error('Enrollment provisioning refused; retain existing private files and SQL.');
  process.exitCode = 1;
}
