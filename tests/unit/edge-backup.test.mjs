import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, symlink, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ARCHIVE_EXTENSION,
  EDGE_BACKUP_SCHEMAS,
  EdgeBackupError,
  LOCK_STALE_MS,
  acquireRunLock,
  archiveName,
  backupExitCode,
  backupLayout,
  backupLogEntry,
  backupStatus,
  createBackupKey,
  keyIdOf,
  listBackupCopies,
  parseBackupKey,
  parseEdgeBackupConfig,
  planRetention,
  readEncryptedArchive,
  verifiedSchema,
  writeEncryptedArchive,
} from '../../infra/windows/edge-backup-lib.mjs';

const pinned = JSON.parse(
  await readFile(new URL('../../infra/windows/native-edge-backup-ledger.json', import.meta.url)),
);
const branchId = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1';
const code = (expected) => (error) => error instanceof EdgeBackupError && error.code === expected;
const rows = (count) =>
  pinned.slice(0, count).map(({ version, checksum, scope }) => ({ version, checksum, scope }));

test('only the reviewed edge schemas 020-023 are backed up; anything else is refused', () => {
  assert.deepEqual(EDGE_BACKUP_SCHEMAS, {
    schema020: 20,
    schema021: 21,
    schema022: 22,
    schema023: 23,
  });
  for (const [name, length] of Object.entries(EDGE_BACKUP_SCHEMAS))
    assert.equal(verifiedSchema(rows(length), pinned), name);
  // Column order of a database row does not matter, values do.
  assert.equal(
    verifiedSchema(
      rows(23).map(({ version, checksum, scope }) => ({ scope, checksum, version })),
      pinned,
    ),
    'schema023',
  );
  const future = { version: '024_edge_future.sql', checksum: 'a'.repeat(64), scope: 'edge' };
  for (const ledger of [
    rows(19),
    rows(14),
    [],
    [...rows(23), future],
    rows(22).concat([{ ...pinned[22], checksum: 'b'.repeat(64) }]),
    rows(21).map((row, index) => (index === 4 ? { ...row, checksum: 'c'.repeat(64) } : row)),
    rows(20).map((row, index) => (index === 7 ? { ...row, version: '008_other.sql' } : row)),
    rows(20).map((row, index) => (index === 1 ? { ...row, scope: 'cloud' } : row)),
    rows(20).map((row, index) => (index === 2 ? { ...row, extra: 1 } : row)),
    [...rows(19), pinned[20], pinned[19]],
    'schema023',
    null,
  ])
    assert.throws(() => verifiedSchema(ledger, pinned), code('UNREVIEWED_SCHEMA'));
  for (const tampered of [
    pinned.slice(0, 22),
    pinned.map((row, index) => (index === 5 ? { ...row, checksum: 'X'.repeat(64) } : row)),
    pinned.map((row, index) => (index === 5 ? { ...row, scope: 'cloud' } : row)),
    pinned.map((row, index) => (index === 5 ? pinned[6] : row)),
    {},
  ])
    assert.throws(() => verifiedSchema(rows(20), tampered), code('TOOL_INVALID'));
});

const config = {
  format: 'pickchick-edge-backup-config-v1',
  branchId,
  systemIdentifier: '7412345678901234567',
  stateRoot: 'C:\\ProgramData\\PickChick\\EdgeBackup',
  toolsRoot: 'C:\\ProgramData\\PickChick\\EdgeTools\\edge-0186902',
  pgBin: 'C:\\Program Files\\PickChick\\Postgres\\18.6-3\\bin',
  maintenanceLock: 'C:\\ProgramData\\PickChick\\EdgeTools\\unified-menu-maintenance.lock',
  destination: 'D:\\PickChickBackup\\cashier',
  retention: { hourly: 48, daily: 14 },
  timeZone: 'Asia/Almaty',
  maxAgeMinutes: 120,
  reportInHeartbeat: false,
};

test('configuration accepts a second disk or a NAS share and refuses unsafe locations', () => {
  assert.deepEqual(parseEdgeBackupConfig(config), config);
  assert.equal(
    parseEdgeBackupConfig({ ...config, destination: '\\\\nas01\\pickchick\\cashier' }).destination,
    '\\\\nas01\\pickchick\\cashier',
  );
  assert.ok(Object.isFrozen(parseEdgeBackupConfig(config)));
  const refuse = (change) =>
    assert.throws(
      () => parseEdgeBackupConfig({ ...config, ...change }),
      code('CONFIG_INVALID'),
      JSON.stringify(change),
    );
  for (const destination of [
    'C:\\PickChickBackup', // same volume as the PostgreSQL data directory
    'c:\\PickChickBackup',
    'D:\\',
    'D:',
    'D:PickChick',
    'PickChickBackup',
    'D:\\PickChick\\..\\Other',
    'D:\\PickChick\\.\\Other',
    'D:\\PickChick\\',
    'D:\\PickChick:stream',
    'D:/PickChick',
    '\\\\?\\D:\\PickChick',
    '\\\\.\\pipe\\backup',
    '\\\\nas01',
    '\\\\nas01\\',
    '\\\\nas01\\share\\..\\x',
    '\\\\nas01\\share\\x\\',
    'D:\\Pick\nChick',
    '',
    7,
  ])
    refuse({ destination });
  refuse({ format: 'pickchick-edge-backup-config-v2' });
  refuse({ branchId: 'not-a-branch' });
  refuse({ systemIdentifier: '12' });
  refuse({ stateRoot: 'EdgeBackup' });
  refuse({ pgBin: 'C:\\Program Files\\..\\bin' });
  refuse({ maintenanceLock: 'C:\\ProgramData\\PickChick\\EdgeTools\\other.lock' });
  for (const retention of [
    { hourly: 0, daily: 14 },
    { hourly: 48, daily: 0 },
    { hourly: 169, daily: 14 },
    { hourly: 48, daily: 91 },
    { hourly: 1.5, daily: 14 },
    { hourly: '48', daily: 14 },
    { hourly: 48, daily: 14, weekly: 4 },
    { hourly: 48 },
  ])
    refuse({ retention });
  refuse({ timeZone: 'Mars/Olympus' });
  refuse({ timeZone: '' });
  refuse({ maxAgeMinutes: 59 });
  refuse({ maxAgeMinutes: 4321 });
  refuse({ reportInHeartbeat: 'false' });
  refuse({ extra: true });
  const { timeZone, ...missing } = config;
  void timeZone;
  assert.throws(() => parseEdgeBackupConfig(missing), code('CONFIG_INVALID'));
  assert.throws(() => parseEdgeBackupConfig(null), code('CONFIG_INVALID'));
});

test('state layout is fixed below the protected state root', () => {
  assert.deepEqual(backupLayout(config.stateRoot), {
    keyFile: 'C:\\ProgramData\\PickChick\\EdgeBackup\\private\\backup-key.json',
    credentialFile: 'C:\\ProgramData\\PickChick\\EdgeBackup\\private\\backup-db.json',
    stagingDir: 'C:\\ProgramData\\PickChick\\EdgeBackup\\staging',
    lockFile: 'C:\\ProgramData\\PickChick\\EdgeBackup\\staging\\run.lock',
    logFile: 'C:\\ProgramData\\PickChick\\EdgeBackup\\logs\\edge-backup.log',
    statusFile: 'C:\\ProgramData\\PickChick\\EdgeBackup\\health\\status.json',
  });
});

test('backup key files carry a key id and refuse tampering', () => {
  const key = createBackupKey(new Date('2026-10-24T10:00:00Z'));
  assert.match(key.key, /^[a-f0-9]{64}$/);
  assert.equal(key.keyId, keyIdOf(Buffer.from(key.key, 'hex')));
  assert.match(key.keyId, /^[a-f0-9]{16}$/);
  assert.deepEqual(parseBackupKey(key).keyId, key.keyId);
  assert.ok(Buffer.isBuffer(parseBackupKey(key).key));
  assert.notEqual(createBackupKey().key, key.key);
  for (const broken of [
    { ...key, keyId: '0'.repeat(16) },
    { ...key, key: key.key.slice(2) },
    { ...key, key: key.key.toUpperCase() },
    { ...key, format: 'other' },
    { ...key, extra: 1 },
    null,
  ])
    assert.throws(() => parseBackupKey(broken), code('KEY_INVALID'));
});

async function withDirectory(run) {
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-edge-backup-unit-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const meta = (dump) => ({
  format: 'pickchick-edge-backup-meta-v1',
  runId: '0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9',
  branchId,
  systemIdentifier: config.systemIdentifier,
  schema: 'schema023',
  ledger: rows(23),
  tableCounts: { branch_config: '1', schema_migrations: '23' },
  dumpSha256: createHash('sha256').update(dump).digest('hex'),
  dumpBytes: dump.length,
  createdAt: '2026-10-24T10:17:00.000Z',
});

test('encrypted archive round-trips and authenticates every byte', async () => {
  await withDirectory(async (dir) => {
    const dump = randomBytes(300_001);
    const source = join(dir, 'source.dump');
    await writeFile(source, dump);
    const key = parseBackupKey(createBackupKey());
    const target = join(dir, 'copy' + ARCHIVE_EXTENSION);
    const written = await writeEncryptedArchive({ source, target, key, meta: meta(dump) });
    const bytes = await readFile(target);
    assert.equal(written.archiveBytes, bytes.length);
    assert.equal(written.archiveSha256, createHash('sha256').update(bytes).digest('hex'));
    // No plaintext dump bytes, branch or counts are readable in the stored copy.
    assert.equal(bytes.includes(dump.subarray(1000, 1064)), false);
    assert.equal(bytes.includes(Buffer.from(branchId)), false);
    assert.equal(bytes.includes(Buffer.from('schema_migrations')), false);
    const read = await readEncryptedArchive({ file: target, key });
    assert.deepEqual(read.meta, meta(dump));
    assert.equal(read.dumpSha256, meta(dump).dumpSha256);
    assert.equal(read.dumpBytes, dump.length);
    assert.equal(read.archiveSha256, written.archiveSha256);
    assert.equal(read.header.keyId, key.keyId);
    const output = join(dir, 'restored.dump');
    await readEncryptedArchive({ file: target, key, output });
    assert.deepEqual(await readFile(output), dump);
    // The output is created exclusively and never overwritten.
    await assert.rejects(readEncryptedArchive({ file: target, key, output }));

    const other = parseBackupKey(createBackupKey());
    await assert.rejects(readEncryptedArchive({ file: target, key: other }), code('KEY_MISMATCH'));
    const headerLength = bytes.readUInt32BE(8);
    const metaStart = 12 + headerLength;
    const metaLength = bytes.readUInt32BE(metaStart);
    const dataStart = metaStart + 4 + metaLength + 16;
    for (const [label, offset] of Object.entries({
      magic: 0,
      headerLength: 9,
      header: 12 + Math.floor(headerLength / 2),
      metaLength: metaStart + 2,
      meta: metaStart + 4 + 3,
      metaTag: dataStart - 5,
      data: dataStart + 1234,
      lastData: bytes.length - 17,
      dataTag: bytes.length - 3,
    })) {
      const changed = Buffer.from(bytes);
      changed[offset] ^= 0x40;
      const file = join(dir, label + ARCHIVE_EXTENSION);
      await writeFile(file, changed);
      await assert.rejects(readEncryptedArchive({ file, key }), /./, label);
      // A failed verification never leaves a decrypted file behind.
      const out = join(dir, label + '.dump');
      await assert.rejects(readEncryptedArchive({ file, key, output: out }), /./, label);
      await assert.rejects(readFile(out), { code: 'ENOENT' });
    }
    for (const [label, changed] of Object.entries({
      truncated: bytes.subarray(0, bytes.length - 1),
      appended: Buffer.concat([bytes, Buffer.from([0])]),
      headerOnly: bytes.subarray(0, metaStart),
      empty: Buffer.alloc(0),
    })) {
      const file = join(dir, label + ARCHIVE_EXTENSION);
      await writeFile(file, changed);
      await assert.rejects(readEncryptedArchive({ file, key }), code('VERIFY_FAILED'), label);
    }
    const empty = join(dir, 'empty.dump');
    await writeFile(empty, '');
    await assert.rejects(
      writeEncryptedArchive({ source: empty, target: join(dir, 'e.pcbak'), key, meta: meta(dump) }),
      code('ARCHIVE_INCOMPLETE'),
    );
    // A dump changed between hashing and encryption is refused before anything is kept.
    await assert.rejects(
      writeEncryptedArchive({
        source,
        target: join(dir, 'changed.pcbak'),
        key,
        meta: { ...meta(dump), dumpSha256: 'f'.repeat(64) },
      }),
      code('ARCHIVE_INCOMPLETE'),
    );
    await assert.rejects(readFile(join(dir, 'changed.pcbak')), { code: 'ENOENT' });
  });
});

const hourly = (start, count, stepHours = 1) =>
  Array.from({ length: count }, (_, index) => {
    const createdAt = new Date(Date.parse(start) + index * stepHours * 3600_000).toISOString();
    return { name: 'copy-' + createdAt, createdAt };
  });
const almatyDay = (iso) => new Date(Date.parse(iso) + 5 * 3600_000).toISOString().slice(0, 10); // UTC+5 since 2024

test('retention keeps the newest copy of 48 hours and 14 days, nothing else', () => {
  const policy = { hourly: 48, daily: 14, timeZone: 'Asia/Almaty' };
  const copies = hourly('2026-10-01T00:37:00.000Z', 24 * 20);
  const plan = planRetention(copies, policy);
  const newest = [...copies].reverse();
  const expected = new Set(newest.slice(0, 48).map((c) => c.name));
  const days = new Map();
  for (const copy of newest)
    if (!days.has(almatyDay(copy.createdAt))) days.set(almatyDay(copy.createdAt), copy.name);
  for (const name of [...days.values()].slice(0, 14)) expected.add(name);
  assert.deepEqual(new Set(plan.keep), expected);
  assert.equal(plan.keep.length + plan.remove.length, copies.length);
  assert.ok(plan.keep.includes(newest[0].name));
  assert.equal(new Set([...plan.keep, ...plan.remove]).size, copies.length);
  // Newest first, deterministic.
  assert.deepEqual(
    plan.keep,
    newest.filter((c) => expected.has(c.name)).map((c) => c.name),
  );

  // A cashier switched off at night: buckets are hours that have a copy, not wall-clock hours.
  const workday = (day) => hourly(`2026-10-${day}T04:37:00.000Z`, 14);
  const gaps = ['10', '11', '12', '13', '14'].flatMap(workday);
  const kept = planRetention(gaps, policy);
  // The 48 newest hours cover three and a half workdays; the fifth day adds its newest copy.
  assert.equal(kept.keep.length, 48 + 1);
  assert.equal(kept.remove.length, gaps.length - 49);
  assert.ok(kept.keep.includes('copy-2026-10-10T17:37:00.000Z'));

  // Several copies within one hour (manual runs): only the newest of that hour stays.
  const same = [
    { name: 'a', createdAt: '2026-10-24T10:05:00.000Z' },
    { name: 'b', createdAt: '2026-10-24T10:40:00.000Z' },
    { name: 'c', createdAt: '2026-10-24T09:59:00.000Z' },
  ];
  assert.deepEqual(planRetention(same, { ...policy, daily: 1 }).keep, ['b', 'c']);
  assert.deepEqual(planRetention(same, { hourly: 1, daily: 1, timeZone: 'UTC' }), {
    keep: ['b'],
    remove: ['a', 'c'],
  });
  // 23:30 and 00:30 Almaty are different days even though they share a UTC date.
  const boundary = [
    { name: 'late', createdAt: '2026-10-24T18:30:00.000Z' },
    { name: 'early', createdAt: '2026-10-24T19:30:00.000Z' },
    { name: 'older', createdAt: '2026-10-24T17:10:00.000Z' },
  ];
  assert.deepEqual(planRetention(boundary, { hourly: 1, daily: 2, timeZone: 'Asia/Almaty' }), {
    keep: ['early', 'late'],
    remove: ['older'],
  });
  assert.deepEqual(planRetention([], policy), { keep: [], remove: [] });
});

test('copy listing only accepts complete copies of this branch and old leftovers', async () => {
  await withDirectory(async (dir) => {
    const now = new Date('2026-10-24T12:00:00.000Z');
    const name = (at, run) => archiveName(branchId, new Date(at), run);
    assert.equal(
      name('2026-10-24T10:17:05.123Z', 'a1b2c3d4'),
      'pickchick-edge-7a6f6d98-20261024T101705Z-a1b2c3d4.pcbak',
    );
    assert.throws(() => archiveName(branchId, now, 'XYZ'));
    const sidecar = (archive, bytes, extra = {}) =>
      JSON.stringify({
        format: 'pickchick-edge-backup-copy-v1',
        archive,
        branchId,
        createdAt: '2026-10-24T10:17:05.000Z',
        schema: 'schema023',
        keyId: 'a'.repeat(16),
        archiveBytes: bytes,
        archiveSha256: 'b'.repeat(64),
        dumpSha256: 'c'.repeat(64),
        dumpBytes: 10,
        verifiedAt: '2026-10-24T10:18:00.000Z',
        ...extra,
      });
    const old = new Date('2026-10-24T01:00:00.000Z');
    const complete = name('2026-10-24T10:17:05Z', '00000001');
    await writeFile(join(dir, complete), 'x'.repeat(5));
    await writeFile(join(dir, complete + '.json'), sidecar(complete, 5));
    const fresh = name('2026-10-24T11:58:00Z', '00000002'); // being written right now
    await writeFile(join(dir, fresh), 'x');
    const orphan = name('2026-10-24T00:17:00Z', '00000003');
    await writeFile(join(dir, orphan), 'x');
    await utimes(join(dir, orphan), old, old);
    const wrongSize = name('2026-10-24T09:17:00Z', '00000004');
    await writeFile(join(dir, wrongSize), 'xx');
    await writeFile(join(dir, wrongSize + '.json'), sidecar(wrongSize, 5));
    await utimes(join(dir, wrongSize), old, old);
    await utimes(join(dir, wrongSize + '.json'), old, old);
    const lonely = name('2026-10-23T09:17:00Z', '00000005') + '.json';
    await writeFile(join(dir, lonely), sidecar(lonely.slice(0, -5), 1));
    await utimes(join(dir, lonely), old, old);
    const temp = '.' + name('2026-10-24T02:17:00Z', '00000006') + '.tmp-0a0b0c0d';
    await writeFile(join(dir, temp), 'x');
    await utimes(join(dir, temp), old, old);
    const freshTemp = '.' + name('2026-10-24T11:59:00Z', '00000007') + '.json.tmp-0a0b0c0e';
    await writeFile(join(dir, freshTemp), 'x');
    // Other cashiers, unrelated files and links are never listed for removal.
    const foreign = 'pickchick-edge-11111111-20261024T101705Z-00000008.pcbak';
    await writeFile(join(dir, foreign), 'x');
    await utimes(join(dir, foreign), old, old);
    await writeFile(join(dir, 'notes.txt'), 'owner notes');
    // Same 8-character prefix, different branch in its sidecar: also never removed.
    const twin = name('2026-10-21T09:17:00Z', '0000000a');
    await writeFile(join(dir, twin), 'x');
    await writeFile(
      join(dir, twin + '.json'),
      sidecar(twin, 1, { branchId: '7a6f6d98-0000-4000-8000-000000000000' }),
    );
    for (const file of [twin, twin + '.json']) await utimes(join(dir, file), old, old);
    const linked = name('2026-10-22T09:17:00Z', '00000009');
    await symlink(join(dir, 'notes.txt'), join(dir, linked));
    const listed = await listBackupCopies(dir, { branchId, now });
    assert.deepEqual(
      listed.copies.map((copy) => copy.name),
      [complete],
    );
    assert.equal(listed.copies[0].createdAt, '2026-10-24T10:17:05.000Z');
    assert.equal(listed.copies[0].sidecar.schema, 'schema023');
    assert.deepEqual(
      listed.strays.sort(),
      [orphan, temp, wrongSize, wrongSize + '.json', lonely].sort(),
    );
    assert.ok((await readdir(dir)).includes(fresh));
    await assert.rejects(
      listBackupCopies(join(dir, 'missing'), { branchId, now }),
      code('DESTINATION_UNAVAILABLE'),
    );
  });
});

test('status, log line and exit code expose only whitelisted facts', () => {
  const status = backupStatus({
    state: 'failed',
    error: 'DUMP_FAILED',
    startedAt: new Date('2026-10-24T10:17:00.000Z'),
    finishedAt: new Date('2026-10-24T10:17:09.500Z'),
    previous: { lastSuccessAt: '2026-10-24T09:17:12.000Z' },
    config,
    password: 'must-not-appear',
    destination: config.destination,
  });
  assert.deepEqual(status, {
    format: 'pickchick-edge-backup-status-v1',
    state: 'failed',
    error: 'DUMP_FAILED',
    warning: null,
    lastAttemptAt: '2026-10-24T10:17:00.000Z',
    lastSuccessAt: '2026-10-24T09:17:12.000Z',
    schema: null,
    copies: null,
    archiveBytes: null,
    durationMs: 9500,
    keyId: null,
    maxAgeMinutes: 120,
    reportInHeartbeat: false,
  });
  const ok = backupStatus({
    state: 'ok',
    startedAt: new Date('2026-10-24T11:17:00.000Z'),
    finishedAt: new Date('2026-10-24T11:17:30.000Z'),
    previous: status,
    config: { ...config, reportInHeartbeat: true },
    schema: 'schema023',
    copies: 3,
    archiveBytes: 1234,
    keyId: 'a'.repeat(16),
    warning: 'RETENTION_FAILED',
  });
  assert.equal(ok.lastSuccessAt, '2026-10-24T11:17:30.000Z');
  assert.equal(ok.reportInHeartbeat, true);
  assert.equal(ok.warning, 'RETENTION_FAILED');
  const failure = {
    state: 'failed',
    startedAt: new Date('2026-10-24T10:17:00.000Z'),
    finishedAt: new Date('2026-10-24T10:17:09.500Z'),
    config,
  };
  assert.equal(backupStatus({ ...failure, error: 'INTERNAL' }).lastSuccessAt, null);
  assert.throws(() => backupStatus({ ...failure, error: 'secret text' }));
  assert.throws(() => backupStatus({ ...failure, state: 'unknown', error: 'INTERNAL' }));
  assert.throws(() => backupStatus({ ...failure, state: 'ok', warning: 'free text' }));
  const line = backupLogEntry(ok, new Date('2026-10-24T11:17:30.000Z'));
  assert.deepEqual(Object.keys(line).sort(), [
    'archive_bytes',
    'at',
    'copies',
    'duration_ms',
    'event',
    'schema',
    'state',
    'warning',
  ]);
  assert.equal(line.event, 'edge_backup');
  assert.equal(JSON.stringify(line).includes('PickChickBackup'), false);
  assert.equal(backupExitCode('ok'), 0);
  assert.equal(backupExitCode('skipped'), 0);
  assert.equal(backupExitCode('failed'), 1);
  assert.equal(backupExitCode('anything'), 1);
});

test('the run lock skips a live run and takes over after the task limit or a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-edge-lock-'));
  try {
    const path = join(dir, 'run.lock');
    const now = Date.now();
    const bootedAt = now - 5 * 3600_000;
    // The task limit (50 min) ends a run before its lock counts as stale.
    assert.ok(LOCK_STALE_MS > 50 * 60_000 && LOCK_STALE_MS < 60 * 60_000);
    await acquireRunLock(path, { now, bootedAt });
    for (const later of [0, 60_000, LOCK_STALE_MS - 60_000])
      await assert.rejects(acquireRunLock(path, { now: now + later, bootedAt }), code('LOCKED'));
    // The next hourly run after a stopped or crashed run is not skipped.
    const next = await acquireRunLock(path, { now: now + 60 * 60_000, bootedAt });
    await next.release();
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    // Power cut during a copy: a lock from before this start-up does not skip the start-up copy.
    await writeFile(path, '{}');
    const written = new Date(now - 20 * 60_000);
    await utimes(path, written, written);
    await assert.rejects(
      acquireRunLock(path, { now, bootedAt: now - 30 * 60_000 }),
      code('LOCKED'),
    );
    const restarted = await acquireRunLock(path, { now, bootedAt: now - 10 * 60_000 });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, process.pid);
    await restarted.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
