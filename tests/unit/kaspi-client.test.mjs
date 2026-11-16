import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import {
  KASPI_PLAIN_HTTP,
  kaspiCall,
  kaspiCertificate,
  kaspiExpiration,
  kaspiPeerCertificate,
  kaspiPeerProbe,
  kaspiProbe,
  kaspiRequest,
  privateIPv4,
} from '@pickchick/local-orders';

// ADR-0017: the Kaspi Smart POS client against a loopback HTTPS simulator with a synthetic
// certificate (the real terminal's is issued for *.kaspipos.kz). Not the real device.
async function certificate(directory, name) {
  const config = join(directory, name + '.cnf'),
    cert = join(directory, name + '.pem'),
    key = join(directory, name + '.key');
  await writeFile(
    config,
    `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=*.kaspipos.kz\n[ext]\nsubjectAltName=DNS:*.kaspipos.kz\n`,
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
  assert.equal(result.status, 0);
  const pem = await readFile(cert, 'utf8');
  return {
    cert: pem,
    key: await readFile(key, 'utf8'),
    sha256: createHash('sha256').update(new X509Certificate(pem).raw).digest('hex'),
  };
}
const directory = await mkdtemp(join(tmpdir(), 'pickchick-kaspi-'));
const real = await certificate(directory, 'terminal');
const impostor = await certificate(directory, 'impostor');
test.after(() => rm(directory, { recursive: true, force: true }));

async function terminal(tls, handler) {
  const seen = [];
  const server = createServer(tls, (request, response) => {
    seen.push({
      url: request.url,
      token: request.headers.accesstoken ?? null,
      method: request.method,
    });
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    link: (sha256 = real.sha256) => ({
      host: '127.0.0.1',
      port: server.address().port,
      certificateSha256: sha256,
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

test('payment over pinned TLS: GET with the token header, answer data', async () => {
  const sim = await terminal(real, (request, response) =>
    json(response, 200, { statusCode: 0, data: { processId: '123', status: 'wait' } }),
  );
  try {
    const answer = await kaspiRequest(
      sim.link(),
      'payment',
      { amount: '2990' },
      { token: 'tok-12345678' },
    );
    assert.deepEqual(answer, { kind: 'ok', data: { processId: '123', status: 'wait' } });
    assert.deepEqual(sim.seen, [
      { url: '/v2/payment?amount=2990', token: 'tok-12345678', method: 'GET' },
    ]);
    assert.equal(await kaspiPeerCertificate('127.0.0.1', sim.link().port), real.sha256);
  } finally {
    await sim.close();
  }
});

test('another certificate: nothing is sent', async () => {
  const sim = await terminal(impostor, (request, response) => json(response, 200, { data: {} }));
  try {
    assert.deepEqual(
      await kaspiRequest(sim.link(), 'payment', { amount: '1' }, { token: 'tok-12345678' }),
      {
        kind: 'unreachable',
        reason: 'CERTIFICATE',
      },
    );
    assert.equal(sim.seen.length, 0);
  } finally {
    await sim.close();
  }
});

test('terminal errors are refused with their code; a silent or broken answer is lost', async () => {
  let mode = 'busy';
  const sim = await terminal(real, (request, response) => {
    if (mode === 'busy')
      return json(response, 400, {
        statusCode: 107,
        errorText: 'Could not register transaction. Last operation was not completed.',
      });
    if (mode === 'auth')
      return json(response, 401, { statusCode: 999, errorText: 'Authorization failed' });
    if (mode === 'garbage') {
      response.writeHead(200);
      return response.end('<html>');
    }
    // silent: never answers
  });
  try {
    assert.deepEqual(
      await kaspiRequest(sim.link(), 'payment', { amount: '1' }, { token: 'tok-12345678' }),
      {
        kind: 'refused',
        httpStatus: 400,
        statusCode: 107,
        message: 'Could not register transaction. Last operation was not completed.',
      },
    );
    mode = 'auth';
    assert.equal(
      (await kaspiRequest(sim.link(), 'status', { processId: '1' }, { token: 'tok-12345678' }))
        .httpStatus,
      401,
    );
    mode = 'garbage';
    assert.deepEqual(await kaspiRequest(sim.link(), 'payment', { amount: '1' }), {
      kind: 'lost',
      reason: 'ANSWER',
    });
    mode = 'silent';
    assert.deepEqual(
      await kaspiRequest(sim.link(), 'payment', { amount: '1' }, { timeoutMs: 300 }),
      { kind: 'lost', reason: 'TIMEOUT' },
    );
  } finally {
    await sim.close();
  }
});

test('nothing listening: unreachable; only private IPv4 on port 8080; strict parameters', async () => {
  assert.deepEqual(
    await kaspiRequest(
      { host: '127.0.0.1', port: 1, certificateSha256: real.sha256 },
      'deviceinfo',
      {},
    ),
    { kind: 'unreachable', reason: 'CONNECT' },
  );
  await assert.rejects(
    kaspiCall({ host: '127.0.0.1', port: 8080, certificateSha256: real.sha256 }, 'status', {}),
    /KASPI_LINK_INVALID/,
  );
  await assert.rejects(
    kaspiCall({ host: '192.168.2.5', port: 443, certificateSha256: real.sha256 }, 'status', {}),
    /KASPI_LINK_INVALID/,
  );
  await assert.rejects(kaspiCertificate('8.8.8.8'), /KASPI_HOST_INVALID/);
  await assert.rejects(
    kaspiRequest({ host: '127.0.0.1', port: 1, certificateSha256: real.sha256 }, 'status', {
      processId: 'a&b=c',
    }),
    /KASPI_PARAM_INVALID/,
  );
  assert.equal(privateIPv4('192.168.2.66'), true);
  assert.equal(privateIPv4('172.32.0.1'), false);
});

// 16.11.2026: the test point's Smart POS 3 (application 2.64.9) serves the API as plain HTTP on 8080
// and answers no TLS. Simulated here by a plain HTTP server with the observed deviceinfo answer.
test('plain HTTP terminal: probe says http, a plain link sends the token, TLS links refuse it', async () => {
  const seen = [];
  const server = createHttpServer((request, response) => {
    seen.push({ url: request.url, token: request.headers.accesstoken ?? null });
    if (request.url.startsWith('/v2/deviceinfo'))
      return json(response, 200, {
        data: { posNum: '0', serialNum: 'ND-SYN', terminalId: 'TID-SYN' },
        statusCode: 0,
      });
    if (request.url.startsWith('/v2/payment'))
      return json(response, 200, { data: { processId: 'p-1', status: 'wait' }, statusCode: 0 });
    json(response, 404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    assert.deepEqual(await kaspiPeerProbe('127.0.0.1', port), {
      transport: 'http',
      terminalId: 'TID-SYN',
      serialNumber: 'ND-SYN',
    });
    const plain = { host: '127.0.0.1', port, certificateSha256: KASPI_PLAIN_HTTP };
    assert.deepEqual(
      await kaspiRequest(plain, 'payment', { amount: '100' }, { token: 'tok-12345' }),
      {
        kind: 'ok',
        data: { processId: 'p-1', status: 'wait' },
      },
    );
    assert.deepEqual(seen.at(-1), { url: '/v2/payment?amount=100', token: 'tok-12345' });
    // A link pinned to a certificate never falls back to plain HTTP: nothing is sent.
    const before = seen.length;
    const pinned = await kaspiRequest(
      { host: '127.0.0.1', port, certificateSha256: real.sha256 },
      'payment',
      { amount: '100' },
      { token: 'tok-12345', timeoutMs: 2000 },
    );
    assert.equal(pinned.kind, 'unreachable');
    assert.equal(seen.length, before);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await assert.rejects(kaspiProbe('8.8.8.8'), /KASPI_HOST_INVALID/);
});

test('probe of a TLS terminal reports its certificate', async () => {
  const sim = await terminal({ cert: real.cert, key: real.key }, (request, response) =>
    json(response, 404, {}),
  );
  try {
    assert.deepEqual(await kaspiPeerProbe('127.0.0.1', sim.link().port), {
      transport: 'https',
      certificateSha256: real.sha256,
    });
  } finally {
    await sim.close();
  }
});

test('expirationDate is the terminal local time, UTC+5', () => {
  assert.equal(kaspiExpiration('2024-09-25 17:27:03').toISOString(), '2024-09-25T12:27:03.000Z');
  assert.equal(kaspiExpiration('25.09.2024'), null);
  assert.equal(kaspiExpiration(undefined), null);
});
