import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../packages/platform/dist/config.js';

// Runs after package compilation in pnpm test; deployment Python checks also
// run before Node dependencies exist in the isolated-image CI job.
test('isolated rehearsal environment passes the real staging config validator', () => {
  const program = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location('runtime_config_test','infra/staging/release-runtime-1021.py')
r=importlib.util.module_from_spec(s);sys.modules[s.name]=r;s.loader.exec_module(r)
print(json.dumps(r.rehearsal_environment({'APP_ENV':'staging'},'a'*64,'b'*64,'c'*40)))`;
  const env = JSON.parse(
    execFileSync('python3', ['-c', program], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
    }),
  );
  const config = loadConfig('api', env);
  assert.equal(config.environment, 'staging');
  assert.equal(new URL(config.databaseUrl).hostname, 'cloud-db');
  assert.equal(new URL(config.redisUrl).hostname, 'redis-cache');
});
