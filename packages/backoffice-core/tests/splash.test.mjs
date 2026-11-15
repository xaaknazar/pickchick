import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { Backoffice, BackofficeError, SPLASH_PART_BYTES, grantBackoffice } from '../dist/index.js';

/**
 * Video of the app storefront (owner request 15.11.2026; splash.ts, cloud078): upload in parts,
 * assemble with the hash and MP4 checks, choose, publish in the content and serve with ranges.
 * Synthetic bytes only.
 */
const is = (code, reason) => (e) =>
  e instanceof BackofficeError && e.code === code && (reason === undefined || e.reason === reason);
const mp4 = (size) => {
  const b = randomBytes(size);
  b.writeUInt32BE(32, 0);
  b.write('ftyp', 4, 'latin1');
  return b;
};
const sha = (b) => createHash('sha256').update(b).digest('hex');

test('splash: parts, finish, choose, content and ranges; analysts read only; flag off hides it', () =>
  withSyncDatabases(async (c) => {
    const person = async (name, role) => {
      const m = await provisionCatalogManager(c.cloud.pool, {
        organization_id: c.org,
        name,
        branch_ids: [c.branch],
      });
      await grantBackoffice(c.cloud.pool, m.actor_id, c.branch, role);
      return m;
    };
    const manager = await person('Синтетический управляющий', 'manager');
    const analyst = await person('Синтетический аналитик', 'analyst');
    const off = new Backoffice(c.cloud.pool, true);
    await assert.rejects(off.splash(manager.token, c.branch), is('NOT_FOUND'));
    assert.equal('splash' in (await off.content(c.branch, 'mobile')), false);
    assert.equal((await off.read(manager.token, c.branch)).capabilities.app_splash, undefined);

    const bo = new Backoffice(c.cloud.pool, true, { appSplashEnabled: true });
    assert.equal((await bo.read(manager.token, c.branch)).capabilities.app_splash, true);
    assert.deepEqual((await bo.content(c.branch, 'mobile')).splash, null);
    const video = mp4(SPLASH_PART_BYTES + 5000);
    const query = { total_bytes: String(video.length), sha256: sha(video) };
    const id = randomUUID();
    const parts = [video.subarray(0, SPLASH_PART_BYTES), video.subarray(SPLASH_PART_BYTES)];
    await assert.rejects(
      bo.splashPart(analyst.token, c.branch, id, '0', query, parts[0]),
      is('FORBIDDEN'),
    );
    await bo.splashPart(manager.token, c.branch, id, '0', query, parts[0]);
    await assert.rejects(bo.splashFinish(manager.token, c.branch, id), is('CONFLICT'));
    // The same part again is accepted; different bytes for it are a conflict.
    await bo.splashPart(manager.token, c.branch, id, '0', query, parts[0]);
    await assert.rejects(
      bo.splashPart(manager.token, c.branch, id, '0', query, mp4(SPLASH_PART_BYTES)),
      is('CONFLICT'),
    );
    await assert.rejects(
      bo.splashPart(manager.token, c.branch, id, '2', query, parts[1]),
      is('INVALID_REQUEST'),
    );
    await bo.splashPart(manager.token, c.branch, id, '1', query, parts[1]);
    const stored = await bo.splashFinish(manager.token, c.branch, id);
    assert.equal(stored.sha256, sha(video));
    assert.equal(stored.size, video.length);
    assert.equal(stored.url, `/v1/media/app/${sha(video)}.mp4`);

    // A wrong hash and a file that is not an MP4 are refused at assembly.
    const bad = mp4(2048);
    const wrong = randomUUID();
    await bo.splashPart(
      manager.token,
      c.branch,
      wrong,
      '0',
      { total_bytes: '2048', sha256: 'a'.repeat(64) },
      bad,
    );
    await assert.rejects(
      bo.splashFinish(manager.token, c.branch, wrong),
      is('INVALID_REQUEST', 'SPLASH_HASH_MISMATCH'),
    );
    const text = Buffer.alloc(2048, 1);
    const plain = randomUUID();
    await bo.splashPart(
      manager.token,
      c.branch,
      plain,
      '0',
      { total_bytes: '2048', sha256: sha(text) },
      text,
    );
    await assert.rejects(
      bo.splashFinish(manager.token, c.branch, plain),
      is('INVALID_REQUEST', 'SPLASH_NOT_MP4'),
    );

    await assert.rejects(
      bo.splashSet(analyst.token, c.branch, { video_id: stored.id, reason: 'Новое видео' }),
      is('FORBIDDEN'),
    );
    await assert.rejects(
      bo.splashSet(manager.token, c.branch, { video_id: randomUUID(), reason: 'Новое видео' }),
      is('NOT_FOUND'),
    );
    const chosen = await bo.splashSet(manager.token, c.branch, {
      video_id: stored.id,
      reason: 'Новое видео',
    });
    assert.equal(chosen.current, stored.id);
    assert.equal((await bo.splash(analyst.token, c.branch)).videos.length, 1);
    assert.deepEqual((await bo.content(c.branch, 'mobile')).splash, {
      video: stored.url,
      sha256: stored.sha256,
      bytes: video.length,
    });

    const whole = await bo.splashMedia(`${stored.sha256}.mp4`);
    assert.equal(whole.partial, false);
    assert.ok(whole.bytes.equals(video));
    const first = await bo.splashMedia(`${stored.sha256}.mp4`, 'bytes=0-1');
    assert.deepEqual(
      [first.start, first.end, first.size, first.partial],
      [0, 1, video.length, true],
    );
    assert.ok(first.bytes.equals(video.subarray(0, 2)));
    const tail = await bo.splashMedia(`${stored.sha256}.mp4`, 'bytes=-10');
    assert.ok(tail.bytes.equals(video.subarray(-10)));
    const open = await bo.splashMedia(`${stored.sha256}.mp4`, 'bytes=100-');
    assert.ok(open.bytes.equals(video.subarray(100)));
    await assert.rejects(
      bo.splashMedia(`${stored.sha256}.mp4`, `bytes=${video.length}-`),
      is('INVALID_REQUEST', 'RANGE'),
    );
    await assert.rejects(bo.splashMedia(`${'b'.repeat(64)}.mp4`), is('NOT_FOUND'));
    await assert.rejects(off.splashMedia(`${stored.sha256}.mp4`), is('NOT_FOUND'));

    // Back to the video built into the app.
    await bo.splashSet(manager.token, c.branch, { video_id: null, reason: 'Вернуть встроенное' });
    assert.equal((await bo.content(c.branch, 'mobile')).splash, null);
    await assert.rejects(c.cloud.pool.query('DELETE FROM app_splash_settings'), /append-only/);
  }));
