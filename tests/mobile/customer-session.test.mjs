import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import {
  CustomerSessionCore,
  CustomerSessionError,
} from '../../apps/mobile/src/customer-session.ts';
import { createCustomerRequest } from '../../apps/mobile/src/customer-http.ts';
const { structuredClone } = globalThis;

const code = (expected) => (error) =>
  error instanceof CustomerSessionError && error.code === expected;
function fixture() {
  let now = Date.parse('2026-09-07T10:00:00Z');
  let raw = null;
  let readError = false;
  let writeError = false;
  let loseRefresh = false;
  let loseVerify = false;
  let loseRequest = false;
  let offline = false;
  let revoked = false;
  let rotated = 0;
  let calls = [];
  let receipt = null;
  let verifyReceipt = null;
  let otpReceipt = null;
  let consentVersion = 'fixture-v1';
  const customer = {
    id: randomUUID(),
    phone: `+7700${'0'.repeat(6)}1`,
    nickname: '',
    birth_date: null,
    gender: null,
    profile_completed_at: null,
    created_at: new Date(now).toISOString(),
  };
  const sessionId = randomUUID();
  let tokens = null;
  let challenge = null;
  const createTokens = () => ({
    access_token: `access${String(rotated).padStart(42, '0')}`,
    refresh_token: `refresh${String(rotated).padStart(42, '0')}`,
    access_expires_at: new Date(now + 900000).toISOString(),
    session_id: sessionId,
    customer: { ...customer },
  });
  const io = {
    read: async () => {
      if (readError) throw new Error('locked storage');
      return raw;
    },
    write: async (v) => {
      if (writeError) throw new Error('full storage');
      raw = v;
    },
    now: () => now,
    randomId: randomUUID,
    request: async (path, method, body, token) => {
      calls.push({ path, method, body: structuredClone(body), token });
      if (offline) throw new CustomerSessionError('NETWORK_UNAVAILABLE');
      if (path === '/v1/auth/config')
        return {
          enabled: true,
          consent_version: consentVersion,
          terms_url: 'https://example.test/terms',
          privacy_url: 'https://example.test/privacy',
        };
      if (path.endsWith('/otp/request')) {
        if (otpReceipt?.body.request_id === body.request_id) {
          assert.deepEqual(body, otpReceipt.body);
          return structuredClone(otpReceipt.response);
        }
        challenge = {
          challenge_id: randomUUID(),
          expires_at: new Date(now + 180000).toISOString(),
          resend_at: new Date(now + 60000).toISOString(),
          delivery_status: 'submitted',
        };
        otpReceipt = { body: structuredClone(body), response: structuredClone(challenge) };
        if (loseRequest) {
          loseRequest = false;
          throw new CustomerSessionError('NETWORK_UNAVAILABLE');
        }
        return challenge;
      }
      if (path.endsWith('/otp/verify')) {
        if (verifyReceipt) {
          if (JSON.stringify(body) !== JSON.stringify(verifyReceipt.body))
            throw new CustomerSessionError('CONFLICT', 409, true);
          return structuredClone(verifyReceipt.response);
        }
        if (
          body.consents.terms_version !== consentVersion ||
          body.consents.privacy_version !== consentVersion
        )
          throw new CustomerSessionError('INVALID_REQUEST', 400, true);
        if (body.code !== '938174') throw new CustomerSessionError('UNAUTHORIZED', 401, true);
        tokens = createTokens();
        verifyReceipt = { body: structuredClone(body), response: structuredClone(tokens) };
        if (loseVerify) {
          loseVerify = false;
          throw new CustomerSessionError('NETWORK_UNAVAILABLE');
        }
        return structuredClone(tokens);
      }
      if (path.endsWith('/refresh')) {
        if (revoked) throw new CustomerSessionError('UNAUTHORIZED', 401, true);
        if (receipt && body.refresh_token === receipt.body.refresh_token) {
          assert.deepEqual(body, receipt.body);
          return structuredClone(receipt.response);
        }
        assert.equal(body.refresh_token, tokens.refresh_token);
        rotated++;
        tokens = createTokens();
        receipt = { body: structuredClone(body), response: structuredClone(tokens) };
        if (loseRefresh) {
          loseRefresh = false;
          throw new CustomerSessionError('NETWORK_UNAVAILABLE');
        }
        return structuredClone(tokens);
      }
      if (revoked || token !== tokens?.access_token)
        throw new CustomerSessionError('UNAUTHORIZED', 401, true);
      if (path.endsWith('/logout')) {
        revoked = true;
        return { ok: true };
      }
      if (path.endsWith('/me') && method === 'DELETE') {
        revoked = true;
        return { ok: true };
      }
      if (path.endsWith('/me')) {
        if (method === 'PATCH')
          Object.assign(customer, body, { profile_completed_at: new Date(now).toISOString() });
        return { customer: structuredClone(customer) };
      }
      throw new Error('unexpected request');
    },
  };
  let core = new CustomerSessionCore(io);
  return {
    get core() {
      return core;
    },
    io,
    calls,
    customer,
    raw: () => raw,
    setRaw: (v) => {
      raw = v;
    },
    setReadError: (v) => {
      readError = v;
    },
    setWriteError: (v) => {
      writeError = v;
    },
    tick: (v) => {
      now += v;
    },
    loseRefresh: () => {
      loseRefresh = true;
    },
    loseVerify: () => {
      loseVerify = true;
    },
    loseRequest: () => {
      loseRequest = true;
    },
    offline: (v) => {
      offline = v;
    },
    revoke: () => {
      revoked = true;
    },
    setConsent: (v) => {
      consentVersion = v;
    },
    restart: async () => {
      core = new CustomerSessionCore(io);
      await core.restore();
    },
    login: async () => {
      await core.restore();
      await core.requestCode(customer.phone);
      await core.verifyCode('938174', 'fixture-v1');
    },
  };
}

test('server login uses a persisted device, explicit consent and confirmed response before showing an account', async () => {
  const f = fixture();
  await f.core.restore();
  const device = JSON.parse(f.raw()).device_id;
  await f.core.requestCode(f.customer.phone);
  await assert.rejects(f.core.verifyCode('938174', null), code('CONSENT_REQUIRED'));
  assert.equal(f.calls.filter((x) => x.path.endsWith('/verify')).length, 0);
  await f.core.verifyCode('938174', 'fixture-v1');
  assert.equal(f.core.customer.id, f.customer.id);
  assert.equal(JSON.parse(f.raw()).device_id, device);
  assert.equal(f.raw().includes('938174'), false, 'OTP must not be persisted');
  assert.equal(
    f.calls.find((x) => x.path.endsWith('/verify')).body.consents.marketing_opt_in,
    false,
  );
});
test('lost SMS request reply reuses its persisted key after restart rather than sending another message', async () => {
  const f = fixture();
  await f.core.restore();
  f.loseRequest();
  await assert.rejects(f.core.requestCode(f.customer.phone), code('NETWORK_UNAVAILABLE'));
  const pending = JSON.parse(f.raw()).otp_request;
  assert.ok(pending.request_id);
  await f.restart();
  await f.core.requestCode(f.customer.phone);
  const requests = f.calls.filter((x) => x.path.endsWith('/otp/request'));
  assert.deepEqual(requests[0].body, requests[1].body);
  assert.equal(f.core.challenge.phone, f.customer.phone);
  assert.equal(JSON.parse(f.raw()).otp_request, null);
});

test('wrong OTP never creates a local account or falls back to a demo code', async () => {
  const f = fixture();
  await f.core.restore();
  await f.core.requestCode(f.customer.phone);
  await assert.rejects(f.core.verifyCode('123456', 'fixture-v1'), code('UNAUTHORIZED'));
  assert.equal(f.core.customer, null);
  assert.equal(JSON.parse(f.raw()).tokens, null);
  await f.core.verifyCode('938174', 'fixture-v1');
  assert.equal(f.core.customer.id, f.customer.id);
});
test('lost verify response repeats the persisted request id after app restart without storing the code', async () => {
  const f = fixture();
  await f.core.restore();
  await f.core.requestCode(f.customer.phone);
  f.loseVerify();
  await assert.rejects(f.core.verifyCode('938174', 'fixture-v1'), code('NETWORK_UNAVAILABLE'));
  assert.equal(f.core.customer, null);
  const key = JSON.parse(f.raw()).verify_intent.request_id;
  await f.restart();
  await f.core.verifyCode('938174', 'fixture-v1');
  assert.equal(f.core.customer.id, f.customer.id);
  assert.deepEqual(
    f.calls.filter((x) => x.path.endsWith('/verify')).map((x) => x.body.request_id),
    [key, key],
  );
});
test('typo while recovering a consumed OTP keeps its original verify request id for the correct retry', async () => {
  const f = fixture();
  await f.core.restore();
  await f.core.requestCode(f.customer.phone);
  f.loseVerify();
  await assert.rejects(f.core.verifyCode('938174', 'fixture-v1'), code('NETWORK_UNAVAILABLE'));
  const before = JSON.parse(f.raw()).verify_intent;
  await assert.rejects(f.core.verifyCode('111111', null), code('CONFLICT'));
  assert.deepEqual(JSON.parse(f.raw()).verify_intent, before);
  await f.restart();
  await f.core.verifyCode('938174', null);
  assert.ok(f.core.customer);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/otp/request')).length, 1);
});
test('explicit local sign-out clears an unresolved SMS request and its phone without resending', async () => {
  const f = fixture();
  await f.core.restore();
  f.loseRequest();
  await assert.rejects(f.core.requestCode(f.customer.phone), code('NETWORK_UNAVAILABLE'));
  await f.core.signOut();
  assert.equal(f.core.pendingOtp, false);
  assert.equal(f.raw().includes(f.customer.phone), false);
  await f.core.requestCode('+77000000002');
  assert.equal(f.core.challenge.phone, '+77000000002');
});
test('lost rotation response survives a day offline then recovers its successor before another refresh', async () => {
  const f = fixture();
  await f.login();
  f.tick(900000);
  f.loseRefresh();
  await assert.rejects(f.core.accessToken(), code('NETWORK_UNAVAILABLE'));
  const pending = JSON.parse(f.raw());
  f.tick(86400000);
  await f.restart();
  const token = await f.core.accessToken();
  assert.equal(f.core.customer.id, f.customer.id);
  const refreshes = f.calls.filter((x) => x.path.endsWith('/refresh'));
  assert.equal(refreshes.length, 3);
  assert.deepEqual(refreshes[0].body, refreshes[1].body);
  assert.equal(refreshes[0].body.request_id, pending.refresh_request_id);
  assert.notEqual(refreshes[1].body.refresh_token, refreshes[2].body.refresh_token);
  assert.equal(token, JSON.parse(f.raw()).tokens.access_token);
  assert.equal(f.calls.filter((x) => x.path.endsWith('/otp/request')).length, 1);
});
test('30 simultaneous consumers share one refresh and a year of inactivity never requests another OTP', async () => {
  const f = fixture();
  await f.login();
  f.tick(366 * 86400000);
  await f.restart();
  const tokens = await Promise.all(Array.from({ length: 30 }, () => f.core.accessToken()));
  assert.equal(new Set(tokens).size, 1);
  assert.equal(f.calls.filter((x) => x.path.endsWith('/refresh')).length, 1);
  assert.equal(f.calls.filter((x) => x.path.endsWith('/otp/request')).length, 1);
});
test('server success followed by secure storage failure retains the exact refresh journal', async () => {
  const f = fixture();
  await f.login();
  f.tick(900000);
  const request = f.io.request;
  f.io.request = async (...args) => {
    const value = await request(...args);
    if (args[0].endsWith('/refresh')) f.setWriteError(true);
    return value;
  };
  await assert.rejects(f.core.accessToken(), /full storage/);
  const pending = JSON.parse(f.raw()).refresh_request_id;
  f.io.request = request;
  f.setWriteError(false);
  await f.restart();
  await f.core.accessToken();
  assert.equal(f.calls.filter((x) => x.path.endsWith('/refresh'))[1].body.request_id, pending);
});
test('storage read failure blocks creating a replacement device or requesting SMS', async () => {
  const f = fixture();
  await f.login();
  const previous = f.raw();
  f.setReadError(true);
  await assert.rejects(f.restart());
  await assert.rejects(f.core.requestCode(f.customer.phone), code('RESTORE_REQUIRED'));
  assert.equal(f.raw(), previous);
  assert.equal(f.core.ready, false);
  f.setReadError(false);
  await f.core.restore();
  assert.equal(f.core.customer.id, f.customer.id);
});
test('malformed stored credentials remain intact for recovery instead of silently overwriting access', async () => {
  const f = fixture();
  f.setRaw('{broken');
  await assert.rejects(f.core.restore());
  assert.equal(f.raw(), '{broken');
  assert.equal(f.core.ready, false);
});
test('network errors keep the cached profile while authoritative refresh revocation removes the session', async () => {
  const f = fixture();
  await f.login();
  f.offline(true);
  await f.restart();
  await assert.rejects(f.core.sync(), code('NETWORK_UNAVAILABLE'));
  assert.equal(f.core.customer.id, f.customer.id);
  f.offline(false);
  f.tick(900000);
  f.revoke();
  await assert.rejects(f.core.sync(), code('UNAUTHORIZED'));
  assert.equal(f.core.customer, null);
  assert.equal(JSON.parse(f.raw()).tokens, null);
});
test('birthday and nickname are saved on the server, then restored from secure storage', async () => {
  const f = fixture();
  await f.login();
  await f.core.saveProfile({ nickname: 'Чики', birthDate: '2000-02-29', gender: null });
  await f.restart();
  await f.core.sync();
  assert.equal(f.core.customer.birth_date, '2000-02-29');
  assert.equal(f.core.customer.nickname, 'Чики');
  await assert.rejects(
    f.core.saveProfile({ nickname: 'A', birthDate: '2001-02-29', gender: null }),
    code('INVALID_PROFILE'),
  );
});
test('changed legal policy is rejected instead of silently accepting a version the user did not see', async () => {
  const f = fixture();
  await f.core.restore();
  await f.core.requestCode(f.customer.phone);
  f.setConsent('fixture-v2');
  await assert.rejects(f.core.verifyCode('938174', 'fixture-v1'), code('INVALID_REQUEST'));
  assert.equal(f.core.customer, null);
});
test('foreground policy update requires new explicit consent, while an acknowledged old intent replays unchanged after expiry', async () => {
  const fresh = fixture();
  await fresh.core.restore();
  await fresh.core.requestCode(fresh.customer.phone);
  fresh.setConsent('fixture-v2');
  await fresh.core.sync();
  await assert.rejects(fresh.core.verifyCode('938174', 'fixture-v1'), code('CONSENT_REQUIRED'));
  assert.equal(fresh.calls.filter((x) => x.path.endsWith('/verify')).length, 0);
  await fresh.core.verifyCode('938174', 'fixture-v2');
  assert.ok(fresh.core.customer);

  const pending = fixture();
  await pending.core.restore();
  await pending.core.requestCode(pending.customer.phone);
  pending.loseVerify();
  await assert.rejects(
    pending.core.verifyCode('938174', 'fixture-v1'),
    code('NETWORK_UNAVAILABLE'),
  );
  pending.tick(600000);
  pending.setConsent('fixture-v2');
  await pending.restart();
  await pending.core.sync();
  assert.equal(pending.core.pendingVerify, true);
  await pending.core.verifyCode('938174', null);
  assert.ok(pending.core.customer);
  const attempts = pending.calls.filter((x) => x.path.endsWith('/verify'));
  assert.deepEqual(attempts[0].body, attempts[1].body);
  assert.equal(attempts[1].body.consents.terms_version, 'fixture-v1');
});
test('definitively rejected phone can be corrected, but unknown delivery requires explicit abandonment before a new request', async () => {
  const f = fixture();
  await f.core.restore();
  const underlying = f.io.request;
  f.io.request = async (path, ...args) => {
    if (path.endsWith('/otp/request')) throw new CustomerSessionError('INVALID_REQUEST', 400, true);
    return underlying(path, ...args);
  };
  await assert.rejects(f.core.requestCode(f.customer.phone), code('INVALID_REQUEST'));
  assert.equal(JSON.parse(f.raw()).otp_request, null);
  f.io.request = underlying;
  f.loseRequest();
  await assert.rejects(f.core.requestCode(f.customer.phone), code('NETWORK_UNAVAILABLE'));
  const firstKey = JSON.parse(f.raw()).otp_request.request_id;
  await f.core.cancelChallenge();
  await f.core.requestCode('+77000000002');
  assert.notEqual(
    f.calls.filter((x) => x.path.endsWith('/otp/request')).at(-1).body.request_id,
    firstKey,
  );
});
test('non-authoritative gateway 401 never discards saved credentials or its refresh journal', async () => {
  const f = fixture();
  await f.login();
  f.tick(900000);
  f.io.request = async () => {
    throw new CustomerSessionError('UNAUTHORIZED', 401);
  };
  await assert.rejects(f.core.accessToken(), code('UNAUTHORIZED'));
  assert.ok(f.core.customer);
  assert.ok(JSON.parse(f.raw()).refresh_request_id);
});
test('offline logout hides profile and retains a revocation journal until server acknowledges', async () => {
  const f = fixture();
  await f.login();
  f.offline(true);
  await assert.rejects(f.core.signOut(), code('NETWORK_UNAVAILABLE'));
  assert.equal(f.core.customer, null);
  assert.equal(f.core.closing, true);
  await assert.rejects(f.core.accessToken(), code('LOGOUT_PENDING'));
  await f.restart();
  assert.equal(f.core.customer, null);
  f.offline(false);
  await f.core.sync();
  assert.equal(f.core.closing, false);
  assert.equal(JSON.parse(f.raw()).tokens, null);
});
test('account deletion is acknowledged remotely before local credentials are removed', async () => {
  const f = fixture();
  await f.login();
  f.offline(true);
  await assert.rejects(f.core.deleteAccount(), code('NETWORK_UNAVAILABLE'));
  assert.ok(f.core.customer);
  f.offline(false);
  await f.core.deleteAccount();
  assert.equal(f.core.customer, null);
  assert.equal(JSON.parse(f.raw()).tokens, null);
});
test('auth transport rejects non-HTTPS endpoints, redirects and arbitrary paths without revealing credentials', async () => {
  for (const url of [
    'http://example.test',
    'https://user:pass@example.test',
    'https://example.test/path',
    'https://example.test/?key=x',
  ])
    assert.throws(() => createCustomerRequest(url));
  let options;
  let calledUrl;
  const request = createCustomerRequest('https://api.example.test', async (url, opts) => {
    calledUrl = url;
    options = opts;
    return new Response('{"customer":{}}', { headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(request('/v1/customers/me?token=secret', 'GET'), code('INVALID_API_PATH'));
  await request('/v1/customers/me', 'GET', undefined, 'private-access');
  assert.equal(calledUrl, 'https://api.example.test/v1/customers/me');
  assert.equal(options.headers.Authorization, 'Bearer private-access');
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
});
test('auth transport trusts only complete structured revocation errors and caps streamed response bytes', async () => {
  const unauthorized = {
    code: 'UNAUTHORIZED',
    message_key: 'errors.unauthorized',
    trace_id: randomUUID(),
    retryable: false,
  };
  for (const body of [
    { code: 'UNAUTHORIZED' },
    { ...unauthorized, retryable: true },
    { ...unauthorized, message_key: 'gateway.login' },
  ]) {
    const request = createCustomerRequest('https://api.example.test', async () =>
      Response.json(body, { status: 401 }),
    );
    await assert.rejects(request('/v1/auth/refresh', 'POST', {}), code('INVALID_RESPONSE'));
  }
  const correct = createCustomerRequest('https://api.example.test', async () =>
    Response.json(unauthorized, { status: 401 }),
  );
  await assert.rejects(
    correct('/v1/auth/refresh', 'POST', {}),
    (error) => code('UNAUTHORIZED')(error) && error.authoritative,
  );
  let cancelled = false;
  let reads = 0;
  const large = createCustomerRequest(
    'https://api.example.test',
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            reads++;
            controller.enqueue(new Uint8Array(8192));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  await assert.rejects(large('/v1/auth/config', 'GET'), code('INVALID_RESPONSE'));
  assert.equal(cancelled, true);
  assert.ok(reads <= 3, `unbounded streaming: ${reads}`);
});
