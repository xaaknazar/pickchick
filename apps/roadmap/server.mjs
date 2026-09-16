import { createServer } from 'node:http';
import { readFile, mkdir, chmod } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReview } from './model.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const staticFiles = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']],
  ['app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const security = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

/** Independent team planning data, never restaurant orders or financial effects. */
export async function createRoadmapServer({
  assetDir = fileURLToPath(new URL('dist/', import.meta.url)),
  dataDir,
  key,
  origin,
  prefix = '/roadmap',
  sessionTtlMs = 7 * 86400_000,
}) {
  const publicUrl = new URL(origin);
  if (
    publicUrl.origin !== origin ||
    publicUrl.pathname !== '/' ||
    !['https:', 'http:'].includes(publicUrl.protocol)
  )
    throw new Error('Invalid origin');
  if (publicUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(publicUrl.hostname))
    throw new Error('HTTPS required');
  if (!/^[a-zA-Z0-9_-]{40,128}$/.test(key) || prefix !== '/roadmap' || !dataDir)
    throw new Error('Invalid configuration');
  const project = JSON.parse(await readFile(resolve(assetDir, 'project.json'), 'utf8'));
  const taskIds = new Set(project.tasks.map((t) => t.id));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const dbPath = resolve(dataDir, 'roadmap.sqlite');
  const db = new DatabaseSync(dbPath);
  await chmod(dbPath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS reviews (task_id TEXT PRIMARY KEY, version INTEGER NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history (revision INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL, key_digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS login_attempts (at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS login_attempts_at ON login_attempts(at);`);
  const keyDigest = hash(key);
  db.prepare('DELETE FROM sessions WHERE key_digest != ? OR expires < ?').run(
    keyDigest,
    Date.now(),
  );
  const cookieName = 'pickchick_roadmap';
  const cookie = (value, age) =>
    `${cookieName}=${value}; Path=${prefix}/; HttpOnly; SameSite=Strict; Max-Age=${age}${publicUrl.protocol === 'https:' ? '; Secure' : ''}`;
  const revision = () =>
    db.prepare('SELECT coalesce(max(revision),0) AS revision FROM history').get().revision;
  const getReview = (id) => {
    const row = db.prepare('SELECT value FROM reviews WHERE task_id = ?').get(id);
    return row ? JSON.parse(row.value) : null;
  };
  const state = () => ({
    revision: revision(),
    reviews: Object.fromEntries(
      db
        .prepare('SELECT task_id,value FROM reviews')
        .all()
        .map((r) => [r.task_id, JSON.parse(r.value)]),
    ),
    history: db
      .prepare('SELECT revision,task_id,value FROM history ORDER BY revision DESC LIMIT 100')
      .all()
      .map((r) => ({ revision: r.revision, taskId: r.task_id, ...JSON.parse(r.value) })),
  });
  const readBody = async (req) => {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json')
      throw Object.assign(new Error('JSON_REQUIRED'), { status: 415 });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 16_384) throw Object.assign(new Error('BODY_TOO_LARGE'), { status: 413 });
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw Object.assign(new Error('INVALID_JSON'), { status: 400 });
    }
  };
  const server = createServer(async (req, res) => {
    const send = (status, body, extra = {}) => {
      res.writeHead(status, {
        ...security,
        'Content-Type': 'application/json; charset=utf-8',
        ...extra,
      });
      res.end(JSON.stringify(body));
    };
    try {
      const path = new URL(req.url, origin).pathname;
      const mutation = !['GET', 'HEAD'].includes(req.method);
      if (
        mutation &&
        (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site')
      ) {
        send(403, { code: 'ORIGIN_REJECTED' });
        return;
      }
      if (path === `${prefix}/health` && req.method === 'GET') {
        send(200, { status: 'up', sourceSha: project.meta.sourceSha });
        return;
      }
      if (path === prefix && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(308, { ...security, Location: `${prefix}/` });
        res.end();
        return;
      }
      if (!path.startsWith(`${prefix}/`)) {
        send(404, { code: 'NOT_FOUND' });
        return;
      }
      const relative = path.slice(prefix.length + 1);
      if (staticFiles.has(relative) && ['GET', 'HEAD'].includes(req.method)) {
        const [name, mime] = staticFiles.get(relative);
        const file = await readFile(resolve(assetDir, name));
        res.writeHead(200, { ...security, 'Content-Type': mime });
        res.end(req.method === 'HEAD' ? undefined : file);
        return;
      }
      if (relative === 'api/session' && req.method === 'POST') {
        const now = Date.now();
        db.prepare('DELETE FROM login_attempts WHERE at < ?').run(now - 60_000);
        if (db.prepare('SELECT count(*) AS count FROM login_attempts').get().count >= 10) {
          send(429, { code: 'LOGIN_LIMIT' }, { 'Retry-After': '60' });
          return;
        }
        db.prepare('INSERT INTO login_attempts(at) VALUES (?)').run(now);
        const body = await readBody(req);
        if (
          typeof body?.key !== 'string' ||
          !timingSafeEqual(Buffer.from(hash(body.key.trim())), Buffer.from(keyDigest))
        ) {
          send(401, { code: 'INVALID_KEY' });
          return;
        }
        const token = randomBytes(32).toString('base64url');
        db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
        db.prepare('INSERT INTO sessions(digest,expires,key_digest) VALUES (?,?,?)').run(
          hash(token),
          now + sessionTtlMs,
          keyDigest,
        );
        send(200, { ok: true }, { 'Set-Cookie': cookie(token, Math.floor(sessionTtlMs / 1000)) });
        return;
      }
      if (
        !['api/project', 'api/session'].includes(relative) &&
        !/^api\/reviews\/[a-z][a-z0-9-]{1,79}$/.test(relative)
      ) {
        send(404, { code: 'NOT_FOUND' });
        return;
      }
      const token = (req.headers.cookie ?? '')
        .split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      if (
        !token ||
        !db
          .prepare(
            'SELECT digest FROM sessions WHERE digest = ? AND expires > ? AND key_digest = ?',
          )
          .get(hash(token), Date.now(), keyDigest)
      ) {
        send(401, { code: 'SIGN_IN_REQUIRED' });
        return;
      }
      if (relative === 'api/session' && req.method === 'DELETE') {
        db.prepare('DELETE FROM sessions WHERE digest = ?').run(hash(token));
        send(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
        return;
      }
      if (relative === 'api/project' && req.method === 'GET') {
        send(200, { ...project, state: state() });
        return;
      }
      const match = /^api\/reviews\/([a-z][a-z0-9-]{1,79})$/.exec(relative);
      if (match && req.method === 'POST') {
        const id = match[1];
        if (!taskIds.has(id)) {
          send(404, { code: 'TASK_NOT_FOUND' });
          return;
        }
        const body = await readBody(req);
        if (!validateReview(body)) {
          send(400, { code: 'INVALID_REVIEW' });
          return;
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          const previous = getReview(id);
          if ((previous?.version ?? 0) !== body.expectedVersion) {
            db.exec('ROLLBACK');
            send(409, { code: 'VERSION_CONFLICT', review: previous });
            return;
          }
          const review = {
            status: body.status,
            result: body.result,
            author: body.author.trim(),
            note: body.note.trim(),
            version: body.expectedVersion + 1,
            updatedAt: new Date().toISOString(),
          };
          const encoded = JSON.stringify(review);
          db.prepare(
            'INSERT INTO reviews(task_id,version,value) VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET version=excluded.version,value=excluded.value',
          ).run(id, review.version, encoded);
          db.prepare('INSERT INTO history(task_id,value) VALUES (?,?)').run(id, encoded);
          const currentRevision = revision();
          db.exec('COMMIT');
          send(200, { review, revision: currentRevision });
          return;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      send(404, { code: 'NOT_FOUND' });
    } catch (error) {
      send(error.status ?? 500, { code: error.status ? error.message : 'INTERNAL_ERROR' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const key = (await readFile(process.env.ROADMAP_KEY_FILE, 'utf8')).trim();
  const server = await createRoadmapServer({
    dataDir: process.env.ROADMAP_DATA_DIR,
    key,
    origin: process.env.ROADMAP_ORIGIN,
  });
  const port = Number(process.env.ROADMAP_PORT ?? 4192);
  server.listen(port, process.env.ROADMAP_HOST ?? '127.0.0.1', () =>
    console.log(`Roadmap ready on port ${port}`),
  );
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
