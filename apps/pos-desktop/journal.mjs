import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

export const JOURNAL_LIMIT = 100000;
export const JOURNAL_PREFIX = 'pickchick.pos.journal.v1.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = () => {
  throw new Error('STORAGE_UNAVAILABLE');
};
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail();
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !uuid.test(value)) fail();
}
function integer(value, min = 1, max = 2147483647) {
  if (!Number.isInteger(value) || value < min || value > max) fail();
}
function text(value, max = 300) {
  if (typeof value !== 'string' || !value.length || value.length > max) fail();
}
export function validateJournal(key, raw, scope) {
  if (typeof scope !== 'string' || scope.split('.').length !== 3) fail();
  scope.split('.').forEach(id);
  if (
    key !== JOURNAL_PREFIX + scope ||
    typeof raw !== 'string' ||
    Buffer.byteLength(raw, 'utf8') > JOURNAL_LIMIT
  )
    fail();
  const j = exact(JSON.parse(raw), ['version', 'scope', 'draft', 'pending', 'known', 'selected']);
  if (j.version !== 1 || j.scope !== scope || !Array.isArray(j.known) || j.known.length > 100)
    fail();
  j.known.forEach(id);
  if (j.selected !== null) id(j.selected);
  if (j.draft !== null) {
    const d = exact(j.draft, ['release_id', 'service_mode', 'items']);
    id(d.release_id);
    if (
      !['takeaway', 'dine_in'].includes(d.service_mode) ||
      !Array.isArray(d.items) ||
      d.items.length > 50
    )
      fail();
    d.items.forEach((item) => {
      exact(item, ['variant_id', 'quantity']);
      id(item.variant_id);
      integer(item.quantity, 1, 99);
    });
    if (new Set(d.items.map((item) => item.variant_id)).size !== d.items.length) fail();
  }
  if (j.pending !== null) {
    const p = exact(j.pending, ['key', 'path', 'body', 'kind', 'at']);
    id(p.key);
    text(p.at, 40);
    if (!/^\d{4}-\d\d-\d\dT/.test(p.at) || !Number.isFinite(Date.parse(p.at))) fail();
    if (p.kind === 'create') {
      if (p.path !== 'orders') fail();
      exact(p.body, ['quote_id']);
      id(p.body.quote_id);
    } else if (p.kind === 'cancel') {
      text(p.path, 160);
      const parts = p.path.split('/');
      if (parts.length !== 3 || parts[0] !== 'orders' || parts[2] !== 'cancel') fail();
      id(parts[1]);
      exact(p.body, ['expected_version', 'reason']);
      integer(p.body.expected_version);
      text(p.body.reason);
    } else if (p.kind === 'ordering') {
      if (!['ordering/open', 'ordering/close'].includes(p.path)) fail();
      exact(p.body, ['expected_version']);
      integer(p.body.expected_version);
    } else if (p.kind === 'stop') {
      if (p.path !== 'availability/stops') fail();
      exact(p.body, ['variant_id', 'expected_version', 'reason', 'stopped']);
      id(p.body.variant_id);
      integer(p.body.expected_version, 0);
      text(p.body.reason);
      if (typeof p.body.stopped !== 'boolean') fail();
    } else fail();
  }
  return raw;
}

/** A bounded Store for the existing controller. No token, path, delete, or network API. */
export function createJournalStore({
  directory,
  fsImpl = fs,
  platform = process.platform,
  now = Date.now,
}) {
  if (!isAbsolute(directory)) fail();
  let authority = null;
  function ensureDirectory() {
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fsImpl.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  }
  function scopedPath(key) {
    if (!authority || now() >= authority.expiresAt || key !== JOURNAL_PREFIX + authority.scope)
      fail();
    ensureDirectory();
    return join(directory, createHash('sha256').update(key).digest('hex') + '.json');
  }
  function read(key, path) {
    try {
      const stat = fsImpl.lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > JOURNAL_LIMIT) fail();
      return validateJournal(key, fsImpl.readFileSync(path, 'utf8'), authority.scope);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  return {
    setSession(value, expectedSessionId) {
      authority = null;
      try {
        const s = exact(value, [
          'session_id',
          'staff_id',
          'terminal_id',
          'branch_id',
          'role',
          'expires_at',
        ]);
        for (const field of ['session_id', 'staff_id', 'terminal_id', 'branch_id']) id(s[field]);
        if (s.session_id !== expectedSessionId || !['cashier', 'shift_manager'].includes(s.role))
          return;
        text(s.expires_at, 40);
        const expiresAt = Date.parse(s.expires_at);
        if (!Number.isFinite(expiresAt) || expiresAt <= now()) return;
        authority = { scope: `${s.branch_id}.${s.staff_id}.${s.terminal_id}`, expiresAt };
      } catch {
        /* Failed or invalid session revokes journal access. */
      }
    },
    getItem(key) {
      return read(key, scopedPath(key));
    },
    setItem(key, value) {
      const path = scopedPath(key);
      validateJournal(key, value, authority.scope);
      // A corrupted existing file is a stop condition, never an empty journal.
      read(key, path);
      const temporary = join(directory, `.write-${randomUUID()}.tmp`);
      let fd;
      let failure;
      try {
        fd = fsImpl.openSync(temporary, 'wx', 0o600);
        fsImpl.writeFileSync(fd, value, 'utf8');
        fsImpl.fsyncSync(fd);
        fsImpl.closeSync(fd);
        fd = undefined;
        // Same directory / volume. Never unlink the previous journal first.
        fsImpl.renameSync(temporary, path);
        // Windows cannot portably open/fsync a directory through Node. The file
        // is flushed before replacement; physical power-loss is not certified.
        if (platform !== 'win32') {
          fd = fsImpl.openSync(directory, 'r');
          fsImpl.fsyncSync(fd);
          fsImpl.closeSync(fd);
          fd = undefined;
        }
      } catch (error) {
        failure = error;
      } finally {
        try {
          if (fd !== undefined) fsImpl.closeSync(fd);
        } catch (error) {
          failure ??= error;
        }
        try {
          fsImpl.unlinkSync(temporary);
        } catch (error) {
          if (error.code !== 'ENOENT') failure ??= error;
        }
      }
      if (failure) throw failure;
    },
  };
}
