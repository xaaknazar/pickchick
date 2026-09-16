import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createEdge } from '@pickchick/edge';
import { provisionStaff, setStaffPassword } from '@pickchick/local-orders';
import { createKitchenServer } from '../../apps/kitchen/server.mjs';
import { createKitchenLanGateway, privateIPv4 } from '../../infra/windows/kitchen-lan-gateway.mjs';
import { withOrderDesk } from '../helpers/orders.mjs';
import { running } from '../helpers/sync.mjs';

async function close(server) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function listen(server, address, port = 0) {
  server.listen(port, address);
  await once(server, 'listening');
  return server.address().port;
}

test('native KDS through real LAN TLS logs out and revokes the actual PostgreSQL staff session', async () => {
  for (const name of ['EDGE_DATABASE_URL', 'CLOUD_DATABASE_URL'])
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env[name]).hostname),
      'The chain acceptance requires local disposable PostgreSQL schemas',
    );
  const address = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && !i.internal && privateIPv4(i.address))?.address;
  assert.ok(address, 'A private local interface is required for the complete LAN test');
  await withOrderDesk(async (ctx) => {
    let edge, lan, native;
    const directory = await mkdtemp(join(tmpdir(), 'pickchick-kitchen-chain-'));
    try {
      const bootstrap = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.setup('kitchen'));
      await setStaffPassword(
        ctx.edge.pool,
        ctx.branch,
        { sessionId: bootstrap.session_id, token: bootstrap.token },
        'kitchen.chain',
        'synthetic-chain-password-only',
      );
      edge = await running(createEdge, ctx.edge.config);
      const passphrase = 'synthetic-chain-pfx-password-only';
      await writeFile(
        join(directory, 'openssl.cnf'),
        `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=Synthetic kitchen chain\n[ext]\nsubjectAltName=IP:${address}\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n`,
        { mode: 0o600 },
      );
      await writeFile(join(directory, 'pass'), passphrase, { mode: 0o600 });
      for (const args of [
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-config',
          join(directory, 'openssl.cnf'),
          '-keyout',
          join(directory, 'key'),
          '-out',
          join(directory, 'cert'),
        ],
        [
          'pkcs12',
          '-export',
          '-keypbe',
          'AES-256-CBC',
          '-certpbe',
          'AES-256-CBC',
          '-macalg',
          'sha256',
          '-inkey',
          join(directory, 'key'),
          '-in',
          join(directory, 'cert'),
          '-out',
          join(directory, 'pfx'),
          '-passout',
          `file:${join(directory, 'pass')}`,
        ],
      ])
        assert.equal(
          spawnSync('openssl', args, { stdio: 'pipe' }).status,
          0,
          'Synthetic TLS fixture must be generated',
        );
      const reserve = createServer();
      const lanPort = await listen(reserve, address);
      await close(reserve);
      const certificate = await readFile(join(directory, 'cert'), 'utf8');
      lan = createKitchenLanGateway({
        bindAddress: address,
        port: lanPort,
        clientAddresses: [address],
        edgePort: Number(new URL(edge.url).port),
        pfx: await readFile(join(directory, 'pfx')),
        passphrase,
      });
      await listen(lan, address, lanPort);
      native = createKitchenServer({
        edgeHost: address,
        edgePort: lanPort,
        edgeCertificatePem: certificate,
        terminalId: bootstrap.terminal_id,
      });
      const nativePort = await listen(native, '127.0.0.1');
      const origin = `http://127.0.0.1:${nativePort}`;
      const login = await fetch(origin + '/edge/v1/staff/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          login: 'kitchen.chain',
          password: 'synthetic-chain-password-only',
          terminal_id: bootstrap.terminal_id,
        }),
      });
      assert.equal(login.status, 200);
      const actor = await login.json();
      assert.equal(actor.staff_id, bootstrap.staff_id);
      assert.equal(actor.role, 'kitchen');
      const headers = {
        Authorization: `Bearer ${actor.token}`,
        'X-Staff-Session-Id': actor.session_id,
        'X-Terminal-Id': actor.terminal_id,
      };
      assert.equal((await fetch(origin + '/edge/v1/session', { headers })).status, 200);
      // A body sent directly to the LAN boundary is rejected before it could revoke the session.
      const badLogout = await new Promise((resolve, reject) => {
        const req = request(
          {
            hostname: address,
            port: lanPort,
            path: '/edge/v1/staff/logout',
            method: 'POST',
            ca: certificate,
            rejectUnauthorized: true,
            headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': '2' },
          },
          (res) => {
            res.resume();
            res.once('end', () => resolve(res.statusCode));
          },
        );
        req.once('error', reject);
        req.end('{}');
      });
      assert.equal(badLogout, 400);
      assert.equal((await fetch(origin + '/edge/v1/session', { headers })).status, 200);
      const logout = await fetch(origin + '/edge/v1/staff/logout', { method: 'POST', headers });
      assert.equal(
        logout.status,
        204,
        'Bodyless native logout must cross the TLS gateway unchanged',
      );
      assert.equal(await logout.text(), '');
      assert.equal(
        (
          await ctx.edge.pool.query('SELECT revoked FROM staff_sessions WHERE id=$1', [
            actor.session_id,
          ])
        ).rows[0].revoked,
        true,
      );
      const after = await fetch(origin + '/edge/v1/session', { headers });
      assert.equal(after.status, 401);
      assert.equal((await after.json()).code, 'UNAUTHORIZED');
      assert.deepEqual(
        (
          await ctx.edge.pool.query(
            'SELECT ordering_enabled,pos_service_mode FROM branch_config WHERE id=$1',
            [ctx.branch],
          )
        ).rows[0],
        { ordering_enabled: false, pos_service_mode: 'payment_required' },
      );
      assert.equal(
        (await ctx.edge.pool.query('SELECT count(*) FROM local_orders')).rows[0].count,
        '0',
      );
    } finally {
      await close(native);
      await close(lan);
      await edge?.app.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, false);
});
