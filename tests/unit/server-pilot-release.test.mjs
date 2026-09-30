import test from 'node:test';
import { execFileSync } from 'node:child_process';
test('server pilot release preserves overlays, bounds privileges and validates opt-in secrets', () => {
  execFileSync('python3', ['-m', 'unittest', 'tests/operations/test_server_pilot_release.py'], {
    stdio: 'pipe',
  });
});
