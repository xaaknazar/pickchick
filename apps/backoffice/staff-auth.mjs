import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const params = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const cookieName = '__Host-pickchick_staff';
const digest = (s) => createHash('sha256').update(s).digest('hex');
/** Lower-case login names; 'ceo' stays valid so the original account migrates unchanged. */
export const STAFF_USERNAME = /^[a-z][a-z0-9._-]{1,31}$/;
export const STAFF_MAX_ACCOUNTS = 32;
const ORIGIN = /^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => new Error('Invalid private staff configuration');
export async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 256)
    throw new Error('Password must contain 16-256 characters');
  return { salt, hash: (await derive(password, salt, 32, params)).toString('hex') };
}
function account(entry) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    Object.keys(entry).some(
      (key) => !['username', 'salt', 'hash', 'token', 'actor_id'].includes(key),
    ) ||
    !STAFF_USERNAME.test(entry.username ?? '') ||
    !/^[a-f0-9]{32}$/.test(entry.salt ?? '') ||
    !/^[a-f0-9]{64}$/.test(entry.hash ?? '') ||
    !/^[a-f0-9]{64}$/.test(entry.token ?? '') ||
    (entry.actor_id !== undefined && !UUID.test(entry.actor_id))
  )
    throw invalid();
  return {
    username: entry.username,
    salt: entry.salt,
    hash: entry.hash,
    token: entry.token,
    ...(entry.actor_id === undefined ? {} : { actor_id: entry.actor_id }),
  };
}
/**
 * Version 1 is the original single 'ceo' file. Version 2 lists one entry per person, each with
 * its own scrypt hash and its own catalog_manager bearer token (and optional actor_id), so
 * catalog_audit and bo_audit attribute every change to that person. Version 1 reads as a
 * one-account version 2 with 'ceo' as the first entry.
 */
export function parseStaffConfig(config) {
  if (!config || typeof config !== 'object' || !ORIGIN.test(config.origin ?? '')) throw invalid();
  let entries;
  if (config.version === 1) {
    if (config.username !== 'ceo') throw invalid();
    entries = [
      {
        username: 'ceo',
        salt: config.salt,
        hash: config.hash,
        token: config.token,
        ...(config.actor_id === undefined ? {} : { actor_id: config.actor_id }),
      },
    ];
  } else if (config.version === 2) {
    if (
      !Array.isArray(config.accounts) ||
      config.accounts.length < 1 ||
      config.accounts.length > STAFF_MAX_ACCOUNTS ||
      Object.keys(config).some((key) => !['version', 'origin', 'accounts'].includes(key))
    )
      throw invalid();
    entries = config.accounts;
  } else throw invalid();
  const accounts = entries.map(account);
  // Two people must never share a login or a credential: that would merge their audit trails.
  for (const key of ['username', 'token', 'actor_id', 'salt']) {
    const values = accounts.map((a) => a[key]).filter((v) => v !== undefined);
    if (new Set(values).size !== values.length) throw invalid();
  }
  return { version: 2, origin: config.origin, accounts };
}
const permissionError = () => new Error('Private staff accounts file required');
/**
 * The accounts file holds bearer tokens, so it must be a private regular file. Unix: no
 * group/other bits and owned by this process user (the container runs as the file owner).
 * Windows: the same NTFS ACL rules as the other staff secrets (scripts/staff-file-permissions).
 */
export async function assertPrivateStaffFile(
  path,
  { platform = process.platform, inspectAcl, uid = process.getuid?.() } = {},
) {
  const nativePath = resolve(path);
  const info = await lstat(nativePath);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 256 * 1024) throw permissionError();
  if (platform === 'win32') {
    const permissions = await import('../../scripts/staff-file-permissions.mjs');
    if (inspectAcl) permissions.validateStaffWindowsAcl(await inspectAcl(nativePath), 'file');
    else await permissions.assertPrivateStaffPath(nativePath, 'file');
    return;
  }
  if ((info.mode & 0o077) !== 0 || (uid !== undefined && uid !== 0 && info.uid !== uid))
    throw permissionError();
}
/** Reads the accounts file (BACKOFFICE_STAFF_FILE) after the permission check; never echoes it. */
export async function readStaffConfig(path, options) {
  await assertPrivateStaffFile(path, options);
  let config;
  try {
    config = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw invalid();
  }
  return parseStaffConfig(config);
}
export async function loadStaffAccess(path, options = {}) {
  return createStaffAccess(await readStaffConfig(path, options), options);
}
const PRIVATE_PEER = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/,
];
const unmapped = (value) =>
  value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value.toLowerCase();
/** IPv6 clients are limited per /64: one subscriber usually owns the whole block. */
function addressKey(value) {
  const ip = unmapped(value);
  if (isIP(ip) !== 6) return ip;
  const groups = (part) =>
    part ? part.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : [];
  const [head, tail] = ip.split('%')[0].split('::');
  const left = groups(head),
    right = groups(tail);
  const full =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return (
    full
      .slice(0, 4)
      .map((g) => parseInt(g, 16).toString(16))
      .join(':') + '::/64'
  );
}
/**
 * The deployed container has no published port: only the outer Caddy (a private Docker peer)
 * reaches it, and Caddy replaces X-Forwarded-For with the client it saw. The rightmost value is
 * that observation; anything left of it was supplied by the client. A public peer is the client.
 */
export function staffClientAddress(req) {
  const peer = unmapped(String(req.socket?.remoteAddress ?? ''));
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && PRIVATE_PEER.some((re) => re.test(peer))) {
    const last = forwarded.split(',').at(-1)?.trim() ?? '';
    if (isIP(last)) return addressKey(last);
  }
  return addressKey(peer);
}
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
/**
 * Failed password checks only. The first `free` failures within the window cost nothing; each
 * further failure locks the key for base * 2^n, capped. Locked keys are refused before scrypt,
 * so they cannot extend their own lock. Bounded: the oldest entries are evicted first.
 */
function backoff({ free, baseMs, maxMs, size }, now) {
  const entries = new Map();
  const current = (key) => {
    const entry = entries.get(key);
    if (entry && entry.last + FAILURE_WINDOW_MS <= now() && entry.until <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    retryAfter(key) {
      const entry = current(key);
      return entry && entry.until > now() ? Math.ceil((entry.until - now()) / 1000) : 0;
    },
    fail(key) {
      const entry = current(key) ?? { count: 0, until: 0, last: 0 };
      entry.count++;
      entry.last = now();
      if (entry.count >= free)
        entry.until = now() + Math.min(baseMs * 2 ** (entry.count - free), maxMs);
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > size) entries.delete(entries.keys().next().value);
    },
    clear: (key) => entries.delete(key),
    prune() {
      for (const key of [...entries.keys()]) current(key);
    },
  };
}
/** scrypt (N=2^17) holds 128 MiB per call: two at once, a short queue, then 429. */
function verificationSlots(active = 2, waiting = 8) {
  let running = 0;
  const queue = [];
  return {
    async run(task) {
      if (running >= active) {
        if (queue.length >= waiting) return { busy: true };
        await new Promise((resolve) => queue.push(resolve));
      } else running++;
      try {
        return { value: await task() };
      } finally {
        const next = queue.shift();
        if (next) next();
        else running--;
      }
    },
  };
}
/** One deployed instance. Restart/revocation logs out all sessions; no financial state lives here. */
export function createStaffAccess(raw, { now = Date.now } = {}) {
  const config = parseStaffConfig(raw);
  const accounts = new Map(config.accounts.map((a) => [a.username, a]));
  // An unknown login still runs one scrypt, so timing does not reveal which usernames exist.
  const decoy = { salt: randomBytes(16).toString('hex'), hash: randomBytes(32).toString('hex') };
  const sessions = new Map();
  // Per client address and per login name; no global window that anonymous traffic can fill.
  const byAddress = backoff({ free: 5, baseMs: 30_000, maxMs: 15 * 60_000, size: 4096 }, now);
  const byLogin = backoff({ free: 10, baseMs: 30_000, maxMs: 5 * 60_000, size: 1024 }, now);
  const slots = verificationSlots();
  const clearCookie = `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
  const cleanup = () => {
    for (const [id, s] of sessions) if (s.expires <= now() || s.idle <= now()) sessions.delete(id);
    byAddress.prune();
    byLogin.prune();
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
      const limited = (seconds) => {
        res.setHeader('Retry-After', String(seconds));
        send(429, { code: 'RATE_LIMITED' });
        return false;
      };
      const address = staffClientAddress(req);
      const addressWait = byAddress.retryAfter(address);
      if (addressWait) return limited(addressWait);
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
      // Unknown names are limited exactly like real ones, so a 429 does not reveal accounts.
      const login = data.username.toLowerCase().trim();
      const loginWait = byLogin.retryAfter(login);
      if (loginWait) return limited(loginWait);
      let checked;
      try {
        checked = await slots.run(async () => {
          const candidate = accounts.get(login);
          const target = candidate ?? decoy;
          const derived = await derive(data.password, target.salt, 32, params);
          return timingSafeEqual(derived, Buffer.from(target.hash, 'hex')) ? candidate : undefined;
        });
      } finally {
        data.password = '';
      }
      if (checked.busy) return limited(5);
      const user = checked.value;
      if (!user) {
        byAddress.fail(address);
        byLogin.fail(login);
        send(401, { code: 'UNAUTHORIZED' });
        return false;
      }
      byAddress.clear(address);
      byLogin.clear(login);
      if (sessions.size >= 64) {
        send(429, { code: 'RATE_LIMITED' });
        return false;
      }
      sessions.delete(id);
      const value = randomBytes(32).toString('hex');
      // The session carries this person's own token; no other account's token is reachable.
      sessions.set(digest(value), {
        expires: now() + 8 * 60 * 60 * 1000,
        idle: now() + 60 * 60 * 1000,
        username: user.username,
        token: user.token,
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
        authorization: `Bearer ${session.token}`,
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
