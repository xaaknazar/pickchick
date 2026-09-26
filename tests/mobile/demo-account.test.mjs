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
  let readFailure = false;
  const calls = [];
  const io = {
    async read() {
      calls.push('read');
      if (readFailure) throw new Error('storage temporarily unreadable');
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
    failRead: (value) => (readFailure = value),
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
  assert.equal(f.core.account.version, 2);
  assert.deepEqual(f.core.account.profile, {
    nickname: '',
    birthDate: null,
    gender: null,
    completedAt: null,
  });
  assert.equal(f.core.challenge, null);
  assert.deepEqual(Object.keys(JSON.parse(f.raw())).sort(), [
    'createdAt',
    'kind',
    'phone',
    'profile',
    'version',
  ]);
  await assert.rejects(f.core.verifyCode(DEMO_LOGIN_CODE), { code: 'no_challenge' });
  const restored = new DemoAccountCore(f.io);
  await restored.restore();
  assert.deepEqual(restored.account, f.core.account);
  assert.equal(restored.challenge, null);
  assert.equal(DEMO_ACCOUNT_KEY, 'pickchick.demo.profile.v1');
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
  await firstDevice.core.saveProfile({
    nickname: 'Первое устройство',
    birthDate: '2000-02-29',
    gender: null,
  });
  const secondDevice = fixture();
  await secondDevice.core.restore();
  assert.equal(secondDevice.core.account, null);
  secondDevice.tick(1000);
  secondDevice.core.requestCode(phone);
  await secondDevice.core.verifyCode(DEMO_LOGIN_CODE);
  assert.notEqual(firstDevice.core.account.createdAt, secondDevice.core.account.createdAt);
  assert.equal(secondDevice.core.account.profile.nickname, '');
  await secondDevice.core.signOut();
  assert.equal(firstDevice.core.account.phone, phone);
  assert.notEqual(firstDevice.raw(), null);
});

test('v1 restores and migrates under the same key without losing phone or original creation time', async () => {
  const f = fixture();
  const legacy = { version: 1, kind: 'local_demo', phone, createdAt: 1_700_000_000_000 };
  f.setRaw(JSON.stringify(legacy));
  await f.core.restore();
  assert.deepEqual(f.core.account, {
    ...legacy,
    version: 2,
    profile: { nickname: '', birthDate: null, gender: null, completedAt: null },
  });
  assert.deepEqual(JSON.parse(f.raw()), f.core.account);
  assert.deepEqual(f.calls, ['read', 'write']);
  const reopened = new DemoAccountCore(f.io);
  await reopened.restore();
  assert.deepEqual(reopened.account, f.core.account);
  assert.deepEqual(f.calls, ['read', 'write', 'read']);
});

test('failed v1 migration preserves local sign-in and retries safely on a later restore', async () => {
  const f = fixture();
  const legacy = JSON.stringify({
    version: 1,
    kind: 'local_demo',
    phone,
    createdAt: 1_700_000_000_000,
  });
  f.setRaw(legacy);
  f.failWrite(true);
  await f.core.restore();
  assert.equal(f.core.account.phone, phone);
  assert.equal(f.core.account.version, 2);
  assert.equal(f.raw(), legacy);
  assert.deepEqual(f.calls, ['read', 'write']);
  f.failWrite(false);
  const reopened = new DemoAccountCore(f.io);
  await reopened.restore();
  assert.deepEqual(reopened.account, f.core.account);
  assert.equal(JSON.parse(f.raw()).version, 2);
  assert(!f.calls.includes('remove'));
});

test('profile saves one complete trimmed snapshot and survives restart without another login', async () => {
  const f = fixture();
  f.core.requestCode(phone);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  const createdAt = f.core.account.createdAt;
  f.tick(1000);
  const beforeCalls = f.calls.length;
  await f.core.saveProfile({ nickname: '  Чики 🐥  ', birthDate: '2000-02-29', gender: 'female' });
  assert.deepEqual(f.calls.slice(beforeCalls), ['write']);
  assert.deepEqual(f.core.account.profile, {
    nickname: 'Чики 🐥',
    birthDate: '2000-02-29',
    gender: 'female',
    completedAt: f.io.now(),
  });
  assert.equal(f.core.account.createdAt, createdAt);
  assert.equal(f.core.account.phone, phone);
  const restarted = new DemoAccountCore(f.io);
  await restarted.restore();
  assert.deepEqual(restarted.account, f.core.account);
  assert.equal(restarted.challenge, null);
  assert.deepEqual(JSON.parse(f.raw()), restarted.account);
});

test('empty optional details can be explicitly completed and later edited without retaining removed DOB', async () => {
  const f = fixture();
  f.core.requestCode(phone);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  await f.core.saveProfile({ nickname: 'Имя', birthDate: '1996-11-09', gender: 'male' });
  const firstCompletedAt = f.core.account.profile.completedAt;
  f.tick(5000);
  await f.core.saveProfile({ nickname: '  ', birthDate: null, gender: null });
  assert.deepEqual(f.core.account.profile, {
    nickname: '',
    birthDate: null,
    gender: null,
    completedAt: f.io.now(),
  });
  assert(f.core.account.profile.completedAt > firstCompletedAt);
  assert(!f.raw().includes('1996-11-09'));
});

test('save without an account or with invalid/unknown profile fields cannot touch storage', async () => {
  const f = fixture();
  const details = { nickname: 'Тест', birthDate: null, gender: null };
  await assert.rejects(f.core.saveProfile(details), { code: 'no_account' });
  assert.deepEqual(f.calls, []);
  f.core.requestCode(phone);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  const previous = f.core.account;
  const previousRaw = f.raw();
  const beforeCalls = f.calls.length;
  for (const input of [
    null,
    {},
    { ...details, nickname: 'я'.repeat(33) },
    { ...details, birthDate: '2001-02-29' },
    { ...details, birthDate: '2999-01-01' },
    { ...details, gender: 'unknown' },
    { ...details, completedAt: f.io.now() },
    { ...details, role: 'manager' },
  ])
    await assert.rejects(f.core.saveProfile(input), { code: 'invalid_profile' });
  assert.equal(f.calls.length, beforeCalls);
  assert.equal(f.core.account, previous);
  assert.equal(f.raw(), previousRaw);
});

test('profile storage failure preserves previous fields and completedAt, allowing a later retry', async () => {
  const f = fixture();
  f.core.requestCode(phone);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  await f.core.saveProfile({ nickname: 'Сохранённое имя', birthDate: '2000-02-29', gender: null });
  const previous = f.core.account;
  const raw = f.raw();
  const changes = { nickname: 'Новое имя', birthDate: '1999-01-01', gender: 'male' };
  f.tick(1000);
  f.failWrite(true);
  await assert.rejects(f.core.saveProfile(changes), /storage unavailable/);
  assert.equal(f.core.account, previous);
  assert.equal(f.raw(), raw);
  f.failWrite(false);
  await f.core.saveProfile(changes);
  assert.deepEqual(f.core.account.profile, { ...changes, completedAt: f.io.now() });
});

test('profile success is not published until its one storage write has completed', async () => {
  const f = fixture();
  f.core.requestCode(phone);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  const previous = f.core.account;
  let release;
  const persisted = [];
  const core = new DemoAccountCore({
    ...f.io,
    write: (value) =>
      new Promise((resolve) => {
        release = () => {
          persisted.push(value);
          resolve();
        };
      }),
  });
  await core.restore();
  const pending = core.saveProfile({ nickname: 'Новый профиль', birthDate: null, gender: null });
  assert.deepEqual(core.account, previous);
  assert.equal(persisted.length, 0);
  release();
  await pending;
  assert.equal(persisted.length, 1);
  assert.deepEqual(JSON.parse(persisted[0]), core.account);
  assert.equal(core.account.profile.nickname, 'Новый профиль');
});

test('verifying the same local phone preserves profile, but a different phone starts empty', async () => {
  const f = fixture();
  f.core.requestCode(phone);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  await f.core.saveProfile({ nickname: 'Чики', birthDate: '1999-03-20', gender: null });
  const previous = f.core.account;
  f.tick(1000);
  f.core.requestCode(local);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  assert.deepEqual(f.core.account, previous);
  const otherPhone = `+77${'0'.repeat(8)}2`;
  f.core.requestCode(otherPhone);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  assert.equal(f.core.account.phone, otherPhone);
  assert.deepEqual(f.core.account.profile, {
    nickname: '',
    birthDate: null,
    gender: null,
    completedAt: null,
  });
  assert(!f.raw().includes('1999-03-20'));
  f.core.requestCode(phone);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  assert.equal(f.core.account.profile.nickname, '');
});

test('sign-out/deletion erases the whole local record including DOB and does not recover it by phone', async () => {
  const f = fixture();
  f.core.requestCode(phone);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  await f.core.saveProfile({ nickname: 'Тест', birthDate: '2000-02-29', gender: 'female' });
  await f.core.signOut();
  assert.equal(f.raw(), null);
  assert.equal(f.core.account, null);
  f.core.requestCode(phone);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  assert.equal(f.core.account.profile.birthDate, null);
  assert.equal(f.core.account.profile.completedAt, null);
});

test('v2 restoration strictly validates profile shape, date, gender and completion timestamp', async () => {
  const valid = {
    version: 2,
    kind: 'local_demo',
    phone,
    createdAt: 1_700_000_000_000,
    profile: {
      nickname: 'Тест',
      birthDate: '2000-02-29',
      gender: 'male',
      completedAt: 1_700_000_001_000,
    },
  };
  assert.deepEqual(parseDemoAccount(JSON.stringify(valid)), valid);
  for (const profile of [
    null,
    [],
    {},
    { ...valid.profile, nickname: '🐥'.repeat(33) },
    { ...valid.profile, birthDate: '2000-02-30' },
    { ...valid.profile, birthDate: '2999-01-01' },
    { ...valid.profile, gender: true },
    { ...valid.profile, completedAt: -1 },
    { ...valid.profile, completedAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid.profile, role: 'manager' },
    { ...valid.profile, token: 'not-a-credential' },
  ]) {
    const raw = JSON.stringify({ ...valid, profile });
    assert.equal(parseDemoAccount(raw), null);
    const f = fixture();
    f.setRaw(raw);
    await f.core.restore();
    assert.equal(f.core.account, null);
    assert.equal(f.raw(), null);
  }
});

test('temporary cold-start read failure cannot replace the saved phone/DOB with a fresh login', async () => {
  const f = fixture();
  const saved = {
    version: 2,
    kind: 'local_demo',
    phone,
    createdAt: 1_700_000_000_000,
    profile: {
      nickname: 'Сохранено',
      birthDate: '2000-02-29',
      gender: 'female',
      completedAt: 1_700_000_001_000,
    },
  };
  const raw = JSON.stringify(saved);
  f.setRaw(raw);
  f.failRead(true);
  await assert.rejects(f.core.restore(), /temporarily unreadable/);
  assert.equal(f.core.account, null);
  assert.throws(() => f.core.requestCode(phone), { code: 'restore_required' });
  await assert.rejects(f.core.verifyCode(DEMO_LOGIN_CODE), { code: 'restore_required' });
  await assert.rejects(f.core.saveProfile({ nickname: '', birthDate: null, gender: null }), {
    code: 'restore_required',
  });
  await assert.rejects(f.core.signOut(), { code: 'restore_required' });
  f.core.cancelChallenge();
  assert.deepEqual(f.calls, ['read']);
  assert.equal(f.raw(), raw);
  f.failRead(false);
  await f.core.restore();
  assert.deepEqual(f.core.account, saved);
  assert.deepEqual(f.calls, ['read', 'read']);
  assert.equal(f.core.challenge, null);
  f.core.requestCode(phone);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  assert.deepEqual(f.core.account, saved);
  assert.deepEqual(JSON.parse(f.raw()), saved);
});

test('failed reread keeps the cached account/challenge and blocks all mutations until retry', async () => {
  const f = fixture();
  f.core.requestCode(phone);
  await f.core.verifyCode(DEMO_LOGIN_CODE);
  await f.core.saveProfile({ nickname: 'Чики', birthDate: '1999-03-20', gender: null });
  f.core.requestCode(phone);
  const account = f.core.account;
  const challenge = f.core.challenge;
  const raw = f.raw();
  f.failRead(true);
  await assert.rejects(f.core.restore(), /temporarily unreadable/);
  assert.equal(f.core.account, account);
  const callCount = f.calls.length;
  assert.throws(() => f.core.requestCode(phone), { code: 'restore_required' });
  await assert.rejects(f.core.verifyCode(DEMO_LOGIN_CODE), { code: 'restore_required' });
  await assert.rejects(f.core.saveProfile({ nickname: 'Новый', birthDate: null, gender: null }), {
    code: 'restore_required',
  });
  await assert.rejects(f.core.signOut(), { code: 'restore_required' });
  f.core.cancelChallenge();
  assert.equal(f.core.account, account);
  assert.equal(f.core.challenge, challenge);
  assert.equal(f.raw(), raw);
  assert.equal(f.calls.length, callCount);
  f.failRead(false);
  await f.core.restore();
  await f.core.saveProfile({
    nickname: 'После восстановления',
    birthDate: account.profile.birthDate,
    gender: null,
  });
  assert.equal(f.core.account.profile.birthDate, '1999-03-20');
});

test('a pending restoration blocks writes before it has determined whether an account exists', async () => {
  const f = fixture();
  let finishRead;
  let reads = 0;
  const core = new DemoAccountCore({
    ...f.io,
    read: () =>
      new Promise((resolve) => {
        reads++;
        finishRead = resolve;
      }),
  });
  const pending = core.restore();
  assert.equal(core.restore(), pending);
  assert.equal(reads, 1);
  assert.throws(() => core.requestCode(phone), { code: 'restore_required' });
  await assert.rejects(core.signOut(), { code: 'restore_required' });
  assert.deepEqual(f.calls, []);
  finishRead(null);
  await pending;
  core.requestCode(phone);
  await core.verifyCode(DEMO_LOGIN_CODE);
  assert.equal(core.account.phone, phone);
});
