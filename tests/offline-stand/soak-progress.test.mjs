import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicSnapshot, continuousSoak } from './soak-progress.mjs';

test('eight hours require complete interval coverage, not the final wall clock', () => {
  const samples = Array.from({ length: 48 }, (_, i) => ({ elapsed_ms: (i + 1) * 600000 }));
  assert.equal(continuousSoak(samples, 28800000, 600000).ok, true);
  assert.equal(continuousSoak(samples.slice(0, 45), 28800000, 600000).ok, false);
  assert.equal(continuousSoak([samples.at(-1)], 28800000, 600000).ok, false);
  assert.equal(
    continuousSoak(
      samples.filter((_, i) => i !== 20),
      28800000,
      600000,
    ).ok,
    false,
  );
  assert.equal(continuousSoak([], 28800000, 600000).ok, false);
});

test('duplicate, backwards and invalid observations cannot pass', () => {
  for (const bad of [0, -1, NaN, Infinity, undefined]) {
    assert.equal(
      continuousSoak([{ elapsed_ms: bad }, { elapsed_ms: 1200000 }], 1200000, 600000).ok,
      false,
    );
  }
  assert.equal(
    continuousSoak([{ elapsed_ms: 600000 }, { elapsed_ms: 600000 }], 600000, 600000).ok,
    false,
  );
});

test('process restart overhead is allowed but an extended suspension is rejected', () => {
  assert.equal(
    continuousSoak([{ elapsed_ms: 605000 }, { elapsed_ms: 1200000 }], 1200000, 600000).ok,
    true,
  );
  assert.equal(
    continuousSoak([{ elapsed_ms: 600000 }, { elapsed_ms: 1290001 }], 1200000, 600000).ok,
    false,
  );
});

test('snapshots replace complete private files and clean temporary files on failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soak-progress-'));
  try {
    const path = join(dir, 'report.json');
    await atomicSnapshot(path, JSON.stringify({ status: 'running', samples: [1] }));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(atomicSnapshot(path, Symbol('invalid contents')));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { status: 'running', samples: [1] });
    await atomicSnapshot(path, JSON.stringify({ status: 'passed', samples: [1, 2] }));
    assert.equal(JSON.parse(await readFile(path, 'utf8')).status, 'passed');
    assert.deepEqual(await readdir(dir), ['report.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
