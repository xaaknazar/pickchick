import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackofficeServer } from '../../apps/backoffice/server.mjs';
import {
  createStaffAccess,
  loadStaffAccess,
  parseStaffConfig,
  passwordHash,
  readStaffConfig,
} from '../../apps/backoffice/staff-auth.mjs';
import {
  addStaffAccount,
  main as accounts,
  removeStaffAccount,
} from '../../infra/backoffice-login/accounts.mjs';

// Synthetic fixtures only: no real people, passwords or tokens.
const origin = 'https://pickchick.example';
const ceoPassword = 'Synthetic-ceo-password-2026';
const managerPassword = 'Synthetic-manager-password-2026';
const ceoToken = 'c'.repeat(64);
const managerToken = 'd'.repeat(64);
const ceoActor = '11111111-1111-4111-8111-111111111111';
const managerActor = '22222222-2222-4222-8222-222222222222';
const ceo = {
  username: 'ceo',
  token: ceoToken,
  actor_id: ceoActor,
  ...(await passwordHash(ceoPassword)),
};
const manager = {
  username: 'aigerim.manager',
  token: managerToken,
  actor_id: managerActor,
  ...(await passwordHash(managerPassword)),
};
const v1 = {
  version: 1,
  username: 'ceo',
  origin,
  token: ceoToken,
  actor_id: ceoActor,
  salt: ceo.salt,
  hash: ceo.hash,
};
const v2 = { version: 2, origin, accounts: [ceo, manager] };

function call(port, path, { method = 'GET', body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          host: 'pickchick.example',
          origin,
          ...(cookie ? { cookie } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    r.on('error', reject);
    r.end(body && JSON.stringify(body));
  });
}

async function portal(t, config) {
  const seen = [];
  const api = createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ branches: [] }));
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const server = createBackofficeServer({
    apiPort: api.address().port,
    staffAccess: createStaffAccess(config),
    staticPrefix: '/backoffice',
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    api.closeAllConnections();
    api.close();
  });
  const get = (p, o) => call(server.address().port, p, o);
  const login = async (username, password) => {
    const r = await get('/backoffice/auth/login', { method: 'POST', body: { username, password } });
    return { status: r.status, cookie: r.headers['set-cookie']?.[0].split(';')[0], text: r.text };
  };
  return { get, login, seen };
}

const catalog = '/backoffice/api/v1/admin/catalog/branches';

test('two staff members get their own session token; neither sees the other', async (t) => {
  const p = await portal(t, v2);
  const a = await p.login('ceo', ceoPassword);
  const b = await p.login(' Aigerim.Manager ', managerPassword);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  for (const r of [a, b])
    for (const token of [ceoToken, managerToken]) assert.ok(!r.text.includes(token));
  assert.equal((await p.get(catalog, { cookie: a.cookie })).status, 200);
  assert.equal((await p.get(catalog, { cookie: b.cookie })).status, 200);
  assert.equal((await p.get(catalog, { cookie: a.cookie })).status, 200);
  assert.deepEqual(p.seen, [`Bearer ${ceoToken}`, `Bearer ${managerToken}`, `Bearer ${ceoToken}`]);
  // One person logging out leaves the other signed in.
  assert.equal(
    (await p.get('/backoffice/auth/logout', { method: 'POST', cookie: a.cookie })).status,
    200,
  );
  assert.equal((await p.get(catalog, { cookie: a.cookie })).status, 401);
  assert.equal((await p.get(catalog, { cookie: b.cookie })).status, 200);
});

test('a wrong password, another person’s password or an unknown login are rejected alike', async (t) => {
  const p = await portal(t, v2);
  const attempts = [
    await p.login('aigerim.manager', ceoPassword),
    await p.login('ceo', managerPassword),
    await p.login('ceo', 'Synthetic-wrong-password-0000'),
    await p.login('nobody.here', ceoPassword),
  ];
  for (const r of attempts) {
    assert.equal(r.status, 401);
    assert.equal(r.cookie, undefined);
    assert.equal(JSON.parse(r.text).code, 'UNAUTHORIZED');
  }
  assert.deepEqual(p.seen, []);
});

test('the deployed single ceo file still works and migrates as the first entry', async (t) => {
  const migrated = parseStaffConfig(v1);
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.accounts, [ceo]);
  const p = await portal(t, v1);
  const a = await p.login('ceo', ceoPassword);
  assert.equal(a.status, 200);
  assert.equal((await p.get(catalog, { cookie: a.cookie })).status, 200);
  assert.deepEqual(p.seen, [`Bearer ${ceoToken}`]);
  // Version 1 never accepted another username; that stays true.
  assert.throws(() => parseStaffConfig({ ...v1, username: 'accountant' }));
});

test('accounts file content is validated strictly', () => {
  const bad = [
    { ...v2, accounts: [] },
    { ...v2, accounts: [ceo, { ...manager, token: ceoToken }] },
    { ...v2, accounts: [ceo, { ...manager, username: 'ceo' }] },
    { ...v2, accounts: [ceo, { ...manager, actor_id: ceoActor }] },
    { ...v2, accounts: [ceo, { ...manager, username: 'Has Space' }] },
    { ...v2, accounts: [ceo, { ...manager, extra: true }] },
    { ...v2, accounts: [ceo, { ...manager, token: 'x' }] },
    { ...v2, accounts: [ceo, { ...manager, actor_id: 'not-a-uuid' }] },
    { ...v2, origin: 'http://pickchick.example' },
    { ...v2, extra: 1 },
    { ...v2, version: 3 },
    { ...v2, accounts: Array.from({ length: 33 }, () => ceo) },
  ];
  for (const config of bad) assert.throws(() => createStaffAccess(config), /Invalid private staff/);
});

test('a world-readable, group-readable or linked accounts file is refused', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'staff-accounts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'staff.json');
  await writeFile(file, JSON.stringify(v2));
  for (const mode of [0o644, 0o640, 0o604, 0o666]) {
    await chmod(file, mode);
    await assert.rejects(loadStaffAccess(file), /Private staff accounts file required/);
  }
  await chmod(file, 0o600);
  assert.equal(typeof (await loadStaffAccess(file)), 'function');
  assert.deepEqual(
    (await readStaffConfig(file)).accounts.map((a) => a.username),
    ['ceo', 'aigerim.manager'],
  );
  // Owned by another user (the container runs as the file owner).
  await assert.rejects(
    readStaffConfig(file, { uid: (await stat(file)).uid + 1 }),
    /Private staff accounts file required/,
  );
  const link = join(dir, 'link.json');
  await symlink(file, link);
  await assert.rejects(loadStaffAccess(link), /Private staff accounts file required/);
  // Windows: the NTFS ACL of the file must name only the owner, SYSTEM and Administrators.
  const sid = 'S-1-5-21-1-2-3-1001';
  const acl = (extra) => async () => ({
    filesystem: 'NTFS',
    current_sid: sid,
    owner_sid: sid,
    protected: true,
    dacl_present: true,
    ace_count: 1 + extra.length,
    directory: false,
    reparse: false,
    rules: [{ sid, type: 'Allow', inherited: false }, ...extra],
  });
  await chmod(file, 0o644); // POSIX bits are not used on Windows.
  assert.equal(
    (await readStaffConfig(file, { platform: 'win32', inspectAcl: acl([]) })).version,
    2,
  );
  await assert.rejects(
    readStaffConfig(file, {
      platform: 'win32',
      inspectAcl: acl([{ sid: 'S-1-1-0', type: 'Allow', inherited: false }]),
    }),
    /Private credential file required/,
  );
  // Malformed JSON is reported without echoing the file.
  await chmod(file, 0o600);
  await writeFile(file, `{"token":"${ceoToken}"`);
  await assert.rejects(readStaffConfig(file), (error) => !String(error.message).includes(ceoToken));
});

test('operator command migrates, adds and removes accounts without printing secrets', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'staff-accounts-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = (name) => join(dir, name);
  const secret = async (name, value) => {
    await writeFile(path(name), JSON.stringify(value), { mode: 0o600 });
  };
  await secret('ceo.json', v1);
  await secret('cred.json', { token: managerToken, actor_id: managerActor });
  await secret('cred-dup.json', { token: ceoToken, actor_id: managerActor });
  const message = await accounts(['migrate', path('ceo.json'), path('v2.json')]);
  assert.ok(!message.includes(ceoToken));
  assert.deepEqual(JSON.parse(await readFile(path('v2.json'), 'utf8')), parseStaffConfig(v1));
  // Outputs are exclusive: an existing file is never overwritten.
  await assert.rejects(accounts(['migrate', path('ceo.json'), path('v2.json')]), /EEXIST/);
  await assert.rejects(
    accounts([
      'add',
      path('v2.json'),
      path('cred-dup.json'),
      'aigerim.manager',
      path('x.json'),
      path('x.txt'),
    ]),
    /another account/,
  );
  const added = await accounts([
    'add',
    path('v2.json'),
    path('cred.json'),
    'aigerim.manager',
    path('v2b.json'),
    path('delivery.txt'),
  ]);
  for (const value of [managerToken, ceoToken]) assert.ok(!added.includes(value));
  const config = JSON.parse(await readFile(path('v2b.json'), 'utf8'));
  assert.deepEqual(
    config.accounts.map((a) => a.username),
    ['ceo', 'aigerim.manager'],
  );
  assert.equal(config.accounts[1].token, managerToken);
  for (const name of ['v2.json', 'v2b.json', 'delivery.txt'])
    assert.equal((await stat(path(name))).mode & 0o077, 0);
  const delivery = await readFile(path('delivery.txt'), 'utf8');
  const password = /Пароль: (\S+)/.exec(delivery)[1];
  assert.ok(!delivery.includes(managerToken));
  const p = await portal(t, config);
  const b = await p.login('aigerim.manager', password);
  assert.equal(b.status, 200);
  assert.equal((await p.get(catalog, { cookie: b.cookie })).status, 200);
  assert.deepEqual(p.seen, [`Bearer ${managerToken}`]);
  await accounts(['remove', path('v2b.json'), 'aigerim.manager', path('v2c.json')]);
  assert.deepEqual(
    JSON.parse(await readFile(path('v2c.json'), 'utf8')).accounts.map((a) => a.username),
    ['ceo'],
  );
  // A world-readable input is refused before it is parsed.
  await chmod(path('v2b.json'), 0o644);
  await assert.rejects(
    accounts(['remove', path('v2b.json'), 'aigerim.manager', path('v2d.json')]),
    /Private staff accounts file required/,
  );
});

test('pure account edits refuse duplicates and removing the last account', () => {
  const one = parseStaffConfig(v1);
  assert.throws(() => addStaffAccount(one, { ...manager, username: 'ceo' }), /already exists/);
  assert.throws(() => addStaffAccount(one, { ...manager, token: ceoToken }), /another account/);
  assert.throws(() => addStaffAccount(one, { ...manager, actor_id: ceoActor }), /Actor already/);
  assert.throws(() => addStaffAccount(one, { ...manager, username: 'X' }), /Invalid username/);
  assert.throws(() => removeStaffAccount(one, 'ceo'), /last account/);
  assert.throws(() => removeStaffAccount(one, 'nobody'), /Unknown username/);
  assert.deepEqual(addStaffAccount(one, manager).accounts, [ceo, manager]);
});
