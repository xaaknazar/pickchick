// Read-only bank check for a standalone bridge. Never issues an invoice or logs
// response data. Secrets are read by Node from the mounted private env file.
import { pathToFileURL } from 'node:url';

export async function checkSession(env = process.env, request = fetch) {
  const token = env.KASPI_SESSION_TOKEN_SN;
  const secret = env.KASPI_SESSION_VTOKEN_SECRET;
  const profile = env.KASPI_SESSION_PROFILE_ID;
  if (!token || !secret || !profile) return { active: false, reason: 'missing_session' };
  try {
    const response = await request('http://127.0.0.1:3931/api/session/check', {
      headers: { 'X-Token-SN': token, 'X-Vtoken-Secret': secret, 'X-Profile-Id': profile },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const body = response.ok ? await response.json() : null;
    return {
      active: body?.active === true,
      reason: body?.active === true ? 'verified' : 'not_verified',
    };
  } catch {
    return { active: false, reason: 'unavailable' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('READ_ONLY_CHECK_NO_ARGUMENTS');
  const result = await checkSession();
  console.log(JSON.stringify({ ...result, invoiceAttempted: false }));
  if (!result.active) process.exitCode = 1;
}
