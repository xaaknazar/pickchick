// Read-only credential probe. Never creates a payment, changes a terminal, or prints secrets.
import { pathToFileURL } from 'node:url';
export async function checkTipTopPay(env, request = fetch) {
  const publicId = env.TIPTOPPAY_PUBLIC_ID ?? '';
  const secret = env.TIPTOPPAY_API_SECRET ?? '';
  if (!/^pk_[a-zA-Z0-9]+$/.test(publicId) || secret.length < 16)
    return { credentialsAccepted: false, reason: 'credentials_missing' };
  try {
    const response = await request('https://api.tiptoppay.kz/test', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: 'Basic ' + Buffer.from(publicId + ':' + secret).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!response.ok) return { credentialsAccepted: false, reason: 'provider_rejected' };
    const body = await response.json();
    return {
      credentialsAccepted: body?.Success === true,
      reason: body?.Success === true ? 'ok' : 'provider_rejected',
    };
  } catch {
    return { credentialsAccepted: false, reason: 'network_or_response_error' };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkTipTopPay(process.env);
  console.log(JSON.stringify({ ...result, paymentAttempted: false, liveModeVerified: false }));
  if (!result.credentialsAccepted) process.exitCode = 1;
}
