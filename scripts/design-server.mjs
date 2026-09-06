import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.DESIGN_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DESIGN_PORT');
const types = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};
createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405);
      res.end();
      return;
    }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = pathname === '/' ? '/design/prototype/index.html' : pathname;
    const file = resolve(root, '.' + path);
    const allowed = ['design/prototype', 'packages/design-tokens'].some((dir) =>
      file.startsWith(resolve(root, dir) + sep),
    );
    if (!allowed || !types[extname(file)]) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type':
        types[extname(file)] +
        (['.html', '.css', '.js', '.json'].includes(extname(file)) ? '; charset=utf-8' : ''),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(port, '127.0.0.1', () => console.log(`Design review: http://127.0.0.1:${port}`));
