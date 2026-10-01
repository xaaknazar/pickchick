import assert from 'node:assert/strict';
import '../../infra/payments/kaspi-bridge/container.test.mjs';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  KaspiBridgeClient,
  findByReference,
  kaspiInvoiceOutcome,
  kaspiInvoiceComment,
  kaspiMinor,
  kaspiPhone,
  kaspiRemoteConfig,
  verifyKaspiBridgeWebhook,
} from '../../packages/commerce-core/dist/index.js';
import { readCustomerPaymentPhone } from '../../packages/customer-identity/dist/index.js';

const secret = 'synthetic_kaspi_bridge_webhook_secret_0001';
const base = {
  KASPI_REMOTE_ENABLED: 'true',
  KASPI_BRIDGE_URL: 'http://127.0.0.1:3931',
  KASPI_BRIDGE_WEBHOOK_SECRET: secret,
  KASPI_REMOTE_ACCOUNT_ID: randomUUID(),
};
const session = {
  KASPI_SESSION_TOKEN_SN: 'synthetic-token-sn',
  KASPI_SESSION_VTOKEN_SECRET: Buffer.from('synthetic-encrypted-secret').toString('base64'),
  KASPI_SESSION_PROFILE_ID: '12345',
};

test('configuration is opt-in, loopback-only and validates every secret shape', () => {
  assert.equal(kaspiRemoteConfig({}), null);
  assert.equal(kaspiRemoteConfig({ KASPI_REMOTE_ENABLED: 'false' }), null);
  assert.throws(() => kaspiRemoteConfig({ KASPI_REMOTE_ENABLED: 'yes' }), { code: 'INVALID' });
  const ok = kaspiRemoteConfig({ ...base, ...session });
  assert.equal(ok.bridgeUrl, 'http://127.0.0.1:3931');
  assert.equal(ok.invoiceTtlSeconds, 180);
  assert.equal(ok.session.profileId, '12345');
  assert.equal(kaspiRemoteConfig(base).session, null);
  for (const bad of [
    { KASPI_BRIDGE_URL: 'http://10.0.0.5:3931' },
    { KASPI_BRIDGE_URL: 'https://127.0.0.1:3931' },
    { KASPI_BRIDGE_URL: 'http://user:pw@127.0.0.1:3931' },
    { KASPI_BRIDGE_URL: 'http://kaspi.example.com' },
    { KASPI_BRIDGE_WEBHOOK_SECRET: 'short' },
    { KASPI_REMOTE_ACCOUNT_ID: 'not-a-uuid' },
    { KASPI_INVOICE_TTL_SECONDS: '30' },
    { KASPI_INVOICE_TTL_SECONDS: '10.5' },
    { ...session, KASPI_SESSION_PROFILE_ID: '' },
    { ...session, KASPI_SESSION_TOKEN_SN: 'x' },
  ])
    assert.throws(() => kaspiRemoteConfig({ ...base, ...bad }), { code: 'INVALID' });
});

test('phones, amounts and statuses are mapped conservatively', () => {
  assert.equal(kaspiPhone('+77011234567'), '77011234567');
  for (const bad of ['+76011234567', '87011234567', '+7701123456', '+1 7011234567'])
    assert.equal(kaspiPhone(bad), null);
  assert.equal(kaspiMinor(1500), '150000');
  assert.equal(kaspiMinor('1500.5'), '150050');
  for (const [amount, minor] of [
    ['100 ₸', '10000'],
    ['1 500 ₸', '150000'],
    ['1\u00a0500,50\u00a0₸', '150050'],
    ['1\u202f500.5 ₸', '150050'],
  ])
    assert.equal(kaspiMinor(amount), minor);
  for (const bad of [
    '100 $',
    '100 KZT',
    '-100 ₸',
    '1 00 ₸',
    '1,000 ₸',
    '100₸',
    '100 ₸ extra',
    '1e3 ₸',
    '0 ₸',
  ])
    assert.equal(kaspiMinor(bad), null);
  for (const bad of [0, -1, '1e3', 1.234, 'abc', null]) assert.equal(kaspiMinor(bad), null);
  assert.equal(kaspiInvoiceOutcome('Processed'), 'captured');
  assert.equal(kaspiInvoiceOutcome('RemotePaymentCreated'), 'pending');
  for (const s of ['RemotePaymentCanceled', 'RemotePaymentRejected', 'Expired'])
    assert.equal(kaspiInvoiceOutcome(s), 'failed');
  // An unfamiliar status is never read as a failure: money may still arrive.
  for (const s of ['Wait', 'Error', 'SomethingNew', undefined, 5])
    assert.equal(kaspiInvoiceOutcome(s), 'unknown');
});

test('bridge webhook requires the exact-byte HMAC and yields only an operation id', () => {
  const body = Buffer.from(
    JSON.stringify({ event: 'payment.success', paymentId: '9876543', type: 'invoice' }),
  );
  const sign = (raw, key = secret) =>
    'sha256=' + createHmac('sha256', key).update(raw).digest('hex');
  assert.deepEqual(verifyKaspiBridgeWebhook(body, sign(body), secret), { operationId: '9876543' });
  const numeric = Buffer.from(JSON.stringify({ paymentId: 42, type: 'invoice' }));
  assert.equal(verifyKaspiBridgeWebhook(numeric, sign(numeric), secret).operationId, '42');
  const altered = Buffer.from(body.toString().replace('9876543', '9876544'));
  assert.throws(() => verifyKaspiBridgeWebhook(altered, sign(body), secret), {
    code: 'SIGNATURE',
  });
  assert.throws(() => verifyKaspiBridgeWebhook(body, sign(body, 'other-secret'), secret), {
    code: 'SIGNATURE',
  });
  assert.throws(() => verifyKaspiBridgeWebhook(body, undefined, secret), { code: 'SIGNATURE' });
  const qr = Buffer.from(JSON.stringify({ paymentId: '1', type: 'qr' }));
  assert.throws(() => verifyKaspiBridgeWebhook(qr, sign(qr), secret), { code: 'INVALID' });
  for (const value of ['null', '[]', 'true']) {
    const raw = Buffer.from(value);
    assert.throws(() => verifyKaspiBridgeWebhook(raw, sign(raw), secret), { code: 'INVALID' });
  }
  const junk = Buffer.from('not json');
  assert.throws(() => verifyKaspiBridgeWebhook(junk, sign(junk), secret), { code: 'INVALID' });
});

test('history search needs the reference in a text field and an operation id', () => {
  const history = {
    Items: [
      { QrOperationId: 11, Comment: 'PickChick ABCDEFGH23', Amount: 1000 },
      { QrOperationId: 12, Comment: 'PickChick ZZZZZZZZZZ', Amount: 1000 },
      { Comment: 'PickChick ABCDEFGH23' },
      { QrOperationId: 13, Comment: 'PickChick ABCDEFGH234' },
    ],
  };
  const found = findByReference(history, 'ABCDEFGH23');
  assert.equal(found.length, 1);
  assert.equal(found[0].QrOperationId, 11);
  assert.deepEqual(findByReference([], 'ABCDEFGH23'), []);
});

test('invoice message uses names and quantities without customer data and preserves recovery', () => {
  const comment = kaspiInvoiceComment('ABCDEFGH23', {
    customerId: 'private-customer',
    customerComment: 'private note',
    lines: [
      { title: 'Burger Combo', quantity: 2 },
      { title: 'Coca-Cola 0,5 л', quantity: 1 },
    ],
  });
  assert.equal(comment, 'PickChick ABCDEFGH23: Burger Combo ×2; Coca-Cola 0,5 л ×1');
  assert.equal(findByReference([{ Id: 14, Comment: comment }], 'ABCDEFGH23').length, 1);
  for (const text of [
    'PickChick ABCDEFGH234: Burger',
    'prefix ' + comment,
    'PickChick ABCDEFGH23XYZ',
  ])
    assert.deepEqual(findByReference([{ Id: 14, Comment: text }], 'ABCDEFGH23'), []);
  assert.equal(kaspiInvoiceComment('ABCDEFGH23', { lines: [] }), 'PickChick ABCDEFGH23');
  assert.equal(kaspiInvoiceComment('ABCDEFGH23', null), 'PickChick ABCDEFGH23');
  assert.equal(
    kaspiInvoiceComment('ABCDEFGH23', { lines: [{ title: '  Чай\n  манго\u200b ', quantity: 1 }] }),
    'PickChick ABCDEFGH23: Чай манго ×1',
  );
});

test('long invoice messages keep whole items where possible and never split Unicode pairs', () => {
  for (const count of [1, 2, 10, 100]) {
    for (const title of ['Куриный бургер', '🍔'.repeat(300)]) {
      const comment = kaspiInvoiceComment('ABCDEFGH23', {
        lines: Array.from({ length: count }, () => ({ title, quantity: 2 })),
      });
      assert.ok(comment.length <= 255);
      assert.ok(comment.isWellFormed());
      assert.equal(findByReference([{ Id: 14, Comment: comment }], 'ABCDEFGH23').length, 1);
      if (count > 1 && title.length > 255) assert.ok(comment.endsWith(`ещё ${count - 1} поз.`));
    }
  }
});

test('bridge client separates unsent, uncertain, session, rejected and success answers', async () => {
  const config = kaspiRemoteConfig({ ...base, ...session });
  const calls = [];
  const reply = (status, body) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  const run = async (answer) => {
    const client = new KaspiBridgeClient(config, async (url, init) => {
      calls.push({ url, init });
      return answer();
    });
    return client.createInvoice('77011234567', 1000, 'PickChick ABCDEFGH23');
  };
  assert.deepEqual(await run(() => reply(200, { StatusCode: 0, Data: { QrOperationId: 5 } })), {
    kind: 'ok',
    data: { QrOperationId: 5 },
  });
  const sent = calls.at(-1);
  assert.equal(sent.url, 'http://127.0.0.1:3931/api/invoice/create');
  assert.equal(sent.init.headers['X-Token-SN'], 'synthetic-token-sn');
  assert.deepEqual(JSON.parse(sent.init.body), {
    phoneNumber: '77011234567',
    amount: 1000,
    comment: 'PickChick ABCDEFGH23',
  });
  assert.deepEqual(await run(() => reply(200, { StatusCode: 7, Data: null })), {
    kind: 'rejected',
    statusCode: 7,
  });
  assert.deepEqual(await run(() => reply(200, { StatusCode: -101001 })), { kind: 'session' });
  assert.deepEqual(await run(() => reply(401, { error: 'Missing X-Token-SN header.' })), {
    kind: 'session',
  });
  assert.deepEqual(await run(() => reply(500, { error: 'socket hang up' })), {
    kind: 'uncertain',
  });
  assert.deepEqual(await run(() => reply(200, '<html>')), { kind: 'uncertain' });
  assert.deepEqual(await run(() => reply(200, { StatusCode: 0 })), { kind: 'uncertain' });
  assert.deepEqual(
    await run(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }),
    { kind: 'unsent' },
  );
  assert.deepEqual(
    await run(() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }),
    { kind: 'uncertain' },
  );
  const cancel = new KaspiBridgeClient(config, async () => reply(200, { StatusCode: 0 }));
  assert.deepEqual(await cancel.cancel('5'), { kind: 'ok', data: {} });
  assert.deepEqual(await cancel.details('5'), { kind: 'uncertain' });
  const history = new KaspiBridgeClient(config, async (url, init) => {
    calls.push({ url, init });
    return reply(200, { StatusCode: 0, Data: [] });
  });
  await history.history();
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { maxResult: 200 });
  const noSession = new KaspiBridgeClient(kaspiRemoteConfig(base), async () => {
    throw new Error('must not be called');
  });
  assert.deepEqual(await noSession.details('1'), { kind: 'session' });
});

test('payment phone is read only for an active customer with auth enabled', async () => {
  const key = randomBytes(32),
    id = randomUUID();
  const seal = (value) => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`phone:${id}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map((v) => v.toString('base64url')).join('.');
  };
  let row = { phone_cipher: seal('+77011234567'), deleted_at: null };
  const pool = { query: async () => ({ rows: row ? [row] : [] }) };
  const options = { enabled: true, piiKey: key };
  assert.equal(await readCustomerPaymentPhone(pool, options, id), '+77011234567');
  assert.equal(await readCustomerPaymentPhone(pool, { enabled: false }, id), null);
  assert.equal(await readCustomerPaymentPhone(pool, options, 'bad-id'), null);
  row = { phone_cipher: null, deleted_at: new Date() };
  assert.equal(await readCustomerPaymentPhone(pool, options, id), null);
  row = null;
  assert.equal(await readCustomerPaymentPhone(pool, options, id), null);
});

test('cashier login helper accepts only a KZ mobile and writes only the three session values', async () => {
  const { cashierPhone, sessionEnv } =
    await import('../../infra/payments/kaspi-bridge/kaspi-login.mjs');
  assert.equal(cashierPhone('+7 701 123 45 67'), '7011234567');
  assert.equal(cashierPhone('87011234567'), '7011234567');
  assert.equal(cashierPhone('7011234567'), '7011234567');
  assert.equal(cashierPhone('+7 601 123 45 67'), null);
  const env = sessionEnv({
    tokenSN: 'synthetic-token-sn',
    vtokenSecret: Buffer.from('synthetic-encrypted-secret').toString('base64'),
    profileId: 12345,
    phone: '77011234567',
  });
  assert.equal(env.split('\n').filter(Boolean).length, 3);
  assert.ok(!env.includes('77011234567'));
  assert.throws(() => sessionEnv({ tokenSN: 'x\nINJECT=1', vtokenSecret: 'y', profileId: 1 }));
});

test('session check rejects invoice arguments before any bridge request', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../infra/payments/kaspi-bridge/kaspi-check.mjs', import.meta.url)),
      '--invoice-phone',
      '+77011234567',
    ],
    { encoding: 'utf8', env: { ...process.env, ...base, ...session } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /READ_ONLY_CHECK_NO_ARGUMENTS/);
  assert.ok(!result.stderr.includes('77011234567'));
  assert.equal(result.stdout, '');
});

const authModule = '../../infra/payments/kaspi-bridge/entrance-flow.mjs';
const authBody = (step, extra = {}) => {
  const mapping = {
    phone: ['KPUniversalEnterPhoneNumber', 'EnterPhoneNumber'],
    password: ['KPEnterLoginPassword', 'ViewEnterLoginPassword'],
    sms: ['EnterOtp', 'ViewEnterOtp'],
  };
  const [view, sn] = mapping[step];
  return {
    meta: { pId: 'synthetic-process', sn },
    view: { code: view },
    isClosed: false,
    ...extra,
  };
};
async function entranceFixture(replies) {
  const { EntranceFlow } = await import(authModule);
  const calls = [],
    finishes = [];
  let clock = 0;
  const flow = new EntranceFlow({
    init: async () => ({ session: { processId: 'synthetic-process' }, body: authBody('phone') }),
    submit: async (_session, payload) => {
      calls.push(payload);
      const next = replies.shift();
      return typeof next === 'function' ? next() : next;
    },
    finish: async () => {
      finishes.push(true);
      return {
        tokenSN: 'synthetic-token-sn',
        vtokenSecret: Buffer.from('synthetic-encrypted-secret').toString('base64'),
        profileId: 12345,
      };
    },
    now: () => clock,
  });
  return {
    flow,
    calls,
    finishes,
    expire: () => {
      clock = 600001;
    },
  };
}

test('password entrance follows server metadata, then OTP, without retaining password', async () => {
  const { flow, calls, finishes } = await entranceFixture([
    authBody('password'),
    authBody('sms'),
    { view: { code: 'KPMobileCall' }, data: { type: 'kpDeviceRegistration' } },
  ]);
  assert.equal((await flow.start()).nextStep, 'phone');
  assert.equal(
    (await flow.credential('phone', 'synthetic-process', '7011234567')).nextStep,
    'password',
  );
  const reply = await flow.credential('password', 'synthetic-process', 'synthetic-password');
  assert.equal(reply.nextStep, 'sms');
  assert.deepEqual(calls[1], {
    meta: { pId: 'synthetic-process', sn: 'ViewEnterLoginPassword' },
    data: { password: 'synthetic-password' },
    actType: 'Success',
  });
  assert.ok(!JSON.stringify(flow.session).includes('synthetic-password'));
  assert.ok(!JSON.stringify(reply).includes('synthetic-password'));
  const result = await flow.credential('sms', 'synthetic-process', '123456');
  assert.equal(result.nextStep, 'finished');
  assert.equal(finishes.length, 1);
  assert.equal(flow.session, null);
});

test('SMS-only cashier still works; no password is requested', async () => {
  const { loginThroughBridge } = await import('../../infra/payments/kaspi-bridge/kaspi-login.mjs');
  const { flow } = await entranceFixture([
    authBody('sms'),
    { data: { type: 'kpDeviceRegistration' } },
  ]);
  const result = await loginThroughBridge({
    phone: '7011234567',
    readPassword: () => assert.fail('unexpected password'),
    readOtp: async () => '123456',
    request: (path, data) =>
      path.endsWith('/init')
        ? flow.start()
        : flow.credential(
            path.endsWith('send-phone') ? 'phone' : 'sms',
            data.processId,
            data.phoneNumber ?? data.otp,
          ),
  });
  assert.equal(result.success, true);
});

test('password helper asks each credential once and never treats unknown challenge as success', async () => {
  const { loginThroughBridge } = await import('../../infra/payments/kaspi-bridge/kaspi-login.mjs');
  let passwordReads = 0,
    otpReads = 0;
  const { flow, finishes } = await entranceFixture([
    authBody('password'),
    { view: { code: 'KPMobileCall' }, data: { type: 'kpDeviceRegistration' } },
  ]);
  await assert.rejects(
    loginThroughBridge({
      phone: '7011234567',
      readPassword: async () => {
        passwordReads++;
        return 'synthetic-password';
      },
      readOtp: () => {
        otpReads++;
        return '123456';
      },
      request: (path, data) =>
        path.endsWith('/init')
          ? flow.start()
          : flow.credential(
              path.endsWith('send-phone') ? 'phone' : 'password',
              data.processId,
              data.phoneNumber ?? data.password,
            ),
    }),
    /ADDITIONAL_CONFIRMATION_REQUIRED/,
  );
  assert.equal(passwordReads, 1);
  assert.equal(otpReads, 0);
  assert.equal(finishes.length, 0);
});

test('wrong process, expired process, wrong step and concurrent attempts never reach bank', async () => {
  let resolve;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const { flow, calls, expire } = await entranceFixture([authBody('password'), () => pending]);
  await flow.start();
  await assert.rejects(flow.credential('phone', 'wrong', '7011234567'), /PROCESS_INVALID/);
  await assert.rejects(
    flow.credential('password', 'synthetic-process', 'pw'),
    /CHALLENGE_MISMATCH/,
  );
  assert.equal(calls.length, 0);
  await flow.credential('phone', 'synthetic-process', '7011234567');
  const first = flow.credential('password', 'synthetic-process', 'pw');
  await assert.rejects(flow.credential('password', 'synthetic-process', 'pw'), /ENTRANCE_BUSY/);
  await assert.rejects(flow.start(), /ENTRANCE_BUSY/);
  assert.equal(calls.length, 2);
  resolve(authBody('sms'));
  await first;
  expire();
  await assert.rejects(flow.credential('sms', 'synthetic-process', '123456'), /PROCESS_EXPIRED/);
  assert.equal(calls.length, 2);
});

test('bank refusal or lost password response stops flow without automatic retry or secret exposure', async () => {
  for (const reply of [
    () => {
      throw new Error('private provider payload: secret');
    },
    authBody('password', {
      actType: 'Alarm',
      error: { code: 'AccountTemporaryBlocked', desc: 'secret' },
    }),
    authBody('password', { isClosed: true }),
    authBody('sms', { meta: { pId: 'wrong', sn: 'ViewEnterOtp' } }),
  ]) {
    const { flow, calls, finishes } = await entranceFixture([authBody('password'), reply]);
    await flow.start();
    await flow.credential('phone', 'synthetic-process', '7011234567');
    let result;
    try {
      result = await flow.credential('password', 'synthetic-process', 'synthetic-password');
    } catch (e) {
      result = e.message;
    }
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.ok(!JSON.stringify(result).includes('synthetic-password'));
    await assert.rejects(
      flow.credential('password', 'synthetic-process', 'synthetic-password'),
      /PROCESS_INVALID/,
    );
    assert.equal(calls.length, 2);
    assert.equal(finishes.length, 0);
  }
});

test('phone / password / SMS validators reject malformed inputs before bank request', async () => {
  const { flow, calls } = await entranceFixture([authBody('password'), authBody('sms')]);
  await flow.start();
  await assert.rejects(
    flow.credential('phone', 'synthetic-process', '77011234567'),
    /CREDENTIAL_INVALID/,
  );
  await flow.credential('phone', 'synthetic-process', '7011234567');
  for (const bad of ['', ' ', {}, 'x'.repeat(257)])
    await assert.rejects(
      flow.credential('password', 'synthetic-process', bad),
      /CREDENTIAL_INVALID/,
    );
  await flow.credential('password', 'synthetic-process', 'pw');
  await assert.rejects(flow.credential('sms', 'synthetic-process', '12ab'), /CREDENTIAL_INVALID/);
  assert.equal(calls.length, 2);
});

test('unknown native actions and biometric challenges are not bypassed after OTP', async () => {
  for (const code of ['KPMobileCall', 'FaceVerification', 'Unknown']) {
    const { flow, finishes } = await entranceFixture([
      authBody('sms'),
      {
        view: { code },
        data: { type: 'unknown' },
      },
    ]);
    await flow.start();
    await flow.credential('phone', 'synthetic-process', '7011234567');
    assert.equal(
      (await flow.credential('sms', 'synthetic-process', '123456')).nextStep,
      'unsupported',
    );
    assert.equal(finishes.length, 0);
  }
});

test('password file must be a private regular file and not a symlink', async () => {
  const { mkdtemp, writeFile, chmod, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { privateFile } = await import('../../infra/payments/kaspi-bridge/kaspi-login.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'kaspi-private-test-'));
  try {
    const file = join(dir, 'password');
    await writeFile(file, 'synthetic-password', { mode: 0o600 });
    assert.equal(await privateFile(file), 'synthetic-password');
    await chmod(file, 0o644);
    await assert.rejects(privateFile(file), /PRIVATE_FILE_PERMISSIONS/);
    await chmod(file, 0o600);
    await symlink(file, join(dir, 'link'));
    await assert.rejects(privateFile(join(dir, 'link')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bank request timestamp preserves the instant in Almaty, UTC and fractional-offset zones', () => {
  const url = new URL('../../infra/payments/kaspi-bridge/bank-time.mjs', import.meta.url).href;
  for (const timezone of ['Asia/Almaty', 'UTC', 'Asia/Kolkata', 'America/New_York']) {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { bankTimestamp } from ${JSON.stringify(url)};
       const d = new Date('2026-09-29T08:34:56.123Z');
       if (Date.parse(bankTimestamp(d)) !== d.getTime()) process.exit(1);
       console.log(bankTimestamp(d));`,
      ],
      { env: { ...process.env, TZ: timezone }, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, timezone);
    if (timezone === 'Asia/Almaty')
      assert.equal(result.stdout.trim(), '2026-09-29T13:34:56.123+0500');
  }
});

test('Kaspi ID after OTP is explicit and never invokes native finish', async () => {
  const { flow, finishes } = await entranceFixture([
    authBody('sms'),
    {
      meta: { pId: 'synthetic-process', sn: 'ViewKaspiIdTakePhoto' },
      view: { code: 'UniversalKaspiIdTakePhoto' },
      data: { verificationId: 'private-verification-id', attemptNo: 1 },
    },
  ]);
  await flow.start();
  await flow.credential('phone', 'synthetic-process', '7011234567');
  assert.deepEqual(await flow.credential('sms', 'synthetic-process', '123456'), {
    success: false,
    nextStep: 'identity_verification',
    errorCode: 'KASPI_ID_REQUIRED',
  });
  assert.equal(finishes.length, 0);
  assert.equal(flow.session, null);
});

test('session persistence preserves prior credentials until bank and cashier role are confirmed', async () => {
  const { mkdtemp, readFile, writeFile, stat, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { saveVerifiedSession, sessionEnv } =
    await import('../../infra/payments/kaspi-bridge/kaspi-login.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-session-test-'));
  const out = join(dir, 'session.env');
  const result = {
    success: true,
    nextStep: 'finished',
    isCashier: true,
    tokenSN: session.KASPI_SESSION_TOKEN_SN,
    vtokenSecret: session.KASPI_SESSION_VTOKEN_SECRET,
    profileId: session.KASPI_SESSION_PROFILE_ID,
  };
  try {
    await writeFile(out, 'previous-session', { mode: 0o600 });
    for (const invalid of [
      { ...result, nextStep: 'identity_verification' },
      { ...result, isCashier: false },
      { ...result, isCashier: undefined },
    ]) {
      await assert.rejects(
        saveVerifiedSession(invalid, {
          out,
          verifySession: () => assert.fail('must not contact bank'),
        }),
      );
      assert.equal(await readFile(out, 'utf8'), 'previous-session');
    }
    for (const reply of [{ active: false }, { active: 'true' }, {}, null]) {
      await assert.rejects(
        saveVerifiedSession(result, { out, verifySession: async () => reply }),
        /SESSION_NOT_VERIFIED/,
      );
      assert.equal(await readFile(out, 'utf8'), 'previous-session');
    }
    await assert.rejects(
      saveVerifiedSession(result, {
        out,
        verifySession: async () => {
          throw new Error('secret-provider-body');
        },
      }),
      /^Error: SESSION_NOT_VERIFIED$/,
    );
    await saveVerifiedSession(result, { out, verifySession: async () => ({ active: true }) });
    assert.equal(await readFile(out, 'utf8'), sessionEnv(result));
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), ['session.env']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
