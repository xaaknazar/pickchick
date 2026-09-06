import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_ACCOUNT_KEY,
  DEMO_LOGIN_CODE,
  DEMO_CODE_TTL_MS,
  DEMO_RESEND_MS,
  DEMO_CODE_ATTEMPTS,
  DemoAccountCore,
  normalizeDemoPhone,
  formatDemoPhone,
  parseDemoAccount,
} from '../../apps/mobile/src/demo-account.ts';

// Constructed fixture numbers; tests have no network or SMS adapter.
const local = `7${'0'.repeat(8)}1`;
const phone = `+7${local}`;
function fixture() {
  let raw = null;
  let now = 1_800_000_000_000;
  let writeFailure = false;
  let removeFailure = false;
  const calls = [];
  const io = {
    async read() {
      calls.push('read');
      return raw;
    },
    async write(value) {
      calls.push('write');
      if (writeFailure) throw new Error('storage unavailable');
      raw = value;
    },
    async remove() {
      calls.push('remove');
      if (removeFailure) throw new Error('storage unavailable');
      raw = null;
    },
    now: () => now,
  };
  return {
    io,
    core: new DemoAccountCore(io),
    calls,
    raw: () => raw,
    tick: (ms) => (now += ms),
    failWrite: (value) => (writeFailure = value),
    failRemove: (value) => (removeFailure = value),
    setRaw: (value) => (raw = value),
  };
}

test('demo login normalizes local, international and domestic mobile input without accepting foreign or malformed input', () => {
  for (const value of [local, phone, `8${local}`, formatDemoPhone(phone)])
    assert.equal(normalizeDemoPhone(value), phone);
  for (const value of ['', '7', `+44${local}`, `+79${'0'.repeat(9)}`, `x${phone}`, '1'.repeat(40)])
    assert.equal(normalizeDemoPhone(value), null);
  assert.equal(formatDemoPhone(phone), '+7 700 000-00-01');
});

test('successful local login persists only an explicit demo profile and consumes the challenge once', async () => {
  const f = fixture();
  await f.core.restore();
  f.core.requestCode(local);
  assert.equal(f.raw(), null);
  assert.deepEqual(f.calls, ['read']);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  assert.equal(f.core.account.kind, 'local_demo');
  assert.equal(f.core.account.phone, phone);
  assert.equal(f.core.challenge, null);
  assert.deepEqual(Object.keys(JSON.parse(f.raw())).sort(), [
    'createdAt',
    'kind',
    'phone',
    'version',
  ]);
  await assert.rejects(f.core.verifyCode(DEMO_LOGIN_CODE), { code: 'no_challenge' });
  const restored = new DemoAccountCore(f.io);
  await restored.restore();
  assert.deepEqual(restored.account, f.core.account);
  assert.equal(restored.challenge, null);
  assert.equal(DEMO_ACCOUNT_KEY.startsWith('pickchick.demo.'), true);
});

test('wrong codes exhaust bounded attempts; resending is delayed and creates a fresh challenge', async () => {
  const f = fixture();
  f.core.requestCode(phone);
  assert.throws(() => f.core.requestCode(phone), { code: 'wait_to_resend' });
  for (let attempt = 1; attempt <= DEMO_CODE_ATTEMPTS; attempt++) {
    await assert.rejects(f.core.verifyCode('000000'), {
      code: attempt === DEMO_CODE_ATTEMPTS ? 'attempts_exhausted' : 'invalid_code',
    });
    assert.equal(f.core.challenge.attemptsLeft, DEMO_CODE_ATTEMPTS - attempt);
  }
  await assert.rejects(f.core.verifyCode(DEMO_LOGIN_CODE), { code: 'attempts_exhausted' });
  assert.equal(f.raw(), null);
  f.tick(DEMO_RESEND_MS);
  f.core.requestCode(phone);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  assert.equal(f.core.account.phone, phone);
});

test('an expired challenge cannot sign in even with the demo code', async () => {
  const f = fixture();
  f.core.requestCode(phone);
  f.tick(DEMO_CODE_TTL_MS);
  await assert.rejects(f.core.verifyCode(DEMO_LOGIN_CODE), { code: 'expired' });
  assert.equal(f.core.account, null);
  assert.equal(f.raw(), null);
});

test('storage failure does not announce a login or erase a profile before deletion succeeds', async () => {
  const f = fixture();
  f.core.requestCode(phone);
  f.failWrite(true);
  await assert.rejects(f.core.verifyCode(DEMO_LOGIN_CODE), /storage unavailable/);
  assert.equal(f.core.account, null);
  assert.notEqual(f.core.challenge, null);
  f.failWrite(false);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  f.failRemove(true);
  await assert.rejects(f.core.signOut(), /storage unavailable/);
  assert.notEqual(f.core.account, null);
  f.failRemove(false);
  await f.core.signOut();
  assert.equal(f.core.account, null);
  assert.equal(f.core.challenge, null);
  assert.equal(f.raw(), null);
  const restarted = new DemoAccountCore(f.io);
  await restarted.restore();
  assert.equal(restarted.account, null);
});

test('restoration rejects injected privileges, malformed phones and oversized local data', async () => {
  const valid = { version: 1, kind: 'local_demo', phone, createdAt: 1_800_000_000_000 };
  for (const value of [
    '{',
    'x'.repeat(1001),
    JSON.stringify({ ...valid, token: 'should-not-be-a-credential' }),
    JSON.stringify({ ...valid, kind: 'customer' }),
    JSON.stringify({ ...valid, phone: 'invalid' }),
    JSON.stringify({ ...valid, createdAt: -1 }),
  ]) {
    assert.equal(parseDemoAccount(value), null);
    const f = fixture();
    f.setRaw(value);
    await f.core.restore();
    assert.equal(f.core.account, null);
    assert.equal(f.raw(), null);
  }
});

test('the phone is a local label: separate device storage never discovers another profile or server identity', async () => {
  const firstDevice = fixture();
  firstDevice.core.requestCode(phone);
  await firstDevice.core.verifyCode(DEMO_LOGIN_CODE);
  const secondDevice = fixture();
  await secondDevice.core.restore();
  assert.equal(secondDevice.core.account, null);
  secondDevice.tick(1000);
  secondDevice.core.requestCode(phone);
  await secondDevice.core.verifyCode(DEMO_LOGIN_CODE);
  assert.notEqual(firstDevice.core.account.createdAt, secondDevice.core.account.createdAt);
  await secondDevice.core.signOut();
  assert.equal(firstDevice.core.account.phone, phone);
  assert.notEqual(firstDevice.raw(), null);
});
