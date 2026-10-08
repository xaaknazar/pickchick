import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';

test('backoffice responsive controls, navigation, assets and empty reports', () =>
  withCatalog(
    async (c) => {
      const dir = await mkdtemp(join(tmpdir(), 'pickchick-design-'));
      try {
        const fixture = join(dir, 'fixture.json');
        await writeFile(
          fixture,
          JSON.stringify({ url: c.url + '/backoffice/', manager: c.manager }),
          { mode: 0o600 },
        );
        const result = await new Promise((resolve, reject) => {
          const child = spawn(
            process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
            [fileURLToPath(new URL('design-browser.py', import.meta.url)), fixture],
            { stdio: 'inherit' },
          );
          const timeout = setTimeout(() => child.kill('SIGTERM'), 60000);
          child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.once('exit', (code) => {
            clearTimeout(timeout);
            resolve(code);
          });
        });
        assert.equal(result, 0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    { staticPrefix: '/backoffice' },
  ));
