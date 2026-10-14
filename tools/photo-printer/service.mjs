import { randomBytes, randomUUID, createHash, randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setInterval, clearInterval } from 'node:timers';
import { preparePhoto, escpos } from './raster.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const uuid = (s) =>
  typeof s === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
export class PhotoError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.status = status;
  }
}

/** Device-local print metadata only. Never stores photographs, names, orders or payment data. */
export class PhotoService {
  constructor({
    database,
    logoPath,
    width = 576,
    cut = false,
    enabled = false,
    send,
    now = Date.now,
  }) {
    this.db = new DatabaseSync(database);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS devices (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, device TEXT NOT NULL,
        preview TEXT NOT NULL UNIQUE, state TEXT NOT NULL, created_at INTEGER NOT NULL);
      UPDATE jobs SET state='unknown' WHERE state='sending';`);
    this.logoPath = logoPath;
    this.width = width;
    this.cut = cut;
    this.enabled = enabled;
    this.send = send;
    this.now = now;
    this.previews = new Map();
    this.rendering = false;
    this.printing = false;
    this.pairCode = null;
    this.pairUntil = 0;
    this.pairAttempts = 0;
    this.lastPreview = new Map();
    this.timer = setInterval(() => this.purge(), 10000);
    this.timer.unref();
  }
  pairing() {
    this.pairCode = String(randomInt(100000, 1000000));
    this.pairUntil = this.now() + 300000;
    this.pairAttempts = 0;
    return this.pairCode;
  }
  pair(code) {
    if (
      !this.pairCode ||
      this.now() >= this.pairUntil ||
      ++this.pairAttempts > 10 ||
      code !== this.pairCode
    )
      throw new PhotoError('PAIRING_DENIED', 403);
    this.pairCode = null;
    const token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO devices VALUES (?,?)').run(hash(token), this.now());
    return { token };
  }
  authenticate(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
      throw new PhotoError('UNAUTHORIZED', 401);
    const device = hash(token);
    if (!this.db.prepare('SELECT 1 FROM devices WHERE token_hash=?').get(device))
      throw new PhotoError('UNAUTHORIZED', 401);
    return device;
  }
  status() {
    return { printingEnabled: this.enabled, width: this.width, confirmation: 'transport-only' };
  }
  forget(id) {
    const p = this.previews.get(id);
    if (p) {
      p.bits.fill(0);
      p.png.fill(0);
      this.previews.delete(id);
    }
  }
  purge() {
    for (const [id, p] of this.previews) if (p.expiresAt <= this.now()) this.forget(id);
  }
  async preview(device, base64) {
    this.purge();
    if (this.rendering || this.printing || this.now() - (this.lastPreview.get(device) ?? 0) < 2000)
      throw new PhotoError('BUSY', 429);
    if (
      typeof base64 !== 'string' ||
      base64.length > 7000000 ||
      base64.length < 4 ||
      base64.length % 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
    )
      throw new PhotoError('INVALID_IMAGE');
    if (this.previews.size >= 8) throw new PhotoError('BUSY', 429);
    this.rendering = true;
    this.lastPreview.set(device, this.now());
    const input = Buffer.from(base64, 'base64');
    try {
      for (const [id, p] of this.previews) if (p.device === device) this.forget(id);
      const photo = await preparePhoto(input, this.logoPath, this.width);
      const id = randomUUID(),
        expiresAt = this.now() + 90000;
      this.previews.set(id, { ...photo, device, expiresAt });
      return {
        id,
        expiresAt,
        width: photo.width,
        height: photo.height,
        png: photo.png.toString('base64'),
      };
    } catch {
      throw new PhotoError('INVALID_IMAGE');
    } finally {
      input.fill(0);
      this.rendering = false;
    }
  }
  deletePreview(device, id) {
    if (this.previews.get(id)?.device === device) this.forget(id);
  }
  job(device, id) {
    if (!uuid(id)) throw new PhotoError('INVALID_JOB');
    const row = this.db
      .prepare('SELECT id,preview,state FROM jobs WHERE id=? AND device=?')
      .get(id, device);
    if (!row) throw new PhotoError('NOT_FOUND', 404);
    return { id: row.id, previewId: row.preview, state: row.state };
  }
  async print(device, id, previewId) {
    if (!uuid(id) || !uuid(previewId)) throw new PhotoError('INVALID_JOB');
    const previous = this.db
      .prepare('SELECT device,preview FROM jobs WHERE id=? OR preview=?')
      .get(id, previewId);
    if (previous) {
      if (previous.device !== device || previous.preview !== previewId)
        throw new PhotoError('JOB_CONFLICT', 409);
      const exact = this.db.prepare('SELECT id FROM jobs WHERE preview=?').get(previewId);
      if (exact.id !== id) throw new PhotoError('ALREADY_SUBMITTED', 409);
      return this.job(device, id);
    }
    if (!this.enabled) throw new PhotoError('NOT_CONFIGURED', 503);
    if (this.printing || this.rendering) throw new PhotoError('BUSY', 429);
    this.purge();
    const photo = this.previews.get(previewId);
    if (!photo || photo.device !== device) throw new PhotoError('PREVIEW_EXPIRED', 410);
    const count = this.db
      .prepare('SELECT COUNT(*) AS n FROM jobs WHERE device=? AND created_at>?')
      .get(device, this.now() - 3600000).n;
    const recent = this.db.prepare('SELECT 1 FROM jobs WHERE created_at>?').get(this.now() - 15000);
    if (count >= 20 || recent) throw new PhotoError('PRINT_LIMIT', 429);
    const bytes = escpos(photo.bits, photo.width, photo.height, this.cut);
    // Commit before attempting any external effect. On restart, sending becomes unknown.
    this.db
      .prepare('INSERT INTO jobs VALUES (?,?,?,?,?)')
      .run(id, device, previewId, 'sending', this.now());
    this.printing = true;
    this.forget(previewId);
    let state = 'unknown';
    try {
      state = await this.send(bytes);
    } catch {
      /* A lost result never permits another automatic print. */
    } finally {
      bytes.fill(0);
      this.printing = false;
    }
    if (!['sent', 'failed', 'unknown'].includes(state)) state = 'unknown';
    this.db.prepare('UPDATE jobs SET state=? WHERE id=?').run(state, id);
    return this.job(device, id);
  }
  close() {
    clearInterval(this.timer);
    for (const id of this.previews.keys()) this.forget(id);
    this.db.close();
  }
}

async function body(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 7100000) throw new PhotoError('TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new PhotoError('INVALID_JSON');
  }
}

export function handler(service, allowedOrigins = []) {
  let inflight = 0;
  return async (request, response) => {
    const reply = (status, data) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(JSON.stringify(data));
    };
    if (++inflight > 4) {
      inflight--;
      reply(429, { code: 'BUSY' });
      return;
    }
    try {
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) throw new PhotoError('ORIGIN_DENIED', 403);
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      }
      if (request.method === 'OPTIONS') {
        reply(204, {});
        return;
      }
      const path = new URL(request.url, 'https://photo.local').pathname;
      if (request.method === 'POST' && request.headers['content-type'] !== 'application/json')
        throw new PhotoError('JSON_REQUIRED', 415);
      if (path === '/v1/pair' && request.method === 'POST') {
        reply(200, service.pair((await body(request)).code));
        return;
      }
      const device = service.authenticate(request.headers.authorization?.replace(/^Bearer /, ''));
      if (path === '/v1/status' && request.method === 'GET') reply(200, service.status());
      else if (path === '/v1/previews' && request.method === 'POST')
        reply(200, await service.preview(device, (await body(request)).image));
      else if (path.startsWith('/v1/previews/') && request.method === 'DELETE') {
        service.deletePreview(device, path.split('/').pop());
        reply(200, { deleted: true });
      } else if (path === '/v1/jobs' && request.method === 'POST') {
        const b = await body(request);
        reply(200, await service.print(device, b.id, b.previewId));
      } else if (path.startsWith('/v1/jobs/') && request.method === 'GET')
        reply(200, service.job(device, path.split('/').pop()));
      else throw new PhotoError('NOT_FOUND', 404);
    } catch (error) {
      reply(error instanceof PhotoError ? error.status : 500, {
        code: error instanceof PhotoError ? error.message : 'SERVICE_ERROR',
      });
    } finally {
      inflight--;
    }
  };
}
