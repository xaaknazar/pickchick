import { mkdir, readFile, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { StaffCredentialSchema, UuidSchema } from '@pickchick/contracts';
import { assertPrivateStaffPath } from './staff-file-permissions.mjs';

export function createStaffCredentialStore(directory) {
  function staffCredentialPath(staffId) {
    if (!UuidSchema.safeParse(staffId).success) throw new Error('Invalid staff UUID');
    return new URL(`staff-${staffId}.json`, directory);
  }
  async function checkExisting(path) {
    try {
      await assertPrivateStaffPath(path, 'file');
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  }
  async function prepareStaffFile(staffId, renew) {
    const path = staffCredentialPath(staffId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertPrivateStaffPath(directory, 'directory');
    if ((await checkExisting(path)) && !renew)
      throw new Error('Use --renew to issue another session');
  }
  async function saveStaffCredential(credential) {
    const data = StaffCredentialSchema.parse(credential);
    const target = staffCredentialPath(data.staff_id);
    await assertPrivateStaffPath(directory, 'directory');
    await checkExisting(target);
    const temp = new URL(`staff-${randomUUID()}.tmp`, directory);
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      // Verify the empty file before exposing the secret to its inherited Windows ACL.
      await assertPrivateStaffPath(temp, 'file');
      await handle.writeFile(`${JSON.stringify(data)}\n`, 'utf8');
      await handle.close();
      handle = undefined;
      await rename(temp, target);
    } finally {
      await handle?.close();
      await rm(temp, { force: true });
    }
  }
  async function readStaffCredential(staffId) {
    const path = staffCredentialPath(staffId);
    await assertPrivateStaffPath(path, 'file');
    return StaffCredentialSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  }
  return { staffCredentialPath, prepareStaffFile, saveStaffCredential, readStaffCredential };
}

export const { staffCredentialPath, prepareStaffFile, saveStaffCredential, readStaffCredential } =
  createStaffCredentialStore(new URL('../.local/', import.meta.url));
