import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createStaffCredentialStore } from '../../scripts/staff-credential.mjs';
import {
  assertPrivateStaffPath,
  inspectStaffWindowsAcl,
  validateStaffWindowsAcl,
} from '../../scripts/staff-file-permissions.mjs';

const currentSid = 'S-1-5-21-100-200-300-1001';
const allow = (sid = currentSid, inherited = false) => ({ sid, type: 'Allow', inherited });
function acl(kind = 'directory', overrides = {}) {
  return {
    filesystem: 'NTFS',
    current_sid: currentSid,
    owner_sid: currentSid,
    protected: kind === 'directory',
    dacl_present: true,
    ace_count: 3,
    directory: kind === 'directory',
    reparse: false,
    rules: [allow(), allow('S-1-5-18'), allow('S-1-5-32-544')],
    ...overrides,
  };
}

test('Windows ACL policy fixtures accept only private SID grants (no Windows execution)', () => {
  validateStaffWindowsAcl(acl(), 'directory');
  validateStaffWindowsAcl(
    acl('file', { rules: acl().rules.map((rule) => ({ ...rule, inherited: true })) }),
    'file',
  );
  validateStaffWindowsAcl(acl('file', { protected: true }), 'file');
  validateStaffWindowsAcl(acl('directory', { owner_sid: 'S-1-5-32-544' }), 'directory');
});

test('Windows ACL policy fixtures reject unsafe, incomplete and unsupported descriptors', () => {
  const bad = [
    null,
    {},
    acl('directory', { current_sid: undefined }),
    acl('directory', { filesystem: 'FAT32' }),
    acl('directory', { owner_sid: 'S-1-1-0' }),
    acl('directory', { protected: false }),
    acl('directory', { dacl_present: false }),
    acl('directory', { reparse: true }),
    acl('file'),
    acl('directory', { rules: [], ace_count: 0 }),
    acl('directory', { ace_count: 4 }),
    acl('directory', { rules: [allow('S-1-1-0')], ace_count: 1 }),
    acl('directory', { rules: [allow('S-1-5-32-545')], ace_count: 1 }),
    acl('directory', { rules: [allow(currentSid, true)], ace_count: 1 }),
    acl('directory', { rules: [{ ...allow(), type: 'Unrecognized' }], ace_count: 1 }),
  ];
  for (const descriptor of bad)
    assert.throws(
      () => validateStaffWindowsAcl(descriptor, 'directory'),
      /Private directory required/,
    );
  assert.throws(
    () =>
      validateStaffWindowsAcl(
        acl('file', { rules: [allow('S-1-1-0', true)], ace_count: 1 }),
        'file',
      ),
    /Private credential file required/,
  );
});

test('PowerShell boundary passes literal path as data and suppresses subprocess errors', async () => {
  const path = 'C:\\Private [staff]\\$(unexpected)\\.local';
  const result = await inspectStaffWindowsAcl(path, async (executable, args, options) => {
    assert.match(executable, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    assert.ok(args.includes('-NoProfile'));
    assert.ok(args.includes('-NonInteractive'));
    const command = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.ok(command.includes('Get-Acl -LiteralPath $path'));
    assert.equal(command.includes(path), false);
    assert.equal(options.env.PICKCHICK_STAFF_ACL_PATH, path);
    assert.equal(options.timeout, 10000);
    assert.equal(options.maxBuffer, 65536);
    assert.equal(options.shell, undefined);
    return { stdout: JSON.stringify(acl()) };
  });
  assert.deepEqual(result, acl());
  for (const run of [
    async () => {
      throw new Error('synthetic-sensitive-subprocess-output');
    },
    async () => ({ stdout: 'synthetic-sensitive-invalid-json' }),
  ]) {
    await assert.rejects(inspectStaffWindowsAcl(path, run), (error) => {
      assert.equal(error.message, 'Unable to verify private Windows credential permissions');
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-staff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '.local');
  const store = createStaffCredentialStore(pathToFileURL(`${directory}/`));
  return { root, directory, store };
}

test('Windows boundary verifies parent before accepting inherited file ACL fixtures', async (t) => {
  const { directory } = await fixture(t);
  await mkdir(directory, { mode: 0o700 });
  const file = join(directory, 'staff-fixture.json');
  await writeFile(file, '');
  const inspected = [];
  await assertPrivateStaffPath(file, 'file', {
    platform: 'win32',
    inspectAcl: async (path) => {
      inspected.push(path);
      return path === directory ? acl() : acl('file');
    },
  });
  assert.deepEqual(inspected, [directory, file]);
  inspected.length = 0;
  await assert.rejects(
    assertPrivateStaffPath(file, 'file', {
      platform: 'win32',
      inspectAcl: async (path) => {
        inspected.push(path);
        return acl('directory', { protected: false });
      },
    }),
    /Private directory required/,
  );
  assert.deepEqual(inspected, [directory]);
});

const staffId = '20000000-0000-4000-8000-000000000001';
const credential = {
  session_id: '40000000-0000-4000-8000-000000000001',
  staff_id: staffId,
  terminal_id: '30000000-0000-4000-8000-000000000001',
  branch_id: '10000000-0000-4000-8000-000000000001',
  role: 'cashier',
  expires_at: '2026-09-14T10:00:00.000Z',
  token: 'a'.repeat(64), // Synthetic schema fixture; never issued to a service.
};

test(
  'Unix credential creation, renewal and private modes use actual filesystem',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { directory, store } = await fixture(t);
    await store.prepareStaffFile(staffId, false);
    await store.saveStaffCredential(credential);
    assert.deepEqual(await store.readStaffCredential(staffId), credential);
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(store.staffCredentialPath(staffId))).mode & 0o777, 0o600);
    await assert.rejects(store.prepareStaffFile(staffId, false), /Use --renew/);
    await store.prepareStaffFile(staffId, true);
    const renewed = { ...credential, token: 'b'.repeat(64) };
    await store.saveStaffCredential(renewed);
    assert.deepEqual(await store.readStaffCredential(staffId), renewed);
    assert.deepEqual(await readdir(directory), [`staff-${staffId}.json`]);
  },
);

test(
  'Unix unsafe directory and credential modes reject read, save and renewal',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { directory, store } = await fixture(t);
    await store.prepareStaffFile(staffId, false);
    await store.saveStaffCredential(credential);
    await chmod(directory, 0o755);
    await assert.rejects(store.readStaffCredential(staffId), /Private directory required/);
    await assert.rejects(store.saveStaffCredential(credential), /Private directory required/);
    await chmod(directory, 0o700);
    await chmod(store.staffCredentialPath(staffId), 0o644);
    await assert.rejects(store.readStaffCredential(staffId), /Private credential file required/);
    await assert.rejects(store.prepareStaffFile(staffId, true), /Private credential file required/);
    await assert.rejects(store.saveStaffCredential(credential), /Private credential file required/);
    assert.deepEqual(await readdir(directory), [`staff-${staffId}.json`]);
  },
);

test(
  'Unix rejects credential and trailing-slash directory symlinks',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, directory, store } = await fixture(t);
    const external = join(root, 'external');
    await mkdir(external, { mode: 0o700 });
    await symlink(external, directory, 'dir');
    await assert.rejects(store.prepareStaffFile(staffId, true), /Private directory required/);
    assert.deepEqual(await readdir(external), []);
    await rm(directory);
    await store.prepareStaffFile(staffId, false);
    const externalFile = join(external, 'synthetic.json');
    await writeFile(externalFile, JSON.stringify(credential), { mode: 0o600 });
    await symlink(externalFile, store.staffCredentialPath(staffId));
    await assert.rejects(store.readStaffCredential(staffId), /Private credential file required/);
    await assert.rejects(store.prepareStaffFile(staffId, true), /Private credential file required/);
    await assert.rejects(store.saveStaffCredential(credential), /Private credential file required/);
  },
);

test('invalid staff UUID fails before creating a credential directory', async (t) => {
  const { root, store } = await fixture(t);
  await assert.rejects(store.prepareStaffFile('../unsafe', false), /Invalid staff UUID/);
  assert.deepEqual(await readdir(root), []);
});
