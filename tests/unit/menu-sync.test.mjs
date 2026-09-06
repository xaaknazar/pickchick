import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, hashJson, localCloudOrigin } from '@pickchick/menu-sync';
import { MenuSnapshotSchema } from '@pickchick/contracts';
import { fixtureMenu } from '@pickchick/test-fixtures';

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
