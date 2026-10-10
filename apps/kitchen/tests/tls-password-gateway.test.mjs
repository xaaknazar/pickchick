import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { allowed, createKitchenServer, validateUpstream } from '../server.mjs';
import { pathToFileURL } from 'node:url';

// Desktop build copies the canonical server beside security.mjs. Use a private
// fixture for the same module pair; a clean web checkout has no generated gateway.
const desktopFixture = await mkdtemp(join(tmpdir(), 'pickchick-kitchen-security-'));
after(() => rm(desktopFixture, { recursive: true, force: true }));
await copyFile(
  new URL('../../kitchen-desktop/security.mjs', import.meta.url),
  join(desktopFixture, 'security.mjs'),
);
await copyFile(new URL('../server.mjs', import.meta.url), join(desktopFixture, 'gateway.mjs'));
await copyFile(
  new URL('../terminal-cookie.mjs', import.meta.url),
  join(desktopFixture, 'terminal-cookie.mjs'),
);
const { validateConfig, isAllowedRendererRequest, APP_ORIGIN } = await import(
  pathToFileURL(join(desktopFixture, 'security.mjs')).href
);

const privateIP = Object.values(networkInterfaces())
  .flat()
  .find(
    (v) =>
      v &&
      v.family === 'IPv4' &&
      !v.internal &&
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v.address),
  )?.address;
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
async function certificate(directory, name, ip) {
  const config = join(directory, name + '.cnf'),
    cert = join(directory, name + '.pem'),
    key = join(directory, name + '.key');
  await writeFile(
    config,
    `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Synthetic kitchen TLS\n[ext]\nsubjectAltName=IP:${ip}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
    { mode: 0o600 },
  );
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-config',
      config,
      '-out',
      cert,
      '-keyout',
      key,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, 'Synthetic certificate generation must succeed');
  return { cert: await readFile(cert, 'utf8'), key: await readFile(key, 'utf8') };
}

test(
  'pinned LAN TLS authenticates only configured peer, protects password route and bounds responses',
  { skip: !privateIP && 'No private IPv4 available for an actual LAN TLS listener' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pickchick-kds-tls-'));
    let edge, gateway;
    try {
      const trusted = await certificate(directory, 'trusted', privateIP);
      const impostor = await certificate(directory, 'impostor', privateIP);
      const terminalId = randomUUID();
      const config = { edgeHost: privateIP, edgeCertificatePem: trusted.cert, terminalId };
      assert.equal(validateConfig(config).edgeHost, privateIP);
      for (const bad of [
        { edgeHost: '8.8.8.8' },
        { edgeHost: '127.0.0.1' },
        { edgeHost: '169.254.1.1' },
        { edgeHost: 'localhost' },
        { edgeHost: '192.168.01.2' },
        { edgeHost: '::1' },
        { edgeCertificatePem: trusted.cert + trusted.cert },
        { edgeCertificatePem: trusted.key },
        { edgeCertificatePem: trusted.cert + trusted.key },
        { edgeCertificatePem: undefined },
        { edgeHost: undefined },
        { edgeCertificatePem: 'broken' },
      ])
        assert.throws(() => validateUpstream({ ...config, ...bad }), /INVALID_KITCHEN_CONFIG/);
      const foreign = await certificate(directory, 'foreign', '10.255.254.253');
      assert.throws(
        () => validateUpstream({ ...config, edgeCertificatePem: foreign.cert }),
        /INVALID_KITCHEN_CONFIG/,
      );
      let mode = 'normal';
      const seen = [];
      edge = createServer(trusted, async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        seen.push({
          path: req.url,
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (mode === 'hang') return;
        if (mode === 'no-content') {
          res.writeHead(205);
          res.end();
          return;
        }
        if (mode === 'redirect') {
          res.writeHead(302, { Location: 'http://untrusted.invalid/' });
          res.end();
          return;
        }
        if (req.url === '/edge/v1/staff/logout') {
          res.writeHead(204);
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Set-Cookie', 'do-not-forward=1');
        if (mode === 'limit') {
          res.writeHead(429, { 'Retry-After': '60' });
          res.end('{"code":"AUTH_RATE_LIMITED"}');
          return;
        }
        if (mode === 'large') {
          res.write('{"text":"');
          res.end('x'.repeat(3 * 1024 * 1024) + '"}');
          return;
        }
        res.end('{"enabled":true}');
      });
      edge.listen(0, privateIP);
      await once(edge, 'listening');
      gateway = createKitchenServer({ ...config, edgePort: edge.address().port, timeoutMs: 500 });
      gateway.listen(0, '127.0.0.1');
      await once(gateway, 'listening');
      const url = `http://127.0.0.1:${gateway.address().port}`;
      const publicConfig = await (await fetch(url + '/config.json')).json();
      assert.deepEqual(publicConfig, { branchLabel: 'Локальная точка', terminalId });
      assert(!JSON.stringify(publicConfig).includes(trusted.cert));
      const loginBody = {
        login: 'kitchen.synthetic',
        password: 'Synthetic-password',
        terminal_id: terminalId,
      };
      const login = (body = loginBody, extra = {}) =>
        fetch(url + '/edge/v1/staff/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...extra },
          body: JSON.stringify(body),
        });
      assert.equal((await login(loginBody, { Origin: 'https://external.invalid' })).status, 403);
      assert.equal((await login({ ...loginBody, terminal_id: randomUUID() })).status, 400);
      assert.equal((await login({ ...loginBody, password: 'x'.repeat(2048) })).status, 413);
      assert.equal(seen.length, 0);
      let response = await login(loginBody, {
        Authorization: 'Bearer synthetic',
        Cookie: 'private=1',
        'X-Staff-Session-Id': terminalId,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(seen[0].headers.authorization, undefined);
      assert.equal(seen[0].headers.cookie, undefined);
      assert.equal(seen[0].headers['x-staff-session-id'], undefined);
      assert.deepEqual(JSON.parse(seen[0].body), loginBody);
      assert(allowed('POST', '/edge/v1/staff/login'));
      assert(!allowed('POST', '/edge/v1/staff/login?redirect=bad'));
      assert(isAllowedRendererRequest(APP_ORIGIN + '/edge/v1/staff/login', 'POST'));
      assert(
        !isAllowedRendererRequest(
          `https://${privateIP}:${edge.address().port}/edge/v1/staff/login`,
          'POST',
        ),
      );
      mode = 'limit';
      response = await login();
      assert.equal(response.status, 429);
      assert.equal(response.headers.get('retry-after'), '60');
      mode = 'normal';
      response = await fetch(url + '/edge/v1/staff/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer synthetic' },
      });
      assert.equal(response.status, 204);
      assert.equal(await response.text(), '');
      assert.equal(seen.at(-1).method, 'POST');
      assert.equal(seen.at(-1).body, '');
      for (const [nextMode, expected] of [
        ['large', 502],
        ['no-content', 502],
        ['redirect', 504],
        ['hang', 504],
      ]) {
        mode = nextMode;
        response = await fetch(url + '/edge/v1/fulfillment/config');
        assert.equal(response.status, expected, nextMode);
      }
      mode = 'normal';
      edge.setSecureContext(impostor);
      const before = seen.length;
      response = await login();
      assert.equal(response.status, 504);
      assert.equal(
        seen.length,
        before,
        'wrong TLS certificate receives no password or HTTP request',
      );
    } finally {
      if (gateway) await close(gateway);
      if (edge) await close(edge);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
