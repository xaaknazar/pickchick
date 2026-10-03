import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
export const bracesAdvisory = 'GHSA-vfj7-8cjw-p6xm';
export const patchSha256 = 'f07ff9d4f414f3098095620789bde1052e6a9939666d05e2ab70c34ed0c76012';
const hashes = {
  'lib/check-depth.js': 'c4b0feaec67eb87998b2c784c6733cb04955e1d2e8dc017fed6ffd9ceb4845c7',
  'lib/parse.js': 'f2c2efad3edac044a9d480d7e25b2d3a71dda3e6e5ae96781213f8d090e12557',
  'lib/compile.js': 'd99da8a3f70e1b5c1b7d13a15f7fd05a26a645cd61fd9013471cc74b8c4885f9',
  'lib/expand.js': '67591bd8624c74da22801986db46fdd252611ac4bacdcf137088b4c32becc60e',
  'lib/stringify.js': 'dd514780e3da131d1dabbeafab4b9c5b458addb05782093989d89d99fb2a1906',
};
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
export function bracesChecks(braces) {
  assert.deepEqual(braces.expand('menu/{mobile,pos,kiosk}'), [
    'menu/mobile',
    'menu/pos',
    'menu/kiosk',
  ]);
  assert.equal(braces.compile('{a,b}'), '(a|b)');
  for (const [open, close] of [
    ['{', '}'],
    ['(', ')'],
  ]) {
    const pattern = open.repeat(1000) + 'a,b' + close.repeat(1000);
    for (const action of [braces.parse, braces.compile, braces.expand, braces.stringify])
      assert.throws(() => action(pattern), /nesting exceeds safety limit/);
  }
  let ast = { type: 'text', value: 'leaf' };
  for (let depth = 0; depth < 1000; depth++) ast = { type: 'root', nodes: [ast] };
  for (const action of [braces.compile, braces.expand, braces.stringify])
    assert.throws(() => action(ast), /nesting exceeds safety limit/);
  const cycle = { type: 'root', nodes: [] };
  cycle.nodes.push(cycle);
  assert.throws(() => braces.compile(cycle), /nesting exceeds safety limit/);
}
export function verifyBracesPatch() {
  assert.equal(digest(root + 'patches/braces@3.0.3.patch'), patchSha256);
  for (const name of ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']) {
    const lock = readFileSync(root + name, 'utf8');
    assert.ok(lock.includes('braces@3.0.3: ' + patchSha256));
    const snapshots = lock.split('\nsnapshots:\n')[1];
    const entries = [...snapshots.matchAll(/^ {2}braces@([^\n]+):/gm)];
    assert.equal(entries.length, 1);
    assert.equal(entries[0][1], `3.0.3(patch_hash=${patchSha256})`);
    for (const ref of snapshots.matchAll(/^ +braces: ([^\n]+)$/gm))
      assert.equal(ref[1], `3.0.3(patch_hash=${patchSha256})`);
  }
  const copies = readdirSync(root + 'node_modules/.pnpm').filter((n) => n.startsWith('braces@'));
  assert.ok(copies.length);
  for (const copy of copies) {
    const directory = root + 'node_modules/.pnpm/' + copy + '/node_modules/braces/';
    assert.equal(JSON.parse(readFileSync(directory + 'package.json')).version, '3.0.3');
    for (const [file, hash] of Object.entries(hashes)) assert.equal(digest(directory + file), hash);
    bracesChecks(createRequire(import.meta.url)(directory));
  }
}
