// Interactive cashier login through the local bridge (run on the server that hosts it).
// The owner types the cashier phone, optional password and SMS code; the session is written
// to a 0600 env file. Nothing secret is printed. Usage:
//   node infra/payments/kaspi-bridge/kaspi-login.mjs [--bridge http://127.0.0.1:3931] [--out FILE]
import { createInterface } from 'node:readline/promises';
import { writeFile, rename, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function sessionEnv(result) {
  const tokenSN = String(result?.tokenSN ?? '');
  const vtokenSecret = String(result?.vtokenSecret ?? '');
  const profileId = String(result?.profileId ?? '');
  if (
    !/^[A-Za-z0-9+/=._:-]{8,512}$/.test(tokenSN) ||
    !/^[A-Za-z0-9+/=._:-]{16,2048}$/.test(vtokenSecret) ||
    !/^[A-Za-z0-9-]{1,64}$/.test(profileId)
  )
    throw new Error('LOGIN_RESULT_INVALID');
  return (
    `KASPI_SESSION_TOKEN_SN=${tokenSN}\n` +
    `KASPI_SESSION_VTOKEN_SECRET=${vtokenSecret}\n` +
    `KASPI_SESSION_PROFILE_ID=${profileId}\n`
  );
}

export function cashierPhone(input) {
  const digits = String(input).replace(/\D+/g, '');
  const body = digits.length === 11 && /^[78]/.test(digits) ? digits.slice(1) : digits;
  // Auth uses the ten digits entered after the fixed +7 in upstream's UI.
  // Invoice/customer APIs have a separate eleven-digit phone format.
  return /^7[0-9]{9}$/.test(body) ? body : null;
}

async function post(bridge, path, body) {
  const response = await fetch(bridge + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json) throw new Error(`BRIDGE_${path.split('/').pop()}_FAILED`);
  return json;
}

export async function loginThroughBridge({ request, phone, readPassword, readOtp }) {
  const init = await request('/api/auth/init');
  if (init?.success !== true || init?.nextStep !== 'phone' || !init.processId)
    throw new Error('ENTRANCE_INIT_FAILED');
  let result = await request('/api/auth/send-phone', {
    processId: init.processId,
    phoneNumber: phone,
  });
  if (result?.nextStep === 'password') {
    const password = await readPassword();
    result = await request('/api/auth/submit-password', { processId: init.processId, password });
  }
  if (result?.nextStep !== 'sms' || result?.success !== true)
    throw new Error(
      result?.nextStep === 'identity_verification'
        ? 'KASPI_ID_REQUIRED'
        : result?.nextStep === 'unsupported'
          ? 'ADDITIONAL_CONFIRMATION_REQUIRED'
          : 'LOGIN_STOPPED',
    );
  const otp = (await readOtp()).trim();
  if (!/^[0-9]{4,8}$/.test(otp)) throw new Error('OTP_INVALID');
  result = await request('/api/auth/verify-otp', { processId: init.processId, otp });
  if (result?.success !== true || result?.nextStep !== 'finished')
    throw new Error(
      result?.nextStep === 'identity_verification'
        ? 'KASPI_ID_REQUIRED'
        : result?.nextStep === 'unsupported'
          ? 'ADDITIONAL_CONFIRMATION_REQUIRED'
          : 'LOGIN_STOPPED',
    );
  sessionEnv(result); // A successful flag alone is not a usable session.
  return result;
}

export async function privateFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('PRIVATE_FILE_PERMISSIONS');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

async function hiddenQuestion(prompt) {
  if (!process.stdin.isTTY) throw new Error('SECRET_REQUIRES_TERMINAL');
  process.stderr.write(prompt);
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const secret = createInterface({ input: process.stdin, output, terminal: true });
  const abort = new AbortController();
  secret.on('SIGINT', () => abort.abort());
  try {
    return await secret.question('', { signal: abort.signal });
  } finally {
    secret.close();
    process.stderr.write('\n');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const bridge = new URL(option('--bridge', 'http://127.0.0.1:3931'));
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(bridge.hostname) ||
    bridge.protocol !== 'http:' ||
    bridge.username ||
    bridge.password
  )
    throw new Error('BRIDGE_MUST_BE_LOOPBACK');
  const base = bridge.origin;
  const out = option('--out', '/opt/pickchick-staging/secrets/kaspi-session.env');
  {
    const phoneFile = option('--phone-file', null);
    const phone = cashierPhone(
      phoneFile
        ? JSON.parse(await privateFile(phoneFile)).cashier_phone
        : await hiddenQuestion('Номер кассира Kaspi Pay (+7 7XX XXX XX XX), ввод скрыт: '),
    );
    if (!phone) throw new Error('PHONE_INVALID');
    const passwordFile = option('--password-file', null);
    const verified = await loginThroughBridge({
      phone,
      request: (path, body) => post(base, path, body),
      readPassword: async () =>
        passwordFile
          ? (await privateFile(passwordFile)).replace(/\r?\n$/, '')
          : hiddenQuestion('Пароль кассира Kaspi Pay, ввод скрыт: '),
      readOtp: () => hiddenQuestion('Код из SMS, ввод скрыт: '),
    });
    const env = sessionEnv(verified);
    const temporary = out + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, env, { mode: 0o600, flag: 'wx' });
    await rename(temporary, out);
    console.log(
      JSON.stringify({
        loggedIn: true,
        organization: String(verified.orgName ?? '').slice(0, 120),
        sessionFile: out,
        next: 'verify cashier session, merchant and fiscal readiness before enabling worker',
      }),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ loggedIn: false, reason: String(error.message).slice(0, 80) }));
    process.exitCode = 1;
  });
}
