import { createHash } from 'node:crypto';
import { createPool, transaction } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import {
  fixtureIds as id,
  fixtureBranch as branch,
  fixtureMenu as menu,
} from '@pickchick/test-fixtures';

// Provision synthetic fixtures directly into both databases; this is NOT a sync worker.
const payload = JSON.stringify(menu);
const checksum = createHash('sha256').update(payload).digest('hex');

if (process.argv.slice(2).some((arg) => arg !== '--cloud-only'))
  throw new Error('Unsupported seed argument');
if (process.env.APP_ENV === 'staging' && !process.argv.includes('--cloud-only'))
  throw new Error('Staging seed must explicitly select --cloud-only');
for (const service of process.argv.includes('--cloud-only') ? ['api'] : ['api', 'edge']) {
  const config = loadConfig(service);
  const pool = createPool(config.databaseUrl);
  try {
    await transaction(pool, async (client) => {
      if (service === 'api') {
        await client.query(
          'INSERT INTO organizations(id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id.organization, 'PickChick synthetic test organization'],
        );
        await client.query(
          'INSERT INTO legal_entities(id, organization_id, name, bin) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [id.legalEntity, id.organization, 'Synthetic legal entity', '000000000000'],
        );
        await client.query(
          'INSERT INTO branches(id, organization_id, legal_entity_id, code, name, timezone) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
          [id.branch, id.organization, id.legalEntity, branch.code, branch.name, branch.timezone],
        );
        await client.query(
          'INSERT INTO devices(id, branch_id, organization_id, kind, name) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
          [id.device, id.branch, id.organization, 'edge', 'Synthetic unpaired edge'],
        );
        await client.query(
          'INSERT INTO categories(id, organization_id, name_ru, name_kk) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [id.category, id.organization, 'Тестовое меню', 'Сынақ мәзірі'],
        );
        await client.query(
          'INSERT INTO products(id, organization_id, category_id, name_ru, name_kk) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
          [id.product, id.organization, id.category, menu.items[0].name.ru, menu.items[0].name.kk],
        );
        await client.query(
          'INSERT INTO product_variants(id, organization_id, product_id, sku) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [id.variant, id.organization, id.product, 'TEST-PORTION'],
        );
        await client.query(
          'INSERT INTO branch_prices(branch_id, organization_id, variant_id, price_minor) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [id.branch, id.organization, id.variant, menu.items[0].price_minor],
        );
        await client.query(
          'INSERT INTO menu_releases(id, branch_id, version, schema_version, payload, checksum, published_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
          [
            id.release,
            id.branch,
            menu.version,
            menu.schema_version,
            payload,
            checksum,
            menu.published_at,
          ],
        );
        await client.query(
          'INSERT INTO branch_menu_activations(branch_id, release_id, acknowledged_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [id.branch, id.release, menu.published_at],
        );
      } else {
        if (config.branchId !== id.branch)
          throw new Error('Seed only supports the synthetic branch');
        await client.query(
          'INSERT INTO branch_config(id, code, name, timezone) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [id.branch, branch.code, branch.name, branch.timezone],
        );
        await client.query(
          'INSERT INTO menu_snapshots(id, branch_id, version, schema_version, payload, checksum, published_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
          [
            id.release,
            id.branch,
            menu.version,
            menu.schema_version,
            payload,
            checksum,
            menu.published_at,
          ],
        );
        await client.query(
          'INSERT INTO active_menu(branch_id, release_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id.branch, id.release],
        );
      }
    });
    console.log(JSON.stringify({ service, synthetic_seed: 'complete', ordering_enabled: false }));
  } finally {
    await pool.end();
  }
}
