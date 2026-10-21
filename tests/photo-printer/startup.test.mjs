import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';

// Real entry point and TLS, on loopback only; never connects to a printer.
test(
  'HTTPS entry point pairs with explicit CA trust and defaults to printing disabled',
  { timeout: 15000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'pickchick-photo-tls-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const cert = join(dir, 'cert.pem'),
      key = join(dir, 'key.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    const reserve = net.createServer();
    reserve.listen(0, '127.0.0.1');
    await once(reserve, 'listening');
    const port = reserve.address().port;
    await new Promise((r) => reserve.close(r));
    const config = join(dir, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        port,
        bind: '127.0.0.1',
        database: join(dir, 'jobs.sqlite'),
        tlsCert: cert,
        tlsKey: key,
        protocolConfirmed: false,
        width: 576,
      }),
    );
    const server = spawn(
      process.execPath,
      [resolve('tools/photo-printer/server.mjs'), config, '--pair'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.after(async () => {
      if (server.exitCode === null) {
        server.kill('SIGTERM');
        await once(server, 'exit');
      }
    });
    let output = '';
    const code = await new Promise((resolveCode, reject) => {
      const timer = setTimeout(() => reject(Error('Startup timeout')), 6000);
      server.stdout.on('data', (c) => {
        output += c;
        const match = output.match(/minutes\): (\d{6})/);
        if (match) {
          clearTimeout(timer);
          resolveCode(match[1]);
        }
      });
      server.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.once('exit', () => {
        clearTimeout(timer);
        reject(Error('Service exited before pairing'));
      });
    });
    const request = (path, body, token, trust = true) =>
      new Promise((ok, fail) => {
        const req = https.request(
          {
            hostname: '127.0.0.1',
            port,
            path,
            method: body ? 'POST' : 'GET',
            ...(trust ? { ca: readFileSync(cert) } : {}),
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: 'Bearer ' + token } : {}),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => ok({ status: res.statusCode, data: JSON.parse(data) }));
          },
        );
        req.on('error', fail);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    await assert.rejects(request('/v1/status', undefined, undefined, false));
    assert.equal((await request('/v1/status')).status, 401);
    const pair = await request('/v1/pair', { code });
    assert.equal(pair.status, 200);
    const status = await request('/v1/status', undefined, pair.data.token);
    assert.equal(status.status, 200);
    assert.equal(status.data.printingEnabled, false);
    assert.equal(status.data.confirmation, 'transport-only');
    assert.equal((await request('/v1/pair', { code })).status, 403);
  },
);
