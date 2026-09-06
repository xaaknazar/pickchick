import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { fixtureMenu } from '@pickchick/test-fixtures';

export async function withSyncDatabases(run) {
  const instances = [];
  try {
    for (const [service, scope] of [
      ['api', 'cloud'],
      ['edge', 'edge'],
    ]) {
      const config = loadConfig(service);
      const admin = createPool(config.databaseUrl);
      const schema = `sync_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${schema}`);
      const pool = createPool(url.toString());
      instances.push({ pool, admin, schema, config: { ...config, databaseUrl: url.toString() } });
      await migrate(
        pool,
        fileURLToPath(new URL(`../../db/${scope}/migrations/`, import.meta.url)),
        scope,
      );
    }
    const [cloud, edge] = instances;
    const org = randomUUID(),
      legal = randomUUID(),
      branch = randomUUID(),
      device = randomUUID();
    await cloud.pool.query("INSERT INTO organizations(id,name) VALUES ($1,'Sync synthetic')", [
      org,
    ]);
    await cloud.pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES ($1,$2,'Sync synthetic','000000000000')",
      [legal, org],
    );
    await cloud.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'SYNC','Synthetic')",
      [branch, org, legal],
    );
    await cloud.pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES ($1,$2,$3,'edge','Synthetic')",
      [device, branch, org],
    );
    await edge.pool.query(
      "INSERT INTO branch_config(id,code,name,timezone) VALUES ($1,'SYNC','Synthetic','Asia/Almaty')",
      [branch],
    );
    edge.config.branchId = branch;
    const menu = (version = 1) => ({
      ...fixtureMenu,
      branch_id: branch,
      release_id: randomUUID(),
      version,
    });
    await run({ cloud, edge, org, legal, branch, device, menu });
  } finally {
    for (const instance of instances.reverse()) {
      await instance.pool.end();
      await instance.admin.query(`DROP SCHEMA ${instance.schema} CASCADE`);
      await instance.admin.end();
    }
  }
}

export async function running(factory, config) {
  const app = await factory(config);
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}
export const authFor = (identity) => ({ deviceId: identity.device_id, token: identity.token });
export const headersFor = (identity) => ({
  Authorization: `Bearer ${identity.token}`,
  'X-Device-Id': identity.device_id,
  'Content-Type': 'application/json',
});
export const request = (url, options) =>
  fetch(url, { signal: AbortSignal.timeout(5000), ...options });
