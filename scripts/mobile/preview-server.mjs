import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = process.env.PICKCHICK_PREVIEW_APP ?? 'mobile';
if (!['mobile', 'kiosk'].includes(app)) throw new Error('Unsupported preview app');
const root = resolve(dirname(fileURLToPath(import.meta.url)), `../../apps/${app}/dist`);
const port = Number(
  app === 'kiosk'
    ? (process.env.KIOSK_PREVIEW_PORT ?? 4184)
    : (process.env.MOBILE_PREVIEW_PORT ?? 8081),
);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml',
};
createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405).end();
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      response.writeHead(404).end();
      return;
    }
    if (!extname(pathname)) file = resolve(root, 'index.html');
    const details = await stat(file);
    if (!details.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Content-Length': details.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`${app} preview: http://127.0.0.1:${port}`));
