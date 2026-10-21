// Test-only entry, synthetic bytes never go to a real printer.
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PhotoService } from '../../tools/photo-printer/service.mjs';
import { macPreviewHandler } from '../../tools/photo-printer/mac-preview.mjs';
const temporary = mkdtempSync(join(tmpdir(), 'photo-mac-browser-'));
let writes = 0;
const service = new PhotoService({
  database: join(temporary, 'jobs.sqlite'),
  logoPath: resolve('apps/kiosk/assets/v3/logo.webp'),
  enabled: true,
  send: async () => {
    writes++;
    return 'sent';
  },
});
const token = service.pair(service.pairing()).token;
const server = http.createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const handle = macPreviewHandler({ service, root: resolve('.local/photo-mac-web'), origin });
server.on('request', (req, res) => {
  if (req.url === '/test-writes') return res.end(JSON.stringify({ writes }));
  return handle(req, res);
});
console.log(JSON.stringify({ origin, token }));
process.once('SIGTERM', () =>
  server.close(() => {
    service.close();
    rmSync(temporary, { recursive: true, force: true });
    process.exit(0);
  }),
);
