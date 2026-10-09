import assert from 'node:assert/strict';
import test from 'node:test';
/* global structuredClone, DOMException */
import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  hashJson,
  isPermanentMediaFailure,
  localCloudOrigin,
  projectCatalogMenu,
} from '@pickchick/menu-sync';
import {
  EdgeMenuStateQuerySchema,
  MenuAckSchema,
  MenuSnapshotSchema,
  menuAckResult,
} from '@pickchick/contracts';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';

test('menu protocol hashes ignore object key order while preserving array order', () => {
  assert.equal(canonicalJson({ z: 'қ', a: { y: 2, b: 1 } }), '{"a":{"b":1,"y":2},"z":"қ"}');
  assert.equal(hashJson({ b: 2, a: 1 }), hashJson({ a: 1, b: 2 }));
  assert.notEqual(hashJson([1, 2]), hashJson([2, 1]));
  assert.equal(
    MenuSnapshotSchema.safeParse({ ...fixtureMenu, version: 2147483648 }).success,
    false,
  );
});

test('local sync never forwards device credentials to remote or userinfo origins', () => {
  assert.equal(localCloudOrigin('http://127.0.0.1:3100'), 'http://127.0.0.1:3100');
  for (const url of [
    'https://example.com',
    'http://localhost:3100',
    'http://127.0.0.1/path',
    'http://user:secret@127.0.0.1',
    'http://127.0.0.1?x=1',
    'http://127.0.0.1#x',
  ])
    assert.throws(() => localCloudOrigin(url));
});

test('menu checksum is stable with the unified-menu fields and changes only with content', () => {
  const branch = '10000000-0000-4000-8000-000000000003';
  const release = '30000000-0000-4000-8000-000000000001';
  const at = '2026-10-04T00:00:00.000Z';
  const first = projectCatalogMenu(mockupCatalogDraft, branch, 3, at, release);
  const second = projectCatalogMenu(structuredClone(mockupCatalogDraft), branch, 3, at, release);
  assert.ok(first.categories && first.items.every((item) => item.kitchen && item.source_id));
  assert.equal(hashJson(first), hashJson(second));
  // Key order in the stored JSON never changes the checksum.
  const reordered = JSON.parse(
    JSON.stringify(first, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    ),
  );
  assert.equal(hashJson(reordered), hashJson(first));
  assert.equal(
    hashJson(MenuSnapshotSchema.parse(JSON.parse(canonicalJson(first)))),
    hashJson(first),
  );
  const photo = structuredClone(mockupCatalogDraft);
  photo.products[0].image = { asset_id: randomUUID(), sha256: 'ab'.repeat(32) };
  assert.notEqual(hashJson(projectCatalogMenu(photo, branch, 3, at, release)), hashJson(first));
});

test('menu ACK keeps applied ACKs byte-identical and requires a reason for rejection', () => {
  const ack = {
    event_id: randomUUID(),
    producer_id: randomUUID(),
    producer_sequence: '3',
    branch_id: randomUUID(),
    release_id: randomUUID(),
    checksum: 'c'.repeat(64),
  };
  const parsed = MenuAckSchema.parse(ack);
  assert.equal('result' in parsed, false);
  assert.equal(hashJson(parsed), hashJson(ack));
  assert.equal(menuAckResult(parsed), 'applied');
  assert.equal(menuAckResult(MenuAckSchema.parse({ ...ack, result: 'applied' })), 'applied');
  const rejected = MenuAckSchema.parse({
    ...ack,
    result: 'rejected',
    reason: 'ROUTING_UNRESOLVED',
  });
  assert.equal(menuAckResult(rejected), 'rejected');
  for (const reason of ['VERSION_NOT_NEWER', 'MEDIA_UNAVAILABLE', 'INVALID_MENU'])
    assert.equal(MenuAckSchema.safeParse({ ...ack, result: 'rejected', reason }).success, true);
  for (const bad of [
    { ...ack, result: 'rejected' },
    { ...ack, reason: 'INVALID_MENU' },
    { ...ack, result: 'applied', reason: 'INVALID_MENU' },
    { ...ack, result: 'rejected', reason: 'UNKNOWN' },
    { ...ack, result: 'ignored' },
  ])
    assert.equal(MenuAckSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('edge menu state query accepts the worker query params and nothing else', () => {
  const id = randomUUID();
  assert.deepEqual(EdgeMenuStateQuerySchema.parse({ active_release_id: id, active_version: '2' }), {
    active_release_id: id,
    active_version: 2,
  });
  assert.equal(
    EdgeMenuStateQuerySchema.parse({ active_release_id: id, active_version: 7 }).active_version,
    7,
  );
  for (const bad of [
    { active_release_id: id, active_version: '0' },
    { active_release_id: id, active_version: '-1' },
    { active_release_id: id, active_version: '02' },
    { active_release_id: id, active_version: '1.5' },
    { active_release_id: id, active_version: '2147483648' },
    { active_release_id: 'x', active_version: '2' },
    { active_release_id: id },
    { active_release_id: id, active_version: '2', extra: '1' },
  ])
    assert.equal(EdgeMenuStateQuerySchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('photo download failures: 4xx and bad bytes are permanent, outages are transient', () => {
  for (const message of [
    'Sync HTTP 404',
    'Sync HTTP 401',
    'Menu media hash mismatch',
    'Menu media is not WebP',
    'Sync response too large',
  ])
    assert.equal(isPermanentMediaFailure(new Error(message)), true, message);
  for (const message of [
    'Sync HTTP 503',
    'Sync HTTP 500',
    'Sync HTTP 429',
    'Sync HTTP 408',
    'fetch failed',
  ])
    assert.equal(isPermanentMediaFailure(new Error(message)), false, message);
  assert.equal(isPermanentMediaFailure(new DOMException('timeout', 'TimeoutError')), false);
  assert.equal(isPermanentMediaFailure('Sync HTTP 404'), false);
});
