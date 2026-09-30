import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { withCatalog } from './helpers.mjs';
await withCatalog(async (c) => {
  const command = (command) =>
    c.backoffice.command(c.manager.token, c.branch, {
      request_id: randomUUID(),
      reason: 'Synthetic mobile content acceptance',
      command,
    });
  const schedule = {
    starts_at: new Date(Date.now() - 60000).toISOString(),
    ends_at: new Date(Date.now() + 3600000).toISOString(),
  };
  for (const template of ['pick-run', 'pick-man', 'pick-blocks']) {
    const id = randomUUID();
    await command({
      type: 'save',
      kind: 'game',
      id,
      expected_revision: 0,
      payload: {
        name: template,
        template,
        enabled: false,
        daily_attempts: 5,
        reward_chiki: '0',
        schedule,
      },
    });
    await command({ type: 'publish', kind: 'game', id, expected_revision: 1 });
  }
  const id = randomUUID();
  await command({
    type: 'save',
    kind: 'promo',
    id,
    expected_revision: 0,
    payload: {
      name: 'Synthetic promotion',
      title: { ru: 'Акция из бэк-офиса', kk: '' },
      body: { ru: 'Опубликовано управляющим', kk: '' },
      image_asset_key: 'logo',
      channels: ['mobile'],
      schedule,
      status: 'active',
    },
  });
  await command({ type: 'publish', kind: 'promo', id, expected_revision: 1 });
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-content-'));
  try {
    const file = join(dir, 'fixture.json');
    await writeFile(
      file,
      JSON.stringify({
        upstream: c.upstream,
        branch: c.branch,
        url: process.env.MOBILE_RECOVERY_URL ?? 'http://127.0.0.1:4198',
      }),
      { mode: 0o600 },
    );
    const code = await new Promise((resolve, reject) => {
      const p = spawn(
        process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
        ['tests/backoffice/content_browser.py', file],
        { stdio: 'inherit' },
      );
      p.on('error', reject);
      p.on('exit', resolve);
    });
    assert.equal(code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
