// Interactive cashier login through the local bridge (run on the server that hosts it).
// The owner types the cashier phone and the SMS code; the resulting session is written
// to a 0600 env file. Nothing secret is printed. Usage:
//   node infra/payments/kaspi-bridge/kaspi-login.mjs [--bridge http://127.0.0.1:3931] [--out FILE]
import { createInterface } from 'node:readline/promises';
import { writeFile, rename } from 'node:fs/promises';
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
  return /^7[0-9]{9}$/.test(body) ? '7' + body : null;
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

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const bridge = new URL(option('--bridge', 'http://127.0.0.1:3931'));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(bridge.hostname))
    throw new Error('BRIDGE_MUST_BE_LOOPBACK');
  const base = bridge.origin;
  const out = option('--out', '/opt/pickchick-staging/secrets/kaspi-session.env');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const phone = cashierPhone(await rl.question('Номер кассира Kaspi Pay (+7 7XX XXX XX XX): '));
    if (!phone) throw new Error('PHONE_INVALID');
    const init = await post(base, '/api/auth/init');
    const sent = await post(base, '/api/auth/send-phone', {
      phoneNumber: phone,
      processId: init.processId,
    });
    if (!sent.success) throw new Error('SMS_NOT_SENT');
    const otp = (await rl.question('Код из SMS: ')).trim();
    if (!/^[0-9]{4,8}$/.test(otp)) throw new Error('OTP_INVALID');
    const verified = await post(base, '/api/auth/verify-otp', { otp, processId: init.processId });
    if (!verified.success) throw new Error('OTP_REJECTED');
    const env = sessionEnv(verified);
    const temporary = out + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, env, { mode: 0o600, flag: 'wx' });
    await rename(temporary, out);
    console.log(
      JSON.stringify({
        loggedIn: true,
        organization: String(verified.orgName ?? '').slice(0, 120),
        sessionFile: out,
        next: 'restart pickchick-kaspi-worker',
      }),
    );
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ loggedIn: false, reason: String(error.message).slice(0, 80) }));
    process.exitCode = 1;
  });
}
