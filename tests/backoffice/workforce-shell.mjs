// Full shell, actual proxy and actual API against disposable schemas only.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import { createApi } from '../../services/api/dist/index.js';
import { createBackofficeServer } from '../../apps/backoffice/server.mjs';
await withSyncDatabases(async ({ cloud, org, branch }) => {
  const manager = await provisionCatalogManager(cloud.pool, {
    organization_id: org,
    name: 'Тестовый управляющий',
    branch_ids: [branch],
  });
  await grantBackoffice(cloud.pool, manager.actor_id, branch, 'manager');
  const app = await createApi({
    ...cloud.config,
    catalogAdminEnabled: true,
    backofficeEnabled: true,
    workforceEnabled: true,
  });
  await app.listen(0, '127.0.0.1');
  const server = createBackofficeServer({ apiPort: Number(new URL(await app.getUrl()).port) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await mkdir('.local/workforce-ui', { recursive: true });
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
        ['tests/backoffice/workforce-shell.py', `http://127.0.0.1:${server.address().port}`],
        { stdio: ['pipe', 'inherit', 'inherit'] },
      );
      child.stdin.end(JSON.stringify({ token: manager.token }));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(Error('Shell browser failed'))));
    });
  } finally {
    await new Promise((r) => server.close(r));
    await app.close();
  }
});
