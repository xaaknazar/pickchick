import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request } from 'node:http';
import { createStaffAccess, passwordHash } from '../../apps/backoffice/staff-auth.mjs';
import { main as accounts, rotateStaffPassword } from '../../infra/backoffice-login/accounts.mjs';

// Synthetic secrets, never a deployed account or private delivery file.
const oldPassword = 'Synthetic-old-password-2026';
const newPassword = '  Synthetic-new-password-2026  ';
const managerPassword = 'Synthetic-manager-password-2026';
const origin = 'https://pickchick.example';
const ceo = {
  username: 'ceo',
  token: 'c'.repeat(64),
  actor_id: '11111111-1111-4111-8111-111111111111',
  ...(await passwordHash(oldPassword)),
};
const manager = {
  username: 'manager',
  token: 'd'.repeat(64),
  actor_id: '22222222-2222-4222-8222-222222222222',
  ...(await passwordHash(managerPassword)),
};
const v1 = { version: 1, origin, ...ceo };
const v2 = { version: 2, origin, accounts: [manager, ceo] };
const exec = promisify(execFile);

async function fixture(t, config = v2) {
  const dir = await mkdtemp(join(tmpdir(), 'staff-rotation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const current = join(dir, 'current.json'),
    password = join(dir, 'password'),
    next = join(dir, 'next.json');
  await writeFile(current, JSON.stringify(config), { mode: 0o600 });
  await writeFile(password, newPassword + '\r\n', { mode: 0o600 });
  return {
    dir,
    current,
    password,
    next,
    run: (username = 'ceo') => accounts(['rotate', current, username, password, next]),
  };
}

async function login(t, config, username, password) {
  const access = createStaffAccess(config);
  const server = createServer(async (req, res) => {
    await access(req, res, (status, body) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        path: '/backoffice/auth/login',
        method: 'POST',
        headers: { host: 'pickchick.example', origin, 'content-type': 'application/json' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ username, password }));
  });
}

test('rotate preserves v1/v2 formats and identities; real login rejects old CEO and keeps manager', async (t) => {
  for (const config of [v1, v2]) {
    const before = JSON.parse(JSON.stringify(config));
    const f = await fixture(t, config);
    const message = await f.run();
    const next = JSON.parse(await readFile(f.next, 'utf8'));
    const selected = next.version === 1 ? next : next.accounts.find((a) => a.username === 'ceo');
    assert.notEqual(selected.salt, ceo.salt);
    assert.notEqual(selected.hash, ceo.hash);
    selected.salt = ceo.salt;
    selected.hash = ceo.hash;
    assert.deepEqual(next, config); // Only salt/hash changed, including account order and v1 version.
    assert.deepEqual(config, before);
    assert.equal(await readFile(f.current, 'utf8'), JSON.stringify(config));
    assert.equal(await readFile(f.password, 'utf8'), newPassword + '\r\n');
    assert.equal((await stat(f.next)).mode & 0o777, 0o600);
    const actual = JSON.parse(await readFile(f.next, 'utf8'));
    assert.equal(await login(t, actual, 'ceo', oldPassword), 401);
    assert.equal(await login(t, actual, 'ceo', newPassword), 200);
    if (config.version === 2) assert.equal(await login(t, actual, 'manager', managerPassword), 200);
    for (const secret of [oldPassword, newPassword, ceo.token, manager.token, selected.hash])
      assert.ok(!message.includes(secret));
  }
});

test('unchanged passwords, unknown users and malformed configurations create no output', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run('missing'), /Unknown username/);
  await writeFile(f.password, oldPassword);
  await assert.rejects(f.run(), /must differ/);
  await writeFile(f.current, '{"token":"Synthetic-malformed-secret');
  await assert.rejects(f.run(), (e) => e.message === 'Invalid private rotation configuration');
  await assert.rejects(stat(f.next), { code: 'ENOENT' });
  await assert.rejects(rotateStaffPassword({ ...v2, version: 3 }, 'ceo', newPassword));
});

test('password input rejects broad permissions, links, invalid UTF-8, multiline/control and length', async (t) => {
  const f = await fixture(t);
  for (const mode of [0o644, 0o640, 0o400]) {
    await chmod(f.password, mode);
    await assert.rejects(f.run(), /Rotation input/);
  }
  await chmod(f.password, 0o600);
  for (const makeLink of [symlink, link]) {
    const path = join(f.dir, makeLink === symlink ? 'symlink' : 'hardlink');
    await makeLink(f.password, path);
    await assert.rejects(accounts(['rotate', f.current, 'ceo', path, f.next]), /Rotation input/);
    await rm(path);
  }
  for (const value of [
    Buffer.from([0xc3, 0x28]),
    'x'.repeat(1027),
    'x'.repeat(257),
    'short',
    newPassword + '\n\n',
    newPassword + '\nextra',
    newPassword + '\0',
  ]) {
    await writeFile(f.password, value);
    await assert.rejects(f.run());
  }
  await assert.rejects(stat(f.next), { code: 'ENOENT' });
});

test('input aliases and existing output are refused without changing any file', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    accounts(['rotate', f.current, 'ceo', f.password, join(f.dir, '.', 'current.json')]),
    /distinct/,
  );
  await writeFile(f.next, 'keep-existing-output', { mode: 0o600 });
  await assert.rejects(f.run(), /EEXIST/);
  assert.equal(await readFile(f.next, 'utf8'), 'keep-existing-output');
  assert.equal(await readFile(f.current, 'utf8'), JSON.stringify(v2));
});

test('CLI stdout/stderr never contain the password/hash/token on success or invalid private input', async (t) => {
  const f = await fixture(t);
  const cli = new URL('../../infra/backoffice-login/accounts.mjs', import.meta.url).pathname;
  const result = await exec(process.execPath, [
    cli,
    'rotate',
    f.current,
    'ceo',
    f.password,
    f.next,
  ]);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /live portal unchanged/);
  await writeFile(f.password, Buffer.from([0xff]));
  await assert.rejects(
    exec(process.execPath, [cli, 'rotate', f.current, 'ceo', f.password, f.next]),
    (e) => {
      for (const secret of [newPassword, oldPassword, ceo.token, manager.token, ceo.hash])
        assert.ok(!(e.stdout + e.stderr).includes(secret));
      assert.match(e.stderr, /Rotation input/);
      return true;
    },
  );
});
