import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:https';
import { withCatalog } from './helpers.mjs';
import { createBackofficeServer } from '../../apps/backoffice/server.mjs';
import { createStaffAccess, passwordHash } from '../../apps/backoffice/staff-auth.mjs';
const password = 'Synthetic-CEO-browser-fixture-2026';
test('CEO HTTPS browser login, finance write actor, reload and logout against isolated PostgreSQL', () =>
  withCatalog(async (c) => {
    const out = new URL('../../.local/staff-browser/', import.meta.url);
    await mkdir(out, { recursive: true });
    const dir = await mkdtemp(new URL('fixture-', out));
    const key = dir + '/key.pem',
      cert = dir + '/cert.pem';
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    let handler;
    const server = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (req, res) => handler(req, res),
    );
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const origin = `https://127.0.0.1:${server.address().port}`;
    const local = createBackofficeServer({
      apiPort: Number(new URL(c.upstream).port),
      staticPrefix: '/backoffice',
      staffAccess: createStaffAccess({
        version: 1,
        username: 'ceo',
        origin,
        token: c.manager.token,
        ...(await passwordHash(password)),
      }),
    });
    handler = local.listeners('request')[0];
    try {
      const fixture = dir + '/fixture.json';
      await writeFile(
        fixture,
        JSON.stringify({
          url: origin + '/backoffice/',
          password,
          output: new URL('.', out).pathname,
        }),
        { mode: 0o600 },
      );
      const exit = await new Promise((resolve, reject) => {
        const p = spawn(
          process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
          [new URL('browser_staff_login.py', import.meta.url).pathname, fixture],
          { stdio: 'inherit' },
        );
        const timer = setTimeout(() => p.kill('SIGTERM'), 90000);
        p.once('error', reject);
        p.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      assert.equal(exit, 0);
      const rows = (await c.cloud.pool.query('SELECT actor_id FROM bo_finance_entries')).rows;
      assert.deepEqual(rows, [{ actor_id: c.manager.actor_id }]);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(dir, { recursive: true, force: true });
    }
  }));
