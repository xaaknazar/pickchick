import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
test('full backoffice browser uses real PostgreSQL, scoped manager and durable commands', () =>
  withCatalog(
    async (c) => {
      await c.service.seed(c.manager.token, c.branch, {
        request_id: randomUUID(),
        expected_revision: 0,
      });
      const output = new URL('../../.local/backoffice-full/', import.meta.url);
      await mkdir(output, { recursive: true });
      const temp = await mkdtemp(fileURLToPath(new URL('run-', output))),
        file = temp + '/fixture.json';
      try {
        await writeFile(
          file,
          JSON.stringify({
            url: c.url + '/backoffice/',
            manager: c.manager,
            branch: c.branch,
            output: fileURLToPath(output),
          }),
          { mode: 0o600 },
        );
        const code = await new Promise((resolve, reject) => {
          const p = spawn(
            process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
            [fileURLToPath(new URL('browser_operations.py', import.meta.url)), file],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          p.stdout.on('data', (d) => process.stdout.write(d));
          p.stderr.on('data', (d) => process.stderr.write(d));
          p.on('error', reject);
          p.on('exit', resolve);
        });
        assert.equal(code, 0);
        const state = await c.backoffice.read(c.manager.token, c.branch);
        assert.equal(state.stock[0].quantity, '800');
        assert.equal(state.stock[0].value_minor, '280000');
        assert.equal(state.documents.length, 3);
        assert.ok(state.audit.length >= 7);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
    { staticPrefix: '/backoffice' },
  ));
