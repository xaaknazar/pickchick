import { mkdir, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { StaffCredentialSchema, UuidSchema } from '@pickchick/contracts';

const directory = new URL('../.local/', import.meta.url);
export function staffCredentialPath(staffId) {
  if (!UuidSchema.safeParse(staffId).success) throw new Error('Invalid staff UUID');
  return new URL(`staff-${staffId}.json`, directory);
}
export async function prepareStaffFile(staffId, renew) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new Error('Private directory required');
  try {
    await lstat(staffCredentialPath(staffId));
    if (!renew) throw new Error('Use --renew to issue another session');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
export async function saveStaffCredential(credential) {
  const data = StaffCredentialSchema.parse(credential);
  const temp = new URL(`staff-${randomUUID()}.tmp`, directory);
  try {
    await writeFile(temp, `${JSON.stringify(data)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temp, staffCredentialPath(data.staff_id));
  } finally {
    await rm(temp, { force: true });
  }
}
export async function readStaffCredential(staffId) {
  const path = staffCredentialPath(staffId),
    info = await lstat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error('Private credential file required');
  return StaffCredentialSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
