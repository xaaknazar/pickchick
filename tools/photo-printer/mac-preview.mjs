import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PhotoService, handler } from './service.mjs';
import { sendMacUsb, validUsbUri, usbPrinters } from './mac-usb.mjs';

export function macPreviewHandler({ service, root, origin }) {
  const api = handler(service, [origin]);
  const host = new URL(origin).host;
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ttf': 'font/ttf',
    '.woff2': 'font/woff2',
    '.mp4': 'video/mp4',
    '.svg': 'image/svg+xml',
  };
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    // Exact Host blocks DNS rebinding; no LAN listener, foreign origin or unauthenticated pairing.
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin))
      return res.writeHead(403).end();
    if (req.url.startsWith('/v1/')) {
      if (req.url.startsWith('/v1/pair')) return res.writeHead(403).end();
      return api(req, res);
    }
    if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405).end();
    try {
      const pathname = decodeURIComponent(new URL(req.url, origin).pathname);
      const file = resolve(root, pathname === '/' ? 'index.html' : '.' + pathname);
      if (!file.startsWith(root + sep)) return res.writeHead(404).end();
      const details = await stat(file);
      if (!details.isFile()) return res.writeHead(404).end();
      res.writeHead(200, {
        'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        'Content-Length': details.size,
      });
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  };
}

async function start() {
  if (process.platform !== 'darwin') throw Error('This operator preview is for macOS only.');
  process.umask(0o077);
  const config = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
  if (!validUsbUri(config.usbUri) || ![384, 512, 576].includes(config.width))
    throw Error('Confirm ESC/POS USB printer and raster width in local config.');
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)
    throw Error('Invalid port.');
  const enabled = config.protocolConfirmed === true;
  if (enabled && !(await usbPrinters()).includes(config.usbUri))
    throw Error('Selected ESC/POS USB printer not connected.');
  const root = resolve(config.webRoot);
  // Refuse a normal public/native kiosk export or one with live commerce enabled.
  if (JSON.parse(readFileSync(resolve(root, 'photo-mac-build.json'), 'utf8')).localOnly !== true)
    throw Error('Build the isolated Mac preview first.');
  const database = resolve(config.database);
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const service = new PhotoService({
    database,
    logoPath: fileURLToPath(new URL('../../apps/kiosk/assets/v3/logo.webp', import.meta.url)),
    width: config.width,
    cut: config.cut === true,
    enabled,
    send: (bytes) =>
      sendMacUsb(config.usbUri, bytes, {
        report: (status) => console.log('USB transport result:', JSON.stringify(status)),
      }),
  });
  const tokenPath = database + '.token';
  let token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
  try {
    service.authenticate(token);
  } catch {
    token = service.pair(service.pairing()).token;
    writeFileSync(tokenPath, token, { mode: 0o600 });
  }
  const origin = 'http://127.0.0.1:' + config.port;
  const server = http.createServer(macPreviewHandler({ service, root, origin }));
  server.requestTimeout = 25000;
  server.headersTimeout = 10000;
  server.listen(config.port, '127.0.0.1', () => {
    // Operator link stays in a private local file, not stdout/CI logs.
    writeFileSync(database + '.url', origin + '/#photo-key=' + token, { mode: 0o600 });
    console.log(
      'Mac photo preview ready: ' + origin + ' (open the private .url file with the launcher).',
    );
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () =>
      server.close(() => {
        service.close();
        process.exit(0);
      }),
    );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await start();
