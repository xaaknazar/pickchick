import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFile,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
} from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';

/**
 * Scheduled backup of the cashier (edge) database to a second location (audit 6.4, owner action
 * 16). Pure Node logic so it can be tested without Windows; edge-backup-task.mjs wires it to the
 * real pg module, pg_dump.exe and the file system, install-edge-backup.ps1 registers the task.
 *
 * One run: exclusive run lock, the shared native maintenance lease, the destination must be
 * reachable, a REPEATABLE READ snapshot as the dedicated read-only backup role (cluster identity,
 * reviewed migration ledger 020-023, the one configured branch, row counts), pg_dump of exactly
 * that snapshot into the protected local staging folder, `pg_restore --list` must contain the
 * data of every table, then AES-256-GCM encryption straight into a temporary file at the
 * destination, fsync, rename, a full read-back that authenticates and re-hashes every byte, and
 * only then the sidecar that marks the copy complete. Retention runs only after a verified copy.
 * Plaintext never reaches the destination and is removed from staging in every outcome.
 * Logs and status carry codes and counts only: never passwords, keys, paths or row data.
 */
export const EDGE_BACKUP_SCHEMAS = Object.freeze({
  schema020: 20,
  schema021: 21,
  schema022: 22,
  schema023: 23,
});
export const EDGE_BACKUP_ERRORS = Object.freeze([
  'CONFIG_INVALID',
  'TOOL_INVALID',
  'KEY_INVALID',
  'KEY_MISMATCH',
  'CREDENTIAL_INVALID',
  'LOCKED',
  'MAINTENANCE',
  'DESTINATION_UNAVAILABLE',
  'DESTINATION_FULL',
  'DESTINATION_WRITE_FAILED',
  'DATABASE_UNAVAILABLE',
  'CLUSTER_MISMATCH',
  'BRANCH_MISMATCH',
  'UNREVIEWED_SCHEMA',
  'SNAPSHOT_FAILED',
  'DUMP_FAILED',
  'ARCHIVE_INCOMPLETE',
  'VERIFY_FAILED',
  'STATUS_WRITE_FAILED',
  'INTERNAL',
]);
export const EDGE_BACKUP_WARNINGS = Object.freeze(['RETENTION_FAILED', 'CLEANUP_FAILED']);
const SKIP_CODES = ['LOCKED', 'MAINTENANCE'];

export class EdgeBackupError extends Error {
  constructor(code) {
    const known = EDGE_BACKUP_ERRORS.includes(code) ? code : 'INTERNAL';
    super('Edge backup stopped: ' + known);
    this.name = 'EdgeBackupError';
    this.code = known;
  }
}
const fail = (code) => {
  throw new EdgeBackupError(code);
};
/** Runs one step; any foreign error becomes the step's code without its (possibly secret) text. */
async function step(code, run) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EdgeBackupError) throw error;
    throw new EdgeBackupError(code);
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = (length) => new RegExp(`^[a-f0-9]{${length}}$`);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) =>
  isObject(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const isoDate = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const identifier = (name) => {
  if (typeof name !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(name)) fail('INTERNAL');
  return '"' + name + '"';
};

// ---------------------------------------------------------------- reviewed schemas

function reviewedLedger(pinned) {
  if (
    !Array.isArray(pinned) ||
    pinned.length < Math.max(...Object.values(EDGE_BACKUP_SCHEMAS)) ||
    pinned.some(
      (row, index) =>
        !exactKeys(row, ['version', 'checksum', 'scope']) ||
        row.scope !== 'edge' ||
        typeof row.version !== 'string' ||
        !/^\d{3}_[a-z0-9_]+\.sql$/.test(row.version) ||
        !row.version.startsWith(String(index + 1).padStart(3, '0') + '_') ||
        typeof row.checksum !== 'string' ||
        !hex(64).test(row.checksum),
    )
  )
    fail('TOOL_INVALID');
  return pinned;
}

/**
 * The reviewed schema name of a live migration ledger: it must equal, row for row (file name,
 * SHA-256, scope), the pinned ledger prefix of one reviewed schema. Anything else is refused, so
 * a later migration (024+) stops the backup until it is reviewed here.
 */
export function verifiedSchema(ledger, pinned) {
  const reviewed = reviewedLedger(pinned);
  if (!Array.isArray(ledger)) fail('UNREVIEWED_SCHEMA');
  const entry = Object.entries(EDGE_BACKUP_SCHEMAS).find(([, length]) => length === ledger.length);
  if (!entry) fail('UNREVIEWED_SCHEMA');
  ledger.forEach((row, index) => {
    const want = reviewed[index];
    if (
      !exactKeys(row, ['version', 'checksum', 'scope']) ||
      row.version !== want.version ||
      row.checksum !== want.checksum ||
      row.scope !== want.scope
    )
      fail('UNREVIEWED_SCHEMA');
  });
  return entry[0];
}

// ---------------------------------------------------------------- configuration

export const CONFIG_FORMAT = 'pickchick-edge-backup-config-v1';
const CONFIG_KEYS = [
  'format',
  'branchId',
  'systemIdentifier',
  'stateRoot',
  'toolsRoot',
  'pgBin',
  'maintenanceLock',
  'destination',
  'retention',
  'timeZone',
  'maxAgeMinutes',
  'reportInHeartbeat',
];
const UNSAFE_PATH = /[\p{Cc}"*<>?|/]/u;

/** Absolute, normalized local Windows path below a drive root (never the root itself). */
export function isWindowsDrivePath(value) {
  return (
    typeof value === 'string' &&
    value.length <= 240 &&
    /^[A-Za-z]:\\[^\\]/.test(value) &&
    !value.slice(2).includes(':') &&
    !UNSAFE_PATH.test(value) &&
    !value.endsWith('\\') &&
    win32.normalize(value) === value &&
    value
      .split('\\')
      .slice(1)
      .every((part) => part !== '' && part !== '.' && part !== '..' && part.trim() === part)
  );
}

/** \\host\share[\folder...]: a NAS or file server share, never a device or long path prefix. */
export function isUncPath(value) {
  if (
    typeof value !== 'string' ||
    value.length > 240 ||
    UNSAFE_PATH.test(value) ||
    value.includes(':') ||
    value.endsWith('\\') ||
    !/^\\\\[A-Za-z0-9][A-Za-z0-9.-]{0,62}\\[A-Za-z0-9$][^\\]*(\\[^\\]+)*$/.test(value) ||
    win32.normalize(value) !== value
  )
    return false;
  return value
    .slice(2)
    .split('\\')
    .every((part) => part !== '' && part !== '.' && part !== '..' && part.trim() === part);
}

const driveOf = (path) => path.slice(0, 2).toUpperCase();
function validTimeZone(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validated scheduled-task configuration (private\edge-backup.json, written by
 * edge-backup-setup.mjs). The destination is a second disk (another drive letter than the
 * PostgreSQL data and state below ProgramData) or a UNC share. Returns a frozen copy.
 */
export function parseEdgeBackupConfig(value) {
  const retention = value?.retention;
  if (
    !exactKeys(value, CONFIG_KEYS) ||
    value.format !== CONFIG_FORMAT ||
    !uuid.test(value.branchId ?? '') ||
    typeof value.systemIdentifier !== 'string' ||
    !/^\d{10,20}$/.test(value.systemIdentifier) ||
    ![value.stateRoot, value.toolsRoot, value.pgBin, value.maintenanceLock].every(
      isWindowsDrivePath,
    ) ||
    value.maintenanceLock !==
      win32.join(win32.dirname(value.toolsRoot), 'unified-menu-maintenance.lock') ||
    !(
      (isWindowsDrivePath(value.destination) &&
        driveOf(value.destination) !== driveOf(value.stateRoot)) ||
      isUncPath(value.destination)
    ) ||
    !exactKeys(retention, ['hourly', 'daily']) ||
    !Number.isInteger(retention.hourly) ||
    retention.hourly < 1 ||
    retention.hourly > 168 ||
    !Number.isInteger(retention.daily) ||
    retention.daily < 1 ||
    retention.daily > 90 ||
    !validTimeZone(value.timeZone) ||
    !Number.isInteger(value.maxAgeMinutes) ||
    value.maxAgeMinutes < 60 ||
    value.maxAgeMinutes > 4320 ||
    typeof value.reportInHeartbeat !== 'boolean'
  )
    fail('CONFIG_INVALID');
  return Object.freeze({ ...value, retention: Object.freeze({ ...retention }) });
}

/** Fixed private layout below the protected state root (ACLs are set by the installer). */
export function backupLayout(stateRoot, path = win32) {
  return {
    keyFile: path.join(stateRoot, 'private', 'backup-key.json'),
    credentialFile: path.join(stateRoot, 'private', 'backup-db.json'),
    stagingDir: path.join(stateRoot, 'staging'),
    lockFile: path.join(stateRoot, 'staging', 'run.lock'),
    logFile: path.join(stateRoot, 'logs', 'edge-backup.log'),
    statusFile: path.join(stateRoot, 'health', 'status.json'),
  };
}

// ---------------------------------------------------------------- key and credential

export const KEY_FORMAT = 'pickchick-edge-backup-key-v1';
export const CREDENTIAL_FORMAT = 'pickchick-edge-backup-credential-v1';
export const BACKUP_ROLE = 'pickchick_edge_backup';

export function keyIdOf(key) {
  return createHash('sha256')
    .update('pickchick-edge-backup-key-id-v1\0')
    .update(key)
    .digest('hex')
    .slice(0, 16);
}

/** A new random 256-bit archive key. Kept on the cashier and, separately, by the owner. */
export function createBackupKey(now = new Date()) {
  const key = randomBytes(32);
  return {
    format: KEY_FORMAT,
    keyId: keyIdOf(key),
    key: key.toString('hex'),
    createdAt: now.toISOString(),
  };
}

export function parseBackupKey(value) {
  if (
    !exactKeys(value, ['format', 'keyId', 'key', 'createdAt']) ||
    value.format !== KEY_FORMAT ||
    typeof value.key !== 'string' ||
    !hex(64).test(value.key) ||
    !isoDate(value.createdAt)
  )
    fail('KEY_INVALID');
  const key = Buffer.from(value.key, 'hex');
  if (value.keyId !== keyIdOf(key)) fail('KEY_INVALID');
  return { keyId: value.keyId, key };
}

export function backupCredential(password) {
  if (typeof password !== 'string' || !hex(64).test(password)) fail('CREDENTIAL_INVALID');
  return { format: CREDENTIAL_FORMAT, role: BACKUP_ROLE, password };
}

export function parseBackupCredential(value) {
  if (
    !exactKeys(value, ['format', 'role', 'password']) ||
    value.format !== CREDENTIAL_FORMAT ||
    value.role !== BACKUP_ROLE ||
    typeof value.password !== 'string' ||
    !hex(64).test(value.password)
  )
    fail('CREDENTIAL_INVALID');
  return { role: value.role, password: value.password };
}

// ---------------------------------------------------------------- encrypted archive

export const ARCHIVE_EXTENSION = '.pcbak';
const MAGIC = Buffer.from('PCEDGEB1', 'ascii');
const ARCHIVE_FORMAT = 'pickchick-edge-backup-archive-v1';
export const META_FORMAT = 'pickchick-edge-backup-meta-v1';
const HKDF_INFO = Buffer.from(ARCHIVE_FORMAT, 'ascii');
const MAX_HEADER = 4096;
const MAX_META = 4 * 1024 * 1024;
const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
/** Two GCM messages per archive under a fresh HKDF subkey (random salt): nonces never repeat. */
const nonce = (index) => {
  const bytes = Buffer.alloc(12);
  bytes[11] = index;
  return bytes;
};
const subkey = (key, salt) => Buffer.from(hkdfSync('sha256', key, salt, HKDF_INFO, 32));

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    offset += bytesWritten;
  }
}

function validMeta(meta) {
  return (
    isObject(meta) &&
    meta.format === META_FORMAT &&
    typeof meta.dumpSha256 === 'string' &&
    hex(64).test(meta.dumpSha256) &&
    Number.isSafeInteger(meta.dumpBytes) &&
    meta.dumpBytes > 0 &&
    isoDate(meta.createdAt)
  );
}

/**
 * Layout: "PCEDGEB1" | u32 header length | header JSON (key id, HKDF salt, time) | u32 meta
 * length | AES-256-GCM(meta JSON) | tag | AES-256-GCM(pg_dump archive) | tag. The magic and
 * header are authenticated by both messages. The target is created exclusively and removed if
 * anything fails or the source differs from the hash recorded in the meta.
 */
export async function writeEncryptedArchive({ source, target, key, meta }) {
  if (!validMeta(meta)) fail('ARCHIVE_INCOMPLETE');
  const info = await stat(source);
  if (!info.isFile() || info.size !== meta.dumpBytes) fail('ARCHIVE_INCOMPLETE');
  const salt = randomBytes(32);
  const header = Buffer.from(
    JSON.stringify({
      format: ARCHIVE_FORMAT,
      cipher: 'aes-256-gcm',
      kdf: 'hkdf-sha256',
      keyId: key.keyId,
      salt: salt.toString('hex'),
      createdAt: meta.createdAt,
    }),
  );
  const prefix = Buffer.concat([MAGIC, u32(header.length), header]);
  const derived = subkey(key.key, salt);
  const metaCipher = createCipheriv('aes-256-gcm', derived, nonce(1));
  metaCipher.setAAD(prefix);
  const metaBytes = Buffer.concat([metaCipher.update(JSON.stringify(meta)), metaCipher.final()]);
  if (metaBytes.length > MAX_META) fail('ARCHIVE_INCOMPLETE');
  const dataCipher = createCipheriv('aes-256-gcm', derived, nonce(2));
  dataCipher.setAAD(prefix);
  const archiveHash = createHash('sha256');
  const plainHash = createHash('sha256');
  let plainBytes = 0;
  let archiveBytes = 0;
  const handle = await open(target, 'wx', 0o600);
  let complete = false;
  try {
    const write = async (bytes) => {
      archiveHash.update(bytes);
      archiveBytes += bytes.length;
      await writeAll(handle, bytes);
    };
    await write(prefix);
    await write(u32(metaBytes.length));
    await write(metaBytes);
    await write(metaCipher.getAuthTag());
    for await (const chunk of createReadStream(source)) {
      plainHash.update(chunk);
      plainBytes += chunk.length;
      await write(dataCipher.update(chunk));
    }
    await write(dataCipher.final());
    await write(dataCipher.getAuthTag());
    if (plainHash.digest('hex') !== meta.dumpSha256 || plainBytes !== meta.dumpBytes)
      fail('ARCHIVE_INCOMPLETE');
    await handle.sync();
    complete = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!complete) await rm(target, { force: true }).catch(() => undefined);
  }
  return { archiveBytes, archiveSha256: archiveHash.digest('hex') };
}

/**
 * Authenticates and decrypts a whole archive. Returns the header, the decrypted meta and the
 * hashes of the archive file and the restored pg_dump bytes. With `output`, the dump is written
 * to a new file (never overwritten) that is removed again unless every check passed.
 */
export async function readEncryptedArchive({ file, key, output }) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const readExact = async (position, length) => {
      if (position < 0 || length < 0 || position + length > size) fail('VERIFY_FAILED');
      const bytes = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(bytes, done, length - done, position + done);
        if (!bytesRead) fail('VERIFY_FAILED');
        done += bytesRead;
      }
      return bytes;
    };
    if (size < 12 || !(await readExact(0, 8)).equals(MAGIC)) fail('VERIFY_FAILED');
    const headerLength = (await readExact(8, 4)).readUInt32BE(0);
    if (headerLength < 2 || headerLength > MAX_HEADER) fail('VERIFY_FAILED');
    const headerBytes = await readExact(12, headerLength);
    let header;
    try {
      header = JSON.parse(headerBytes.toString('utf8'));
    } catch {
      fail('VERIFY_FAILED');
    }
    if (
      !exactKeys(header, ['format', 'cipher', 'kdf', 'keyId', 'salt', 'createdAt']) ||
      header.format !== ARCHIVE_FORMAT ||
      header.cipher !== 'aes-256-gcm' ||
      header.kdf !== 'hkdf-sha256' ||
      typeof header.keyId !== 'string' ||
      !hex(16).test(header.keyId) ||
      typeof header.salt !== 'string' ||
      !hex(64).test(header.salt) ||
      !isoDate(header.createdAt)
    )
      fail('VERIFY_FAILED');
    if (header.keyId !== key.keyId) fail('KEY_MISMATCH');
    const prefix = Buffer.concat([MAGIC, u32(headerLength), headerBytes]);
    const metaStart = 12 + headerLength;
    const metaLength = (await readExact(metaStart, 4)).readUInt32BE(0);
    if (metaLength < 2 || metaLength > MAX_META) fail('VERIFY_FAILED');
    const metaBytes = await readExact(metaStart + 4, metaLength);
    const metaTag = await readExact(metaStart + 4 + metaLength, 16);
    const dataStart = metaStart + 4 + metaLength + 16;
    const dataEnd = size - 16;
    if (dataEnd <= dataStart) fail('VERIFY_FAILED');
    const dataTag = await readExact(dataEnd, 16);
    const derived = subkey(key.key, Buffer.from(header.salt, 'hex'));
    let meta;
    try {
      const decipher = createDecipheriv('aes-256-gcm', derived, nonce(1));
      decipher.setAAD(prefix);
      decipher.setAuthTag(metaTag);
      meta = JSON.parse(
        Buffer.concat([decipher.update(metaBytes), decipher.final()]).toString('utf8'),
      );
    } catch {
      fail('VERIFY_FAILED');
    }
    if (!validMeta(meta) || meta.createdAt !== header.createdAt) fail('VERIFY_FAILED');
    const archiveHash = createHash('sha256').update(await readExact(0, dataStart));
    const plainHash = createHash('sha256');
    let plainBytes = 0;
    const decipher = createDecipheriv('aes-256-gcm', derived, nonce(2));
    decipher.setAAD(prefix);
    decipher.setAuthTag(dataTag);
    const out = output ? await open(output, 'wx', 0o600) : null;
    let verified = false;
    try {
      const take = async (bytes) => {
        plainHash.update(bytes);
        plainBytes += bytes.length;
        if (out) await writeAll(out, bytes);
      };
      for await (const chunk of createReadStream(file, { start: dataStart, end: dataEnd - 1 })) {
        archiveHash.update(chunk);
        await take(decipher.update(chunk));
      }
      let last;
      try {
        last = decipher.final();
      } catch {
        fail('VERIFY_FAILED');
      }
      await take(last);
      archiveHash.update(dataTag);
      if (plainHash.copy().digest('hex') !== meta.dumpSha256 || plainBytes !== meta.dumpBytes)
        fail('VERIFY_FAILED');
      if (out) await out.sync();
      verified = true;
    } finally {
      if (out) {
        await out.close().catch(() => undefined);
        if (!verified) await rm(output, { force: true }).catch(() => undefined);
      }
    }
    return {
      header,
      meta,
      dumpSha256: plainHash.digest('hex'),
      dumpBytes: plainBytes,
      archiveSha256: archiveHash.digest('hex'),
      archiveBytes: size,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- copies and retention

export const COPY_FORMAT = 'pickchick-edge-backup-copy-v1';
const STRAY_AGE_MS = 6 * 3600_000;
const MAX_SIDECAR = 16 * 1024;

/** pickchick-edge-<branch prefix>-<UTC time>-<run>.pcbak: other cashiers' files never match. */
export function archiveName(branchId, date, runId) {
  if (
    !uuid.test(branchId ?? '') ||
    !(date instanceof Date) ||
    !Number.isFinite(date.getTime()) ||
    !hex(8).test(runId ?? '')
  )
    fail('INTERNAL');
  const stamp = date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
  return `pickchick-edge-${branchId.slice(0, 8)}-${stamp}-${runId}${ARCHIVE_EXTENSION}`;
}
const stampIso = (stamp) =>
  `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.000Z`;

export function parseCopySidecar(value) {
  if (
    !exactKeys(value, [
      'format',
      'archive',
      'branchId',
      'createdAt',
      'schema',
      'keyId',
      'archiveBytes',
      'archiveSha256',
      'dumpSha256',
      'dumpBytes',
      'verifiedAt',
    ]) ||
    value.format !== COPY_FORMAT ||
    typeof value.archive !== 'string' ||
    !uuid.test(value.branchId ?? '') ||
    !isoDate(value.createdAt) ||
    !Object.prototype.hasOwnProperty.call(EDGE_BACKUP_SCHEMAS, value.schema) ||
    typeof value.keyId !== 'string' ||
    !hex(16).test(value.keyId) ||
    !Number.isSafeInteger(value.archiveBytes) ||
    value.archiveBytes < 1 ||
    typeof value.archiveSha256 !== 'string' ||
    !hex(64).test(value.archiveSha256) ||
    typeof value.dumpSha256 !== 'string' ||
    !hex(64).test(value.dumpSha256) ||
    !Number.isSafeInteger(value.dumpBytes) ||
    value.dumpBytes < 1 ||
    !isoDate(value.verifiedAt)
  )
    fail('VERIFY_FAILED');
  return value;
}

/**
 * Complete copies of this branch (archive plus matching sidecar), newest first, and leftovers of
 * interrupted runs older than six hours (temporary files, archives without a valid sidecar,
 * sidecars without an archive). Links, folders, other files and other branches are ignored.
 */
export async function listBackupCopies(dir, { branchId, now = new Date() }) {
  const prefix = `pickchick-edge-${branchId.slice(0, 8)}-`;
  const archivePattern = new RegExp(`^${prefix}(\\d{8}T\\d{6}Z)-[a-f0-9]{8}\\.pcbak$`);
  const tempPattern = new RegExp(
    `^\\.${prefix}\\d{8}T\\d{6}Z-[a-f0-9]{8}\\.pcbak(\\.json)?\\.tmp-[a-f0-9]{8}$`,
  );
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    fail('DESTINATION_UNAVAILABLE');
  }
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const info = (name) => lstat(join(dir, name));
  const old = async (name) => {
    const stats = await info(name).catch(() => null);
    return stats !== null && now.getTime() - stats.mtimeMs >= STRAY_AGE_MS;
  };
  const copies = [];
  const strays = [];
  for (const name of [...files].sort()) {
    if (tempPattern.test(name)) {
      if (await old(name)) strays.push(name);
      continue;
    }
    const sidecarOf = name.endsWith(ARCHIVE_EXTENSION + '.json') ? name.slice(0, -5) : null;
    if (sidecarOf && archivePattern.test(sidecarOf)) {
      if (!files.has(sidecarOf) && (await old(name))) strays.push(name);
      continue;
    }
    const match = archivePattern.exec(name);
    if (!match) continue;
    const archive = await info(name).catch(() => null);
    if (!archive) continue;
    let sidecar = null;
    let foreign = false;
    if (files.has(name + '.json')) {
      try {
        const sideInfo = await info(name + '.json');
        if (sideInfo.isFile() && sideInfo.size <= MAX_SIDECAR) {
          const value = parseCopySidecar(
            JSON.parse(await readFile(join(dir, name + '.json'), 'utf8')),
          );
          // Another cashier whose branch id shares the 8-character prefix: never touched.
          foreign = value.branchId !== branchId;
          if (value.archive === name && !foreign && value.archiveBytes === archive.size)
            sidecar = value;
        }
      } catch {
        sidecar = null;
      }
    }
    if (foreign) continue;
    if (sidecar) copies.push({ name, createdAt: stampIso(match[1]), sidecar, bytes: archive.size });
    else if (await old(name)) {
      strays.push(name);
      if (files.has(name + '.json') && (await old(name + '.json'))) strays.push(name + '.json');
    }
  }
  copies.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
  return { copies, strays };
}

/**
 * Keeps the newest copy of each of the newest `hourly` hours that have a copy and of each of
 * the newest `daily` local days that have a copy (a cashier switched off at night keeps its
 * history), plus always the newest copy. Everything else is removed.
 */
export function planRetention(copies, { hourly, daily, timeZone }) {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const sorted = [...copies].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name),
  );
  const keep = new Set();
  const hours = new Set();
  const days = new Set();
  for (const copy of sorted) {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(copy.createdAt)).map((part) => [part.type, part.value]),
    );
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    const hour = `${day}T${parts.hour}`;
    if (!hours.has(hour) && hours.size < hourly) {
      hours.add(hour);
      keep.add(copy.name);
    }
    if (!days.has(day) && days.size < daily) {
      days.add(day);
      keep.add(copy.name);
    }
  }
  if (sorted.length) keep.add(sorted[0].name);
  return {
    keep: sorted.filter((copy) => keep.has(copy.name)).map((copy) => copy.name),
    remove: sorted.filter((copy) => !keep.has(copy.name)).map((copy) => copy.name),
  };
}

// ---------------------------------------------------------------- status and log

export const STATUS_FORMAT = 'pickchick-edge-backup-status-v1';

/** Health record for Inspect and the optional heartbeat: no path, key, password or row data. */
export function backupStatus({
  state,
  error = null,
  warning = null,
  startedAt,
  finishedAt,
  previous = null,
  config,
  schema = null,
  copies = null,
  archiveBytes = null,
  keyId = null,
}) {
  if (
    !['ok', 'failed', 'skipped'].includes(state) ||
    (state === 'ok' && error !== null) ||
    (state === 'failed' && !EDGE_BACKUP_ERRORS.includes(error)) ||
    (state === 'skipped' && !SKIP_CODES.includes(error)) ||
    (warning !== null && !EDGE_BACKUP_WARNINGS.includes(warning)) ||
    !(startedAt instanceof Date) ||
    !(finishedAt instanceof Date) ||
    !Number.isFinite(startedAt.getTime()) ||
    !Number.isFinite(finishedAt.getTime())
  )
    fail('INTERNAL');
  const carried = isoDate(previous?.lastSuccessAt) ? previous.lastSuccessAt : null;
  return {
    format: STATUS_FORMAT,
    state,
    error,
    warning,
    lastAttemptAt: startedAt.toISOString(),
    lastSuccessAt: state === 'ok' ? finishedAt.toISOString() : carried,
    schema: Object.prototype.hasOwnProperty.call(EDGE_BACKUP_SCHEMAS, schema) ? schema : null,
    copies: Number.isSafeInteger(copies) ? copies : null,
    archiveBytes: Number.isSafeInteger(archiveBytes) ? archiveBytes : null,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    keyId: typeof keyId === 'string' && hex(16).test(keyId) ? keyId : null,
    maxAgeMinutes: config.maxAgeMinutes,
    reportInHeartbeat: config.reportInHeartbeat === true,
  };
}

export function backupLogEntry(status, now = new Date()) {
  const entry = { event: 'edge_backup', at: now.toISOString(), state: status.state };
  for (const [key, name] of [
    ['error', 'error'],
    ['warning', 'warning'],
    ['schema', 'schema'],
    ['copies', 'copies'],
    ['archiveBytes', 'archive_bytes'],
    ['durationMs', 'duration_ms'],
  ])
    if (status[key] !== null && status[key] !== undefined) entry[name] = status[key];
  return entry;
}

/** Task Scheduler "Last Run Result": non-zero needs operator attention. */
export function backupExitCode(state) {
  return state === 'ok' || state === 'skipped' ? 0 : 1;
}

async function readSmallJson(path, limit, code) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) fail(code);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail(code);
  }
}

export async function readBackupStatus(path) {
  try {
    const value = await readSmallJson(path, 8192, 'INTERNAL');
    return value?.format === STATUS_FORMAT ? value : null;
  } catch {
    return null;
  }
}

/** Write a small file next to its final name, flush, then rename over it (retry if busy). */
export async function writeFileAtomic(path, text) {
  const temp = join(
    dirname(path),
    `.${path.split(/[\\/]/).pop()}.tmp-${randomBytes(4).toString('hex')}`,
  );
  const handle = await open(temp, 'wx', 0o600);
  try {
    await writeAll(handle, Buffer.from(text, 'utf8'));
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      if (attempt >= 4 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}

const MAX_LOG_BYTES = 1024 * 1024;
export async function appendBackupLog(path, entry) {
  const size = (await stat(path).catch(() => null))?.size ?? 0;
  if (size > MAX_LOG_BYTES) {
    await rm(`${path}.1`, { force: true });
    await rename(path, `${path}.1`);
  }
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}

// ---------------------------------------------------------------- one run

const LOCK_STALE_MS = 3 * 3600_000;
const FREE_SPACE_MARGIN = 64 * 1024 * 1024;

async function acquireRunLock(path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await writeAll(
          handle,
          Buffer.from(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })),
        );
      } finally {
        await handle.close();
      }
      return { release: () => rm(path, { force: true }) };
    } catch (error) {
      if (error.code !== 'EEXIST') fail('INTERNAL');
      const info = await lstat(path).catch(() => null);
      // Task Scheduler stops a run after one hour, so an older lock is a crashed run.
      if (info && Date.now() - info.mtimeMs < LOCK_STALE_MS) fail('LOCKED');
      await rm(path, { force: true });
    }
  }
  fail('LOCKED');
}

/** Every public table's data must be in the archive TOC (`pg_restore --list`). */
export function checkArchiveList(text, schema, tables) {
  const found = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\d+; \d+ \d+ TABLE DATA (\S+) (\S+) /.exec(line);
    if (match && match[1] === schema) found.add(match[2]);
  }
  if (
    !tables.includes('schema_migrations') ||
    !tables.includes('branch_config') ||
    tables.some((table) => !found.has(table))
  )
    fail('ARCHIVE_INCOMPLETE');
}

async function hashFile(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** Process environment for pg_dump/pg_restore: inherited PG and app settings are dropped. */
export function toolEnvironment(base, database, passfile) {
  const env = Object.fromEntries(
    Object.entries(base).filter(([key]) => !/^(PG|EDGE_|CLOUD_|NODE_OPTIONS)/i.test(key)),
  );
  return Object.assign(env, {
    PGPASSFILE: passfile,
    PGHOST: database.host,
    PGPORT: String(database.port),
    PGSSLMODE: 'disable',
    PGCONNECT_TIMEOUT: '5',
    PGAPPNAME: 'pickchick-edge-backup',
  });
}

/**
 * One scheduled backup. `deps`: connect({user,password}) -> pg client, runTool(name, args,
 * {env,timeoutMs}) -> stdout, enterMaintenance() -> {release}, optional now() and
 * freeBytes(dir). Never throws: returns the written status and the process exit code.
 */
export async function runEdgeBackup(
  { config, layout, pinned, database, schema = 'public', environment = process.env },
  deps,
) {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const runUuid = randomUUID();
  const runId = randomBytes(4).toString('hex');
  const previous = await readBackupStatus(layout.statusFile);
  const ns = identifier(schema);
  let lock = null;
  let lease = null;
  let source = null;
  let snapshotOpen = false;
  let passfile = null;
  let dump = null;
  let temporary = null;
  let finalArchive = null;
  let outcome;
  let warning = null;
  const facts = { schema: null, copies: null, archiveBytes: null, keyId: null };
  try {
    lock = await acquireRunLock(layout.lockFile);
    lease = await step('INTERNAL', () => deps.enterMaintenance());
    // Leftover plaintext of a crashed run is removed first; only this run's files exist after.
    for (const name of await step('INTERNAL', () => readdir(layout.stagingDir)))
      if (/^(edge-[a-f0-9]{8}\.dump|pgpass-[a-f0-9]{8}\.tmp)$/.test(name))
        await step('INTERNAL', () => rm(join(layout.stagingDir, name), { force: true }));
    const key = parseBackupKey(await readSmallJson(layout.keyFile, 4096, 'KEY_INVALID'));
    facts.keyId = key.keyId;
    const credential = parseBackupCredential(
      await readSmallJson(layout.credentialFile, 4096, 'CREDENTIAL_INVALID'),
    );
    // No dump is taken while the second location is offline.
    await listBackupCopies(config.destination, { branchId: config.branchId });
    source = await step('DATABASE_UNAVAILABLE', () =>
      deps.connect({ user: credential.role, password: credential.password }),
    );
    const snapshot = await step('SNAPSHOT_FAILED', async () => {
      await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      snapshotOpen = true;
      const cluster = (
        await source.query('SELECT system_identifier::text AS id FROM pg_control_system()')
      ).rows[0]?.id;
      if (cluster !== config.systemIdentifier) fail('CLUSTER_MISMATCH');
      const ledger = (
        await source.query(
          `SELECT version,checksum,scope FROM ${ns}.schema_migrations ORDER BY version`,
        )
      ).rows;
      const reviewed = verifiedSchema(ledger, pinned);
      facts.schema = reviewed;
      const branches = (await source.query(`SELECT id FROM ${ns}.branch_config`)).rows;
      if (branches.length !== 1 || branches[0].id !== config.branchId) fail('BRANCH_MISMATCH');
      const tables = (
        await source.query(
          `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname`,
          [schema],
        )
      ).rows.map((row) => row.relname);
      const counts = {};
      for (const table of tables)
        counts[table] = (
          await source.query(
            `SELECT count(*)::text AS count FROM ${ns}."${table.replaceAll('"', '""')}"`,
          )
        ).rows[0].count;
      const id = (await source.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
      return { id, ledger, reviewed, tables, counts };
    });
    passfile = join(layout.stagingDir, `pgpass-${runId}.tmp`);
    await step('INTERNAL', () =>
      writeFileExclusive(
        passfile,
        `${database.host}:${database.port}:${database.name}:${credential.role}:${credential.password}\n`,
      ),
    );
    const env = toolEnvironment(environment, database, passfile);
    dump = join(layout.stagingDir, `edge-${runId}.dump`);
    await step('DUMP_FAILED', () =>
      deps.runTool(
        'pg_dump',
        [
          '--format=custom',
          '--file=' + dump,
          '--username=' + credential.role,
          '--no-password',
          '--snapshot=' + snapshot.id,
          '--lock-wait-timeout=60s',
          '--dbname=' + database.name,
        ],
        { env, timeoutMs: 20 * 60_000 },
      ),
    );
    await step('SNAPSHOT_FAILED', () => source.query('ROLLBACK'));
    snapshotOpen = false;
    await step('INTERNAL', () => rm(passfile, { force: true }));
    passfile = null;
    const list = await step('ARCHIVE_INCOMPLETE', () =>
      deps.runTool('pg_restore', ['--list', dump], { env, timeoutMs: 5 * 60_000 }),
    );
    checkArchiveList(list, schema, snapshot.tables);
    const dumped = await step('ARCHIVE_INCOMPLETE', () => hashFile(dump));
    if (dumped.bytes < 1) fail('ARCHIVE_INCOMPLETE');
    const free = await Promise.resolve()
      .then(() => (deps.freeBytes ?? freeBytes)(config.destination))
      .catch(() => null);
    if (Number.isFinite(free) && free < dumped.bytes + FREE_SPACE_MARGIN) fail('DESTINATION_FULL');
    const createdAt = now();
    const name = archiveName(config.branchId, createdAt, runId);
    const meta = {
      format: META_FORMAT,
      runId: runUuid,
      branchId: config.branchId,
      systemIdentifier: config.systemIdentifier,
      schema: snapshot.reviewed,
      ledger: snapshot.ledger,
      tableCounts: snapshot.counts,
      dumpSha256: dumped.sha256,
      dumpBytes: dumped.bytes,
      createdAt: createdAt.toISOString(),
    };
    temporary = join(config.destination, `.${name}.tmp-${randomBytes(4).toString('hex')}`);
    const written = await step('DESTINATION_WRITE_FAILED', () =>
      writeEncryptedArchive({ source: dump, target: temporary, key, meta }),
    );
    const target = join(config.destination, name);
    await step('DESTINATION_WRITE_FAILED', async () => {
      // Never replace (or later clean up) a file this run did not write.
      if (await lstat(target).catch(() => null)) fail('DESTINATION_WRITE_FAILED');
      await rename(temporary, target);
    });
    finalArchive = target;
    temporary = null;
    // Read the stored copy back: authenticates and re-hashes every byte at the destination.
    const check = await step('VERIFY_FAILED', () =>
      readEncryptedArchive({ file: finalArchive, key }),
    );
    if (
      check.archiveSha256 !== written.archiveSha256 ||
      check.archiveBytes !== written.archiveBytes ||
      check.dumpSha256 !== dumped.sha256 ||
      check.dumpBytes !== dumped.bytes ||
      check.meta.runId !== runUuid
    )
      fail('VERIFY_FAILED');
    const sidecar = {
      format: COPY_FORMAT,
      archive: name,
      branchId: config.branchId,
      createdAt: meta.createdAt,
      schema: snapshot.reviewed,
      keyId: key.keyId,
      archiveBytes: check.archiveBytes,
      archiveSha256: check.archiveSha256,
      dumpSha256: dumped.sha256,
      dumpBytes: dumped.bytes,
      verifiedAt: now().toISOString(),
    };
    await step('DESTINATION_WRITE_FAILED', () =>
      writeFileAtomic(
        join(config.destination, name + '.json'),
        JSON.stringify(sidecar, null, 2) + '\n',
      ),
    );
    finalArchive = null;
    facts.archiveBytes = check.archiveBytes;
    try {
      const listed = await listBackupCopies(config.destination, { branchId: config.branchId });
      if (!listed.copies.some((copy) => copy.name === name)) fail('INTERNAL');
      const plan = planRetention(listed.copies, { ...config.retention, timeZone: config.timeZone });
      for (const old of plan.remove) {
        // Sidecar first: an interrupted removal leaves an incomplete archive, never a fake copy.
        await rm(join(config.destination, old + '.json'), { force: true });
        await rm(join(config.destination, old), { force: true });
      }
      for (const stray of listed.strays) await rm(join(config.destination, stray), { force: true });
      facts.copies = plan.keep.length;
    } catch {
      warning = 'RETENTION_FAILED';
    }
    outcome = { state: 'ok', error: null };
  } catch (error) {
    const code = error instanceof EdgeBackupError ? error.code : 'INTERNAL';
    outcome = SKIP_CODES.includes(code)
      ? { state: 'skipped', error: code }
      : { state: 'failed', error: code };
  } finally {
    if (snapshotOpen) await source.query('ROLLBACK').catch(() => undefined);
    if (source) await source.end().catch(() => undefined);
    for (const path of [passfile, dump, temporary, finalArchive])
      if (path)
        await rm(path, { force: true }).catch(() => {
          warning ??= 'CLEANUP_FAILED';
        });
    for (const held of [lease, lock])
      await Promise.resolve()
        .then(() => held?.release())
        .catch(() => undefined);
  }
  const status = backupStatus({
    ...outcome,
    warning: outcome.state === 'ok' || warning === 'CLEANUP_FAILED' ? warning : null,
    startedAt,
    finishedAt: now(),
    previous,
    config,
    ...facts,
  });
  let exitCode = backupExitCode(status.state);
  // A second run that found the lock leaves the running copy's status alone.
  if (status.error !== 'LOCKED')
    try {
      await writeFileAtomic(layout.statusFile, JSON.stringify(status, null, 2) + '\n');
    } catch {
      exitCode = 1;
      await appendBackupLog(layout.logFile, {
        ...backupLogEntry(status, now()),
        status_write: 'failed',
      }).catch(() => undefined);
    }
  await appendBackupLog(layout.logFile, backupLogEntry(status, now())).catch(() => {
    exitCode = 1;
  });
  return { status, exitCode };
}

async function writeFileExclusive(path, text) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await writeAll(handle, Buffer.from(text, 'utf8'));
  } finally {
    await handle.close();
  }
}

async function freeBytes(dir) {
  const info = await statfs(dir);
  return Number(info.bavail) * Number(info.bsize);
}
