import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const repository = new URL('../../', import.meta.url);

test('standalone kitchen package starts and serves health without the source checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-kitchen-package-'));
  try {
    for (const path of [
      'infra/kitchen-portal',
      'infra/roadmap/remote-deploy.py',
      'apps/kitchen/server.mjs',
      'apps/kitchen/terminal-cookie.mjs',
    ]) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await cp(new URL(path, repository), join(root, path), { recursive: true });
    }
    await mkdir(join(root, 'apps/kitchen/dist'), { recursive: true });
    await writeFile(
      join(root, 'apps/kitchen/dist/index.html'),
      '<!doctype html><title>Fixture</title>',
    );
    await exec('git', ['init', '-q', root]);
    await exec(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'Fixture',
      ],
      { cwd: root },
    );
    const built = await exec(process.execPath, ['infra/kitchen-portal/package.mjs'], { cwd: root });
    const artifact = join(root, JSON.parse(built.stdout).package);
    const manifest = JSON.parse(await readFile(join(artifact, 'kitchen-package.json'), 'utf8'));
    for (const [path, expected] of Object.entries(manifest.files)) {
      assert.equal(
        createHash('sha256')
          .update(await readFile(join(artifact, path)))
          .digest('hex'),
        expected,
      );
    }
    // Resolve imports solely from the distributable. The real checkout cannot mask missing files.
    const probe = `
      import assert from 'node:assert/strict';
      import { once } from 'node:events';
      import { createPortal } from './infra/kitchen-portal/server.mjs';
      import { checkPortal } from './infra/kitchen-portal/healthcheck.mjs';
      const portal = await createPortal({origin:'https://kitchen.example', key:'a'.repeat(64),
        terminalAccess:true, assetDir:'./apps/kitchen/dist', sourceSha:'package-test'});
      try {
        portal.server.listen(0, '127.0.0.1'); await once(portal.server, 'listening');
        await checkPortal({origin:'https://kitchen.example', port:portal.server.address().port});
      } finally { await portal.close(); }
    `;
    await exec(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: artifact,
      timeout: 15000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
