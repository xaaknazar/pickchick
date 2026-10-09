import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';

/**
 * Devices tab in Chromium. Login and the operations snapshot use the real isolated API; the
 * registry routes are mocked in the browser with synthetic devices. Screenshots are kept only
 * when BACKOFFICE_DEVICES_SCREENSHOTS names a directory.
 */
test('devices tab: groups, iPad pairing, guarded revoke, legacy fallback at 1440 and 400 px', () =>
  withCatalog(
    async (c) => {
      const dir = await mkdtemp(join(tmpdir(), 'pickchick-devices-'));
      try {
        const fixture = join(dir, 'fixture.json');
        await writeFile(
          fixture,
          JSON.stringify({
            url: c.url + '/backoffice/',
            manager: c.manager,
            branch: c.branch,
            shots: process.env.BACKOFFICE_DEVICES_SCREENSHOTS || null,
          }),
          { mode: 0o600 },
        );
        const result = await new Promise((resolve, reject) => {
          const child = spawn(
            process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
            [fileURLToPath(new URL('devices-browser.py', import.meta.url)), fixture],
            { stdio: 'inherit' },
          );
          const timeout = setTimeout(() => child.kill('SIGTERM'), 90000);
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
