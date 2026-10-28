import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  EdgeBackupError,
  archiveName,
  createBackupKey,
  parseBackupKey,
  writeEncryptedArchive,
} from '../../infra/windows/edge-backup-lib.mjs';
import {
  buildBackupConfig,
  foundationBinding,
  scramVerifier,
} from '../../infra/windows/edge-backup-setup.mjs';

const pinned = JSON.parse(
  await readFile(new URL('../../infra/windows/native-edge-backup-ledger.json', import.meta.url)),
);
const branchId = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1';
const code = (expected) => (error) => error instanceof EdgeBackupError && error.code === expected;
const script = (name) => fileURLToPath(new URL(`../../infra/windows/${name}`, import.meta.url));
const node = (name, args) => promisify(execFile)(process.execPath, [script(name), ...args]);
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
const meta = (dump) => ({
  format: 'pickchick-edge-backup-meta-v1',
  runId: '0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9',
  branchId,
  systemIdentifier: config.systemIdentifier,
  schema: 'schema023',
  ledger: pinned.slice(0, 23),
  tableCounts: { branch_config: '1', schema_migrations: '23' },
  dumpSha256: createHash('sha256').update(dump).digest('hex'),
  dumpBytes: dump.length,
  createdAt: '2026-10-24T10:17:00.000Z',
});

async function withDirectory(run) {
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-edge-backup-cli-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the scheduled task module refuses to run outside Windows without touching files', async () => {
  await withDirectory(async (dir) => {
    await assert.rejects(
      node('edge-backup-task.mjs', [join(dir, 'edge-backup.json')]),
      (error) => error.code === 1 && error.stderr.includes('edge_backup_start_failed'),
    );
    assert.deepEqual(await readdir(dir), []);
  });
});

test('setup builds the task configuration from foundation facts and refuses mismatches', async () => {
  const built = buildBackupConfig({
    stateRoot: config.stateRoot,
    toolsRoot: config.toolsRoot,
    pgBin: config.pgBin,
    branchId,
    systemIdentifier: config.systemIdentifier,
    destination: config.destination,
    hourly: 48,
    daily: 14,
    maxAgeMinutes: 120,
    reportInHeartbeat: false,
    timeZone: 'Asia/Almaty',
  });
  assert.deepEqual(built, config);
  assert.throws(
    () => buildBackupConfig({ ...config, ...config.retention, destination: 'C:\\Backup' }),
    code('CONFIG_INVALID'),
  );
  const installId = '5d4c3b2a-1908-4f7e-8d6c-5b4a39281706';
  const state = {
    format: 'pickchick-native-state-v1',
    complete: true,
    branchId,
    installId,
    systemIdentifier: config.systemIdentifier,
  };
  const passwords = {
    pickchick_bootstrap: '1'.repeat(64),
    pickchick_edge_owner: '2'.repeat(64),
    pickchick_edge_runtime: '3'.repeat(64),
  };
  const credentials = { format: 'pickchick-native-secrets-v1', branchId, installId, passwords };
  assert.deepEqual(foundationBinding(state, credentials, branchId), {
    systemIdentifier: config.systemIdentifier,
    bootstrap: '1'.repeat(64),
  });
  for (const [s, c, b] of [
    [{ ...state, complete: false }, credentials, branchId],
    [state, credentials, '11111111-1111-4111-8111-111111111111'],
    [state, { ...credentials, installId: branchId }, branchId],
    [state, { ...credentials, passwords: { ...passwords, pickchick_bootstrap: 'x' } }, branchId],
    [{ ...state, systemIdentifier: '1' }, credentials, branchId],
    [null, credentials, branchId],
  ])
    assert.throws(() => foundationBinding(s, c, b), /foundation/);
  // The role password reaches PostgreSQL only as a SCRAM verifier.
  const verifier = scramVerifier('a'.repeat(64), Buffer.alloc(16, 1));
  assert.match(verifier, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.equal(verifier.includes('a'.repeat(64)), false);
  assert.throws(() => scramVerifier('short'));
});

test('operator CLIs refuse bad invocations without output of secrets or file changes', async () => {
  await withDirectory(async (dir) => {
    for (const args of [[], ['install', dir], ['remove-role', dir, branchId]])
      await assert.rejects(
        node('edge-backup-setup.mjs', args),
        (error) => error.code === 1 && error.stderr.includes('edge_backup_setup_failed'),
      );
    for (const args of [[], ['decrypt', 'relative.pcbak', 'key.json', 'out.dump'], ['list', dir]])
      await assert.rejects(
        node('edge-backup-restore.mjs', args),
        (error) => error.code === 1 && error.stderr.includes('"code":"INVALID_INPUT_OR_IO"'),
      );
    assert.deepEqual(await readdir(dir), []);
  });
});

test('restore CLI lists, verifies and decrypts a copy on any operator machine', async () => {
  const run = (...args) => node('edge-backup-restore.mjs', args);
  await withDirectory(async (dir) => {
    const keyRecord = createBackupKey();
    const keyFile = join(dir, 'backup-key.json');
    await writeFile(keyFile, JSON.stringify(keyRecord));
    const key = parseBackupKey(keyRecord);
    const dump = randomBytes(50_000);
    const source = join(dir, 'source.dump');
    await writeFile(source, dump);
    const copies = join(dir, 'copies');
    await mkdir(copies);
    const name = archiveName(branchId, new Date('2026-10-24T10:17:05Z'), 'a1b2c3d4');
    const written = await writeEncryptedArchive({
      source,
      target: join(copies, name),
      key,
      meta: meta(dump),
    });
    await writeFile(
      join(copies, name + '.json'),
      JSON.stringify({
        format: 'pickchick-edge-backup-copy-v1',
        archive: name,
        branchId,
        createdAt: '2026-10-24T10:17:05.000Z',
        schema: 'schema023',
        keyId: key.keyId,
        archiveBytes: written.archiveBytes,
        archiveSha256: written.archiveSha256,
        dumpSha256: meta(dump).dumpSha256,
        dumpBytes: dump.length,
        verifiedAt: '2026-10-24T10:17:09.000Z',
      }),
    );
    const listed = (await run('list', copies, branchId)).stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(listed, [
      {
        archive: name,
        createdAt: '2026-10-24T10:17:05.000Z',
        schema: 'schema023',
        keyId: key.keyId,
        archiveBytes: written.archiveBytes,
      },
      { copies: 1, incompleteOrTemporary: 0 },
    ]);
    const verified = JSON.parse((await run('verify', join(copies, name), keyFile)).stdout);
    assert.equal(verified.verified, true);
    assert.equal(verified.archiveSha256, written.archiveSha256);
    assert.equal(verified.tables, 2);
    const out = join(dir, 'restore.dump');
    const decrypted = JSON.parse((await run('decrypt', join(copies, name), keyFile, out)).stdout);
    assert.equal(decrypted.decrypted, true);
    assert.deepEqual(await readFile(out), dump);
    assert.deepEqual(JSON.parse(await readFile(out + '.meta.json', 'utf8')), meta(dump));
    for (const output of [verified, decrypted])
      assert.equal(JSON.stringify(output).includes(keyRecord.key), false);
    // A wrong key is reported by code only and leaves no file behind.
    const otherKey = join(dir, 'other-key.json');
    await writeFile(otherKey, JSON.stringify(createBackupKey()));
    await assert.rejects(
      run('decrypt', join(copies, name), otherKey, join(dir, 'other.dump')),
      (error) => error.stderr.includes('"code":"KEY_MISMATCH"'),
    );
    await assert.rejects(readFile(join(dir, 'other.dump')), { code: 'ENOENT' });
    // Existing output is never overwritten.
    await assert.rejects(run('decrypt', join(copies, name), keyFile, out));
  });
});

test('a broken task configuration still reports, with the previous report choice and limit', async () => {
  const { configFailureStatus } = await import('../../infra/windows/edge-backup-task.mjs');
  const at = new Date('2026-10-24T12:00:00.000Z');
  const previous = {
    format: 'pickchick-edge-backup-status-v1',
    lastSuccessAt: '2026-10-24T09:00:00.000Z',
    maxAgeMinutes: 180,
    reportInHeartbeat: true,
  };
  const status = configFailureStatus(previous, at);
  assert.deepEqual(
    [
      status.state,
      status.error,
      status.lastSuccessAt,
      status.maxAgeMinutes,
      status.reportInHeartbeat,
    ],
    ['failed', 'CONFIG_INVALID', '2026-10-24T09:00:00.000Z', 180, true],
  );
  const fresh = configFailureStatus(null, at);
  assert.deepEqual(
    [fresh.maxAgeMinutes, fresh.reportInHeartbeat, fresh.lastSuccessAt],
    [120, false, null],
  );
  assert.equal(configFailureStatus({ ...previous, maxAgeMinutes: 5 }, at).maxAgeMinutes, 120);
});

test('a missing foundation driver or ledger stops the task as TOOL_INVALID', async () => {
  const { loadBackupTools } = await import('../../infra/windows/edge-backup-task.mjs');
  await withDirectory(async (dir) => {
    // The configured foundation folder has no pg driver (for example a renamed release).
    await assert.rejects(loadBackupTools({ ...config, toolsRoot: dir }), code('TOOL_INVALID'));
    await writeFile(join(dir, 'ledger.json'), '{"not":"a ledger"}');
    await assert.rejects(
      loadBackupTools(config, new URL('file://' + join(dir, 'ledger.json'))),
      code('TOOL_INVALID'),
    );
  });
});
