import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Probe container liveness, not edge connectivity. Orders have separate recovery UI.
// node:http preserves Host; fetch may replace it with the loopback URL's host.
export function checkPortal({ origin, port = 4193, timeoutMs = 2000 }) {
  const host = new URL(origin).host;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/kitchen-live/health',
        headers: { Host: host },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else reject(new Error('PORTAL_UNHEALTHY'));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
    await checkPortal({ origin: config.origin });
  } catch {
    // Never print private config or transport details in Docker health logs.
    process.exitCode = 1;
  }
}
