import { mkdir, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DeviceIdentitySchema } from '@pickchick/contracts';

export const identityDirectory = new URL('../.local/', import.meta.url);
export const identityPath = new URL('edge-identity.json', identityDirectory);

export async function readIdentity() {
  const info = await lstat(identityPath);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error('Identity requires a regular private file (mode 600)');
  return DeviceIdentitySchema.parse(JSON.parse(await readFile(identityPath, 'utf8')));
}

export async function prepareIdentityFile(rotate) {
  await mkdir(identityDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(identityDirectory);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0)
    throw new Error('Identity directory requires mode 700');
  let exists = false;
  try {
    await lstat(identityPath);
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (exists && !rotate) throw new Error('Identity already exists; explicit --rotate required');
}

export async function saveIdentity(identity) {
  const temporary = new URL(`identity-${randomUUID()}.tmp`, identityDirectory);
  try {
    await writeFile(temporary, `${JSON.stringify(DeviceIdentitySchema.parse(identity))}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, identityPath);
  } finally {
    await rm(temporary, { force: true });
  }
}
