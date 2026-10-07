import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const params = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const cookieName = '__Host-pickchick_staff';
const digest = (s) => createHash('sha256').update(s).digest('hex');
export async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 256)
    throw new Error('Password must contain 16-256 characters');
  return { salt, hash: (await derive(password, salt, 32, params)).toString('hex') };
}
/** One deployed instance. Restart/revocation logs out all sessions; no financial state lives here. */
export function createStaffAccess(config, { now = Date.now } = {}) {
  if (
    !config ||
    config.version !== 1 ||
    config.username !== 'ceo' ||
    !/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(config.origin) ||
    !/^[a-f0-9]{32}$/.test(config.salt) ||
    !/^[a-f0-9]{64}$/.test(config.hash) ||
    !/^[a-f0-9]{64}$/.test(config.token)
  )
    throw new Error('Invalid private staff configuration');
  const sessions = new Map();
  let attempts = [],
    verifying = false;
  const clearCookie = `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
  const cleanup = () => {
    for (const [id, s] of sessions) if (s.expires <= now() || s.idle <= now()) sessions.delete(id);
    attempts = attempts.filter((t) => t > now() - 15 * 60 * 1000);
  };
  return async (req, res, send) => {
    cleanup();
    const path = req.url ?? '';
    if (
      req.headers.host !== new URL(config.origin).host ||
      (req.headers.origin && req.headers.origin !== config.origin) ||
      req.headers['sec-fetch-site'] === 'cross-site' ||
      (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== config.origin)
    ) {
      send(403, { code: 'FORBIDDEN' });
      return false;
    }
    const cookies = (req.headers.cookie ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith(cookieName + '='));
    const raw = cookies.length === 1 ? cookies[0].slice(cookieName.length + 1) : '';
    const id = /^[a-f0-9]{64}$/.test(raw) ? digest(raw) : '';
    const session = sessions.get(id);
    if (path === '/backoffice/auth/session' && req.method === 'GET') {
      send(200, { enabled: true, authenticated: !!session });
      return false;
    }
    if (path === '/backoffice/auth/logout' && req.method === 'POST') {
      sessions.delete(id);
      res.setHeader('Set-Cookie', clearCookie);
      send(200, { ok: true });
      return false;
    }
    if (path === '/backoffice/auth/login' && req.method === 'POST') {
      if (verifying || attempts.length >= 30) {
        res.setHeader('Retry-After', '900');
        send(429, { code: 'RATE_LIMITED' });
        return false;
      }
      attempts.push(now());
      if (req.headers['content-type'] !== 'application/json') {
        send(400, { code: 'INVALID_REQUEST' });
        return false;
      }
      let data;
      try {
        let size = 0;
        const chunks = [];
        for await (const c of req) {
          size += c.length;
          if (size > 2048) {
            send(413, { code: 'INVALID_REQUEST' });
            return false;
          }
          chunks.push(c);
        }
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          typeof data?.username !== 'string' ||
          data.username.length > 80 ||
          typeof data.password !== 'string' ||
          data.password.length > 256
        )
          throw new Error();
      } catch {
        send(400, { code: 'INVALID_REQUEST' });
        return false;
      }
      if (verifying) {
        send(429, { code: 'RATE_LIMITED' });
        return false;
      }
      verifying = true;
      let matches;
      try {
        const candidate = await derive(data.password, config.salt, 32, params);
        matches =
          timingSafeEqual(candidate, Buffer.from(config.hash, 'hex')) &&
          data.username.toLowerCase().trim() === config.username;
      } finally {
        verifying = false;
        data.password = '';
      }
      if (!matches) {
        send(401, { code: 'UNAUTHORIZED' });
        return false;
      }
      if (sessions.size >= 64) {
        send(429, { code: 'RATE_LIMITED' });
        return false;
      }
      sessions.delete(id);
      const value = randomBytes(32).toString('hex');
      sessions.set(digest(value), {
        expires: now() + 8 * 60 * 60 * 1000,
        idle: now() + 60 * 60 * 1000,
      });
      res.setHeader(
        'Set-Cookie',
        `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`,
      );
      send(200, { ok: true });
      return false;
    }
    if (path.startsWith('/backoffice/api/')) {
      if (!session) {
        send(401, { code: 'UNAUTHORIZED' });
        return false;
      }
      session.idle = now() + 60 * 60 * 1000;
      return {
        path: path.slice('/backoffice/api'.length),
        authorization: `Bearer ${config.token}`,
      };
    }
    if (path.startsWith('/v1/') || path.startsWith('/backoffice/auth/')) {
      send(404, { code: 'NOT_FOUND' });
      return false;
    }
    return { path };
  };
}
export const staffError = (payload, status) => ({
  ...payload,
  ...(status < 400
    ? {}
    : {
        message_key: `errors.${payload.code.toLowerCase()}`,
        trace_id: randomUUID(),
        retryable: [429, 503, 504].includes(status),
      }),
});
