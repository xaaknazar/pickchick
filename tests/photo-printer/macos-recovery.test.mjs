import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('macOS bridge recovery: reconnect, private bind, single writer and no print replay', () => {
  const r = spawnSync(
    'python3',
    ['-m', 'unittest', 'discover', '-s', 'tests/photo-printer', '-p', 'test_macos_recovery.py'],
    { encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
