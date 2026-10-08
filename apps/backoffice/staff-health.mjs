import { get } from 'node:http';
import { pathToFileURL } from 'node:url';

// Node fetch does not preserve a custom Host header. Use HTTP on loopback only.
export function checkStaffHealth(port = 4177) {
  return new Promise((resolve) => {
    const req = get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/backoffice/auth/session',
        headers: { Host: 'pickchick.kz' },
        timeout: 2500,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1024) req.destroy(new Error('Unexpected health response'));
        });
        res.on('error', () => resolve(false));
        res.on('end', () => {
          try {
            const session = JSON.parse(body);
            resolve(
              res.statusCode === 200 && session.enabled === true && session.authenticated === false,
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Health timeout')));
    req.on('error', () => resolve(false));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = (await checkStaffHealth()) ? 0 : 1;
