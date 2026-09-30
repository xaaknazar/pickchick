// Isolated gateway test fixture. It is never packaged into a serving release.
import { createServer } from 'node:http';
createServer((request, response) => {
  let bytes = 0;
  request.on('data', (chunk) => {
    bytes += chunk.length;
  });
  request.on('error', () => {
    response.destroy();
  });
  request.on('end', async () => {
    if (request.url === '/v1/test/orders/watch')
      await new Promise((resolve) => setTimeout(resolve, 11000));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        path: request.url,
        method: request.method,
        bytes,
        authorization: request.headers.authorization ?? null,
        cookie: request.headers.cookie ?? null,
        device: request.headers['x-device-id'] ?? null,
      }),
    );
  });
}).listen(3100, '0.0.0.0');
