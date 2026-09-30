import { request } from 'node:https';
import { readFile } from 'node:fs/promises';

try {
  if (process.argv.length !== 3) throw new Error();
  const data = await readFile(process.argv[2]);
  if (data.length > 16384) throw new Error();
  const config = JSON.parse(data.toString('utf8'));
  const probe = (path, trust = true) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: config.edgeHost,
          port: config.edgePort,
          path,
          method: 'GET',
          ...(trust ? { ca: config.edgeCertificatePem } : {}),
          rejectUnauthorized: true,
          timeout: 3000,
        },
        (res) => {
          const chunks = [];
          let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 4096) res.destroy();
            else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode,
                data: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch {
              reject(new Error());
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })));
      req.end();
    });
  let health;
  const deadline = Date.now() + 10000;
  while (!health) {
    try {
      health = await probe('/healthz');
    } catch (error) {
      if (!['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code))
        throw new Error('LAN_CHECK_UNAVAILABLE', { cause: error });
      if (Date.now() >= deadline) throw new Error('LAN_CHECK_UNAVAILABLE', { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (health.status !== 200 || health.data.service !== 'pickchick-kitchen-lan') throw new Error();
  let session;
  while (!session) {
    try {
      session = await probe('/edge/v1/session');
    } catch (error) {
      if (!['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code))
        throw new Error('LAN_CHECK_UNAVAILABLE', { cause: error });
    }
    if (session?.status === 401 && session.data.code === 'UNAUTHORIZED') break;
    if (session && ![502, 503, 504].includes(session.status)) throw new Error();
    if (Date.now() >= deadline) throw new Error();
    session = undefined;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const owner = await probe('/internal/v1/edge/pos-orders/events');
  if (owner.status !== 404) throw new Error();
  let untrustedRejected = false;
  try {
    await probe('/healthz', false);
  } catch {
    untrustedRejected = true;
  }
  if (!untrustedRejected) throw new Error();
  console.log(
    JSON.stringify({
      health: true,
      passwordRequired: true,
      ownerRouteBlocked: true,
      certificatePinRequired: true,
    }),
  );
} catch {
  console.error('KITCHEN_LAN_CHECK_FAILED');
  process.exitCode = 1;
}
