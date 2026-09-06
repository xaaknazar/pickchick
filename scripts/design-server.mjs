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
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
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
    const headers = {
      'Content-Type':
        types[extname(file)] +
        (['.html', '.css', '.js', '.json'].includes(extname(file)) ? '; charset=utf-8' : ''),
      'Cache-Control': ['.mp4', '.woff2', '.jpg', '.png'].includes(extname(file))
        ? 'private, max-age=3600'
        : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    };
    if (req.headers.range && extname(file) === '.mp4') {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      const start = match ? Number(match[1]) : NaN;
      const end = match?.[2] ? Number(match[2]) : body.length - 1;
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        start >= body.length ||
        end < start ||
        end >= body.length
      ) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${body.length}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Content-Length': end - start + 1,
      });
      res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(port, '127.0.0.1', () => console.log(`Design review: http://127.0.0.1:${port}`));
