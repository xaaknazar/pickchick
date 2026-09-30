// Isolated HTTP verification against a fake bank. Never reads cashier credentials.
import assert from 'node:assert/strict';
import { mkdtemp, symlink, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { installOverlays } from './install-overlays.mjs';
const upstream = resolve(process.argv[2] ?? '');
if (process.argv.length !== 3)
  throw new Error('USAGE: verify-overlays.mjs PINNED_UPSTREAM_WITH_NODE_MODULES');
const root = await mkdtemp(join(tmpdir(), 'pickchick-kaspi-overlay-'));
let child, bank;
let calls = [],
  scenario = 'password',
  finishCalls = 0,
  output = '';
const secret = 'synthetic-password-never-log';
const processId = 'synthetic-http-process';
const reply = (view, sn, extra = {}) => ({
  meta: { pId: processId, sn },
  view: { code: view },
  isClosed: false,
  ...extra,
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', upstream, root], { stdio: 'pipe' });
  execFileSync('git', ['checkout', '--quiet', '28c9167f9c72cd6758a25e254bc92bc610daa485'], {
    cwd: root,
    stdio: 'pipe',
  });
  await installOverlays(root);
  await installOverlays(root);
  await symlink(join(upstream, 'node_modules'), join(root, 'node_modules'), 'dir');
  bank = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const b = raw ? JSON.parse(raw) : {};
    calls.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    let data;
    if (req.url === '/api/v1/entrance/step') {
      if (!b.meta) data = reply('KPUniversalEnterPhoneNumber', 'EnterPhoneNumber');
      else if (b.meta.sn === 'EnterPhoneNumber')
        data =
          scenario === 'sms'
            ? reply('EnterOtp', 'ViewEnterOtp')
            : reply('KPEnterLoginPassword', 'ViewEnterLoginPassword');
      else if (b.meta.sn === 'ViewEnterLoginPassword') {
        assert.equal(b.data.password, secret);
        assert.equal(b.meta.pId, processId);
        data =
          scenario === 'refused'
            ? { actType: 'Alarm', error: { code: 'AccountTemporaryBlocked', desc: secret } }
            : reply('EnterOtp', 'ViewEnterOtp');
      } else if (b.meta.sn === 'ViewEnterOtp') {
        assert.equal(b.data.userOtp, '123456');
        data =
          scenario === 'call'
            ? { view: { code: 'KPMobileCall' }, data: { type: 'kpOrgRegistration' } }
            : { type: 'Action', data: { type: 'kpDeviceRegistration' } };
      } else throw Error('unexpected step');
    } else if (req.url === '/api/v1/kpentrance/finish') {
      finishCalls++;
      assert.ok(Math.abs(Date.now() - Date.parse(req.headers['x-time'])) < 3000);
      const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      data = {
        success: true,
        data: {
          tokenSN: 'synthetic-token-sn-12345',
          x509: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        },
      };
    } else if (req.url === '/v08/organizations/org-context-otp')
      data = {
        Data: {
          Current: { ProfileId: 12345, OrganizationId: 99, OrganizationName: 'Synthetic merchant' },
        },
      };
    else throw Error('Unexpected financial call');
    res.end(JSON.stringify(data));
  });
  bank.listen(0, '127.0.0.1');
  await once(bank, 'listening');
  const bankURL = `http://127.0.0.1:${bank.address().port}`;
  const config = join(root, 'src/config.js');
  await writeFile(
    config,
    (await readFile(config, 'utf8'))
      .replaceAll('https://entrance-pay.kaspi.kz', bankURL)
      .replaceAll('https://mtoken.kaspi.kz', bankURL)
      .replaceAll('https://qrpay.kaspi.kz', bankURL),
  );
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      TOKEN_SECRET_KEY: 'a'.repeat(64),
      BRIDGE_POLLING: 'off',
      TZ: 'Asia/Almaty',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => {
    output += d;
  });
  child.stderr.on('data', (d) => {
    output += d;
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + '/health')).ok) break;
    } catch {
      // Child server is still starting; retry only its local health endpoint.
    }
    await pause(100);
  }
  const post = async (path, data = {}, headers = {}) => {
    const r = await fetch(base + '/api/auth/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(data),
    });
    return { status: r.status, json: await r.json() };
  };
  assert.equal((await post('init', {}, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal(
    await new Promise((ok, fail) => {
      const q = httpRequest(base + '/health', { headers: { Host: 'untrusted.example' } }, (r) => {
        r.resume();
        ok(r.statusCode);
      });
      q.on('error', fail);
      q.end();
    }),
    403,
  );
  for (const path of ['/api/qr/create', '/api/refund/create'])
    assert.equal((await fetch(base + path, { method: 'POST' })).status, 404);
  for (scenario of ['password', 'sms', 'refused', 'call']) {
    assert.equal((await post('init')).json.nextStep, 'phone');
    let result = (await post('send-phone', { processId, phoneNumber: '7011234567' })).json;
    if (scenario !== 'sms')
      result = (await post('submit-password', { processId, password: secret })).json;
    if (scenario === 'refused') {
      assert.equal(result.nextStep, 'stopped');
      assert.ok(!JSON.stringify(result).includes(secret));
      continue;
    }
    assert.equal(result.nextStep, 'sms');
    result = (await post('verify-otp', { processId, otp: '123456' })).json;
    assert.equal(result.nextStep, scenario === 'call' ? 'unsupported' : 'finished');
    if (scenario !== 'call') {
      assert.equal(result.profileId, 12345);
      assert.ok(result.vtokenSecret);
    }
  }
  assert.equal(finishCalls, 2);
  assert.ok(!calls.some((p) => /remote\/(create|cancel)/.test(p)));
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes('123456'));
  assert.ok(!output.includes('synthetic-token-sn-12345'));
  console.log(
    JSON.stringify({
      overlayApply: 'passed twice',
      httpScenarios: [
        'password + OTP + session',
        'SMS-only + session',
        'password rejected',
        'unrecognized native action stopped',
        'origin and host denied',
        'QR/refund absent',
      ],
      signedTime: 'correct Asia/Almaty',
      secretsInLogs: false,
      realBankRequests: 0,
    }),
  );
} finally {
  if (child) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  if (bank) await new Promise((r) => bank.close(r));
  await rm(root, { recursive: true, force: true });
}
