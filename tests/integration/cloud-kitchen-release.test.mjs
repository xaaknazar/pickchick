import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSyncDatabases } from '../helpers/sync.mjs';
import {
  cloudKitchenStatus,
  deployCloudKitchen,
  expandSetup,
  EXPECTED_FUNCTIONS,
  EXPECTED_PRIVILEGES,
  MIGRATIONS,
  setMode,
} from '../../infra/staging/cloud-kitchen-release-owner.mjs';
import { runtimePrivileges } from '../../infra/staging/unified-menu-owner.mjs';
import { provisionCloudKitchenInTransaction } from '@pickchick/cloud-kitchen';

const CATALOG = [
  { id: 'piko-burger', kind: 'item' },
  { id: 'cola', kind: 'item' },
  { id: 'combo-duo', kind: 'combo' },
];
/** Owner client stub: one head publication and the active routing (or none). */
function fakeClient({ products, active, heads = 1 }) {
  return {
    async query(sql) {
      if (sql.includes('catalog_branch_heads'))
        return {
          rows: Array.from({ length: heads }, () => ({ version: 7, payload: { products } })),
        };
      if (sql.includes('cloud_kitchen_routing')) return { rows: active ? [active] : [] };
      throw new Error('unexpected query');
    },
  };
}
const PREP = '9ba8dc69-260c-482b-bed9-cab791b64595',
  ASSEMBLY = '2cbc8ef3-359b-4cf0-bda8-28b82b727c93',
  BRANCH = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1';
const minimal = {
  branchId: BRANCH,
  stations: [
    { id: ASSEMBLY, kind: 'assembly', name: 'Name A from input' },
    { id: PREP, kind: 'prep', name: 'Name P from input' },
  ],
  routeAllProductsTo: PREP,
};

test('minimal kitchen setup routes every head-catalog product to the named prep station', async () => {
  const first = await expandSetup(fakeClient({ products: CATALOG, active: null }), minimal);
  assert.equal(first.routeAll, true);
  assert.equal(first.catalogVersion, 7);
  assert.deepEqual(first.setup.stations, minimal.stations);
  assert.deepEqual(first.setup.routing, {
    version: 1,
    assemblyStationId: ASSEMBLY,
    routes: [
      { productId: 'cola', stationId: PREP, kind: 'prep' },
      { productId: 'combo-duo', stationId: PREP, kind: 'prep', unexpandedCombo: 'whole_product' },
      { productId: 'piko-burger', stationId: PREP, kind: 'prep' },
    ],
  });
  const active = {
    version: 3,
    assembly_station_id: ASSEMBLY,
    payload: first.setup.routing,
  };
  const same = await expandSetup(fakeClient({ products: CATALOG, active }), minimal);
  assert.equal(same.setup.routing.version, 3);
  assert.equal(same.unchanged, true);
  const grown = await expandSetup(
    fakeClient({ products: [...CATALOG, { id: 'fries', kind: 'item' }], active }),
    minimal,
  );
  assert.equal(grown.setup.routing.version, 4);
  assert.equal(grown.setup.routing.routes.length, 4);
  const full = { branchId: BRANCH, stations: minimal.stations, routing: first.setup.routing };
  assert.equal((await expandSetup(fakeClient({ products: CATALOG, active }), full)).setup, full);
  await assert.rejects(
    expandSetup(fakeClient({ products: CATALOG, active: null, heads: 0 }), minimal),
    /head catalog/,
  );
  await assert.rejects(
    expandSetup(fakeClient({ products: CATALOG, active: null }), {
      ...minimal,
      routeAllProductsTo: ASSEMBLY,
    }),
    /routeAllProductsTo/,
  );
  await assert.rejects(
    expandSetup(fakeClient({ products: CATALOG, active: null }), { ...minimal, routing: {} }),
    /Setup must be/,
  );
});

const migrations = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));

test('cloud kitchen owner applies only additive 053-056 with the reviewed grants and keeps every branch edge', async () => {
  const old = await mkdtemp(join(tmpdir(), 'cloud052-'));
  const directory = await mkdtemp(join(tmpdir(), 'cloud056-'));
  try {
    for (const n of await readdir(migrations)) {
      if (n.endsWith('.sql') && n < '053') await copyFile(join(migrations, n), join(old, n));
      if (n.endsWith('.sql') && n < '057') await copyFile(join(migrations, n), join(directory, n));
    }
    await withSyncDatabases(
      async ({ cloud }) => {
        const role = 'ck_' + randomUUID().replaceAll('-', '');
        await cloud.pool.query(
          `CREATE ROLE ${role} NOLOGIN; GRANT USAGE ON SCHEMA ${cloud.schema} TO ${role};GRANT SELECT ON branches TO ${role}`,
        );
        const c = await cloud.pool.connect();
        try {
          await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          const plan = await deployCloudKitchen(c, { directory, role, inspect: true });
          assert.deepEqual(plan.pending, MIGRATIONS);
          assert.deepEqual(plan.privilegesAdded, EXPECTED_PRIVILEGES);
          await c.query('ROLLBACK');
          await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          const result = await deployCloudKitchen(c, { directory, role });
          assert.equal(result.existingDataPreserved, true);
          assert.equal(result.allBranchesEdge, true);
          assert.deepEqual(result.applied, MIGRATIONS);
          assert.deepEqual(result.functionsAdded, EXPECTED_FUNCTIONS);
          await c.query('COMMIT');
          const acl = await runtimePrivileges(c, role);
          assert.deepEqual(acl, ['branches||SELECT', ...EXPECTED_PRIVILEGES].sort());
          assert.ok(!acl.some((p) => /\|(DELETE|TRUNCATE)$/.test(p)));

          const status = await cloudKitchenStatus(c, '00000000-0000-4000-8000-000000000001');
          assert.equal(status.mode, 'edge');
          assert.equal(status.activeCloudOrders, 0);
          await c.query('BEGIN');
          await assert.rejects(
            setMode(c, {
              branch: '00000000-0000-4000-8000-000000000001',
              owner: 'cloud',
              operator: 'owner',
              reason: 'synthetic',
            }),
            /stations and routing/,
          );
          await c.query('ROLLBACK');

          const org = randomUUID(),
            legal = randomUUID(),
            branch = randomUUID(),
            prep = randomUUID(),
            assembly = randomUUID();
          await c.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic')", [org]);
          await c.query(
            "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
            [legal, org],
          );
          await c.query(
            "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'ck-release','Synthetic')",
            [branch, org, legal],
          );
          await c.query('BEGIN');
          await provisionCloudKitchenInTransaction(c, {
            branchId: branch,
            stations: [
              { id: prep, kind: 'prep', name: 'Горячий цех' },
              { id: assembly, kind: 'assembly', name: 'Сборка' },
            ],
            routing: {
              version: 1,
              assemblyStationId: assembly,
              routes: [{ productId: 'burger', stationId: prep, kind: 'prep' }],
            },
          });
          const cloud = await setMode(c, {
            branch,
            owner: 'cloud',
            operator: 'owner',
            reason: 'synthetic release check',
          });
          assert.deepEqual(cloud, { before: 'edge', after: 'cloud', epoch: 1, audited: true });
          const enabled = await cloudKitchenStatus(c, branch);
          assert.deepEqual(enabled.prepStations, [prep]);
          assert.deepEqual(enabled.assemblyStations, [assembly]);
          await assert.rejects(
            setMode(c, { branch, owner: 'cloud', operator: 'owner', reason: 'repeat' }),
          );
          await c.query('ROLLBACK');
          await c.query('BEGIN');
          await provisionCloudKitchenInTransaction(c, {
            branchId: branch,
            stations: [
              { id: prep, kind: 'prep', name: 'Горячий цех' },
              { id: assembly, kind: 'assembly', name: 'Сборка' },
            ],
            routing: {
              version: 1,
              assemblyStationId: assembly,
              routes: [{ productId: 'burger', stationId: prep, kind: 'prep' }],
            },
          });
          await setMode(c, { branch, owner: 'cloud', operator: 'owner', reason: 'synthetic on' });
          const edge = await setMode(c, {
            branch,
            owner: 'edge',
            operator: 'owner',
            reason: 'synthetic off',
          });
          assert.deepEqual(edge, { before: 'cloud', after: 'edge', epoch: 2, audited: true });
          await c.query('COMMIT');

          // Minimal setup expands into a routing the real provisioning accepts (version moves on).
          const expanded = await expandSetup(fakeClient({ products: CATALOG, active: null }), {
            branchId: branch,
            stations: [
              { id: assembly, kind: 'assembly', name: 'Сборка' },
              { id: prep, kind: 'prep', name: 'Горячий цех' },
            ],
            routeAllProductsTo: prep,
          });
          expanded.setup.routing.version = 2;
          await c.query('BEGIN');
          await provisionCloudKitchenInTransaction(c, expanded.setup);
          assert.equal((await cloudKitchenStatus(c, branch)).routingVersion, 2);
          await c.query('ROLLBACK');

          await c.query('BEGIN');
          await assert.rejects(deployCloudKitchen(c, { directory, role }), /ledger/);
          await c.query('ROLLBACK');
        } finally {
          await c.query('ROLLBACK');
          c.release();
          await cloud.pool.query(`DROP OWNED BY ${role};DROP ROLE ${role}`);
        }
      },
      { cloudMigrationDirectory: old },
    );
  } finally {
    await rm(old, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
