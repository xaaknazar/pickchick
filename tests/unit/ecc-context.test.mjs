import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { classify, inspect } from '../../scripts/ecc/context.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'pickchick-ecc-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const put = (file, value = 'fixture\n') => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), value);
  };
  git('init', '-b', 'base');
  put('.gitignore', '.env\n');
  put('README.md');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
  git('switch', '-c', 'task');
  return { root, git, put };
}

test('combines committed, staged, unstaged and untracked paths without modifying Git', (t) => {
  const { root, git, put } = fixture(t);
  put('apps/mobile/committed.ts');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'mobile');
  put('db/cloud/migrations/099.sql');
  git('add', '.');
  put('README.md', 'dirty\n');
  put('docs/name with spaces.md', 'DO_NOT_PRINT_FILE_CONTENT');
  put('.env', 'DO_NOT_PRINT_IGNORED_CONTENT');
  const before = git('status', '--porcelain=v1');
  const report = inspect(root, 'base');
  assert.deepEqual(report.changes.committed, ['apps/mobile/committed.ts']);
  assert.deepEqual(report.changes.staged, ['db/cloud/migrations/099.sql']);
  assert.deepEqual(report.changes.unstaged, ['README.md']);
  assert.deepEqual(report.changes.untracked, ['docs/name with spaces.md']);
  assert.equal(report.dirty, true);
  assert.equal(report.localRefsOnly, true);
  assert.equal(report.checksExecuted, false);
  assert.ok(report.reviewAreas.some((area) => area.area === 'migration'));
  assert.ok(!JSON.stringify(report).includes('DO_NOT_PRINT'));
  assert.equal(git('status', '--porcelain=v1'), before);
});

test('uses merge base so unrelated changes on the base branch are not attributed to task', (t) => {
  const { root, git, put } = fixture(t);
  put('apps/mobile/task.ts');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'task');
  git('switch', 'base');
  put('services/api/unrelated.ts');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'other task');
  git('switch', 'task');
  const report = inspect(root, 'base');
  assert.deepEqual(report.changes.committed, ['apps/mobile/task.ts']);
  assert.notEqual(report.mergeBase, report.baseSha);
});

test('renaming a sensitive path still reviews both the source and destination', (t) => {
  const { root, git, put } = fixture(t);
  put('services/api/payment.ts');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'payment');
  git('branch', 'review-base');
  git('mv', 'services/api/payment.ts', 'renamed.ts');
  const report = inspect(root, 'review-base');
  assert.ok(report.changes.staged.includes('services/api/payment.ts'));
  assert.ok(report.reviewAreas.some((area) => area.area === 'money-data-offline'));
});

test('missing or option-like refs fail instead of yielding a clean report', (t) => {
  const { root } = fixture(t);
  assert.throws(() => inspect(root, '--help'), /Invalid base/);
  assert.throws(() => inspect(root, 'base\nHEAD'), /Invalid base/);
  assert.throws(() => inspect(root, 'absent-branch'));
});

test('clean checkout is not reported as tested or approved', (t) => {
  const { root } = fixture(t);
  const report = inspect(root, 'base');
  assert.equal(report.dirty, false);
  assert.deepEqual(report.reviewAreas, []);
  assert.equal(report.checksExecuted, false);
});

test('checks cover contracts and agent configuration without imposing unrelated app suites', () => {
  assert.deepEqual(classify(['docs/readme.md']), []);
  const areas = classify(['packages/contracts/openapi.json', '.claude/settings.json']);
  assert.ok(areas.some((area) => area.area === 'contracts'));
  assert.ok(areas.some((area) => area.area === 'agent-workflow'));
  assert.ok(!areas.some((area) => area.area === 'mobile'));
});

test('session-start returns a Claude context reminder without modifying the checkout', (t) => {
  const { root, git } = fixture(t);
  const script = fileURLToPath(new URL('../../scripts/ecc/session-start.mjs', import.meta.url));
  const before = git('status', '--porcelain=v1');
  const output = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  const reminder = JSON.parse(output).hookSpecificOutput;
  assert.equal(reminder.hookEventName, 'SessionStart');
  assert.match(reminder.additionalContext, /Current branch: task/);
  assert.match(reminder.additionalContext, /AGENTS.md/);
  assert.equal(git('status', '--porcelain=v1'), before);
});
