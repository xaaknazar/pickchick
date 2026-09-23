import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectSync, SHARED, overlaps, scope } from '../../scripts/project-sync.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pickchick-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '--bare', remote);
  const a = join(root, 'mac-a');
  git(root, 'clone', remote, a);
  function identity(cwd) {
    git(cwd, 'config', 'user.name', 'Sync fixture');
    git(cwd, 'config', 'user.email', 'sync@example.invalid');
  }
  identity(a);
  git(a, 'switch', '-c', SHARED);
  writeFileSync(join(a, 'menu.txt'), 'original\n');
  git(a, 'add', 'menu.txt');
  git(a, 'commit', '-m', 'base');
  git(a, 'push', '-u', 'origin', SHARED);
  const b = join(root, 'mac-b');
  git(root, 'clone', '-b', SHARED, remote, b);
  identity(b);
  const commit = (cwd, text = 'new') => {
    writeFileSync(join(cwd, 'menu.txt'), text + '\n');
    git(cwd, 'add', 'menu.txt');
    git(cwd, 'commit', '-m', text);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  return {
    a,
    b,
    remote,
    git,
    commit,
    A: new ProjectSync(a, remote),
    B: new ProjectSync(b, remote),
  };
}

test('scope conflicts include descendants and shared resources, not similar names', () => {
  assert.ok(overlaps('apps/mobile', 'apps/mobile/src'));
  assert.ok(overlaps('@vps', '@vps/roadmap'));
  assert.ok(overlaps('*', 'packages/contracts'));
  assert.equal(overlaps('apps/mobile', 'apps/mobile-other'), false);
  for (const value of ['../secret', '/tmp', 'apps/../db', '.git', 'apps/*', ''])
    assert.throws(() => scope(value));
});

test('two Macs refresh the shared version; dirty and divergent work is preserved', (t) => {
  const { a, b, A, B, git, commit } = fixture(t);
  commit(a, 'published');
  git(a, 'push');
  assert.throws(() => B.check(), /Есть изменения общей версии/);
  writeFileSync(join(b, 'personal.txt'), 'must survive');
  assert.throws(() => B.sync(), /локальные изменения/);
  assert.equal(readFileSync(join(b, 'personal.txt'), 'utf8'), 'must survive');
  assert.equal(readFileSync(join(b, 'menu.txt'), 'utf8'), 'original\n');
  rmSync(join(b, 'personal.txt'));
  assert.equal(B.sync().head, A.head());
  const local = commit(b, 'local-only');
  commit(a, 'remote-only');
  git(a, 'push');
  assert.throws(() => B.sync());
  assert.equal(B.head(), local);
  assert.equal(readFileSync(join(b, 'menu.txt'), 'utf8'), 'local-only\n');
});

test('active reservations block overlapping work, permit independent tasks and scope extension', (t) => {
  const { a, b, A, B, git } = fixture(t);
  git(a, 'switch', '-c', 'codex/menu');
  git(b, 'switch', '-c', 'codex/kitchen');
  A.claim('menu', ['apps/mobile']);
  assert.throws(() => B.claim('other-menu', ['apps/mobile/src']), /Пересечение/);
  B.claim('kitchen', ['apps/kitchen']);
  A.claim('menu', ['packages/design-tokens']);
  const tasks = B.status().tasks;
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.find((task) => task.id === 'menu').scopes, [
    'apps/mobile',
    'packages/design-tokens',
  ]);
});

test('a concurrent claim cannot overwrite another Mac reservation', (t) => {
  const { a, b, A, B, git } = fixture(t);
  git(a, 'switch', '-c', 'codex/alpha');
  git(b, 'switch', '-c', 'codex/beta');
  const write = A.updateRegistry.bind(A);
  let raced = false;
  A.updateRegistry = (transform) =>
    write((state) => {
      if (!raced) {
        raced = true;
        B.claim('beta', ['db/cloud']);
      }
      return transform(state);
    });
  const before = A.head();
  assert.throws(() => A.claim('alpha', ['db/cloud/migrations']), /Пересечение/);
  assert.deepEqual(
    A.status().tasks.map((task) => task.id),
    ['beta'],
  );
  assert.equal(A.head(), before);
  assert.equal(A.dirty(), false);
});

test('disjoint concurrent registry writes are both retained on retry', (t) => {
  const { a, b, A, B, git } = fixture(t);
  git(a, 'switch', '-c', 'codex/alpha');
  git(b, 'switch', '-c', 'codex/beta');
  const write = A.updateRegistry.bind(A);
  let raced = false;
  A.updateRegistry = (transform) =>
    write((state) => {
      if (!raced) {
        raced = true;
        B.claim('beta', ['apps/kitchen']);
      }
      return transform(state);
    });
  A.claim('alpha', ['apps/mobile']);
  assert.deepEqual(
    A.status()
      .tasks.map((task) => task.id)
      .sort(),
    ['alpha', 'beta'],
  );
});

test('finishing requires a published clean commit integrated in the shared branch', (t) => {
  const { a, A, git, commit } = fixture(t);
  git(a, 'switch', '-c', 'codex/menu');
  A.claim('menu', ['apps/mobile']);
  commit(a, 'menu');
  assert.throws(() => A.finish('menu', 'tested', 'review'), /отправьте свою ветку/);
  git(a, 'push', '-u', 'origin', 'codex/menu');
  assert.throws(() => A.finish('menu', 'tested', 'review'), /общую ветку/);
  git(a, 'push', 'origin', `HEAD:${SHARED}`);
  A.finish('menu', 'Menu tested; no deployment', 'Device review');
  const task = A.status().tasks[0];
  assert.equal(task.status, 'done');
  assert.equal(task.head, A.head());
  assert.equal(task.nextAction, 'Device review');
});

test('handoff preserves reservations and transfers the published task to the other Mac', (t) => {
  const { a, b, A, B, git, commit } = fixture(t);
  git(a, 'switch', '-c', 'codex/menu');
  A.claim('menu', ['apps/mobile']);
  commit(a, 'checkpoint');
  git(a, 'push', '-u', 'origin', 'codex/menu');
  A.finish('menu', 'Checkpoint, tests pending', 'Continue tests', 'available');
  git(b, 'switch', '-c', 'codex/unrelated');
  assert.throws(() => B.claim('overlap', ['apps/mobile']), /Пересечение/);
  git(b, 'switch', '-c', 'codex/menu', 'origin/codex/menu');
  B.claim('menu', ['apps/mobile']);
  assert.equal(B.status().tasks[0].owner, B.owner());
  assert.throws(() => A.finish('menu', 'take back', 'none', 'available'), /свою активную/);
  assert.equal(B.head(), A.head());
});

test('failed fetch does not report cached state as synchronized', (t) => {
  const { remote, B } = fixture(t);
  B.status();
  rmSync(remote, { recursive: true, force: true });
  assert.throws(() => B.status(), /fetch не выполнен/);
});

test('CLI client rejects a different repository and shared-branch editing', (t) => {
  const { a, A } = fixture(t);
  assert.throws(() => new ProjectSync(a), /каноническому репозиторию/);
  assert.throws(() => A.claim('direct', ['apps/mobile']), /отдельную рабочую ветку/);
});

test('fast-forward refuses to overwrite an ignored personal file', (t) => {
  const { a, b, B, git } = fixture(t);
  writeFileSync(join(b, '.git/info/exclude'), 'personal.txt\n');
  writeFileSync(join(b, 'personal.txt'), 'private local content');
  writeFileSync(join(a, 'personal.txt'), 'new upstream content');
  git(a, 'add', 'personal.txt');
  git(a, 'commit', '-m', 'new path');
  git(a, 'push');
  assert.equal(B.dirty(), false);
  assert.throws(() => B.sync());
  assert.equal(readFileSync(join(b, 'personal.txt'), 'utf8'), 'private local content');
});
