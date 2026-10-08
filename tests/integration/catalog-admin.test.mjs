/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { catalogAdminGrants } from '../../infra/staging/catalog-admin-grants.mjs';
import { catalogAccessGrants } from '../../infra/staging/catalog-edge-grants.mjs';
import { backofficeGrants } from '../../infra/staging/backoffice-grants.mjs';
import {
  CatalogAdmin,
  CatalogAdminError,
  provisionCatalogManager,
  revokeCatalogManager,
  CatalogStateSchema,
} from '../../packages/catalog-admin/dist/index.js';
import { withSyncDatabases } from '../helpers/sync.mjs';
const isError = (code) => (error) => error instanceof CatalogAdminError && error.code === code;
const immutable = (error) => error.code === '23514';
async function fixture(run) {
  await withSyncDatabases(async (context) => {
    const { cloud, org, branch, legal } = context;
    const manager = await provisionCatalogManager(cloud.pool, {
      organization_id: org,
      name: 'Synthetic catalog editor',
      branch_ids: [branch],
    });
    const service = new CatalogAdmin(cloud.pool, { enabled: true });
    const seed = () =>
      service.seed(manager.token, branch, { expected_revision: 0, request_id: randomUUID() });
    const save = (state, payload = state.draft.payload) =>
      service.save(manager.token, branch, {
        expected_revision: state.draft.revision,
        request_id: randomUUID(),
        payload,
      });
    const publish = (state) =>
      service.publish(manager.token, branch, {
        expected_revision: state.draft.revision,
        expected_published_version: state.published?.version ?? 0,
        request_id: randomUUID(),
        confirmation: 'publish_catalog',
      });
    await run({
      ...context,
      pool: cloud.pool,
      org,
      branch,
      legal,
      manager,
      service,
      seed,
      save,
      publish,
    });
  });
}
test('production-shaped grants allow row locks without permitting credential or branch-scope mutation', async () =>
  fixture(async (ctx) => {
    const role = 'catalog_runtime_' + randomUUID().replaceAll('-', '');
    await ctx.cloud.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let runtime;
    try {
      await ctx.pool.query(
        `GRANT USAGE ON SCHEMA ${ctx.cloud.schema} TO ${role}; GRANT SELECT ON branches TO ${role}`,
      );
      await ctx.pool.query(catalogAdminGrants(role, true));
      const url = new URL(ctx.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${ctx.cloud.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 2);
      const service = new CatalogAdmin(runtime, { enabled: true });
      assert.equal((await service.branches(ctx.manager.token)).branches.length, 1);
      let state = await service.seed(ctx.manager.token, ctx.branch, {
        expected_revision: 0,
        request_id: randomUUID(),
      });
      const payload = structuredClone(state.draft.payload);
      payload.content_reviewed = true;
      state = await service.save(ctx.manager.token, ctx.branch, {
        expected_revision: state.draft.revision,
        request_id: randomUUID(),
        payload,
      });
      const result = await service.publish(ctx.manager.token, ctx.branch, {
        expected_revision: state.draft.revision,
        expected_published_version: 0,
        request_id: randomUUID(),
        confirmation: 'publish_catalog',
      });
      assert.equal(result.published.version, 1);
      for (const sql of [
        "UPDATE catalog_managers SET token_hash=repeat('a',64)",
        'UPDATE catalog_manager_branches SET actor_id=actor_id',
        'DELETE FROM catalog_managers',
        'CREATE TABLE forbidden(id integer)',
      ])
        await assert.rejects(runtime.query(sql), (e) => e.code === '42501');
      await assert.rejects(
        runtime.query('UPDATE catalog_managers SET lock_anchor=false'),
        immutable,
      );
      await ctx.pool.query(catalogAdminGrants(role, false));
      await assert.rejects(
        runtime.query('UPDATE catalog_managers SET lock_anchor=true'),
        (e) => e.code === '42501',
      );
      // The public read follows the editor flag; a published version survives disabling it.
      await assert.rejects(
        new CatalogAdmin(runtime).publicCatalog(ctx.branch),
        isError('SERVICE_UNAVAILABLE'),
      );
      assert.equal(
        (await new CatalogAdmin(runtime, { enabled: true }).publicCatalog(ctx.branch)).version,
        1,
      );
      await assert.rejects(
        runtime.query('SELECT token_hash FROM catalog_managers'),
        (e) => e.code === '42501',
      );
    } finally {
      if (runtime) await runtime.end();
      await ctx.pool.query(`DROP OWNED BY ${role}`);
      await ctx.cloud.admin.query(`DROP ROLE ${role}`);
    }
  }));
test('migration and scoped CLI credential never create a public issue route or TEST identity', async () =>
  fixture(async (ctx) => {
    assert.deepEqual(
      await migrate(
        ctx.pool,
        fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url)),
        'cloud',
      ),
      [],
    );
    assert.deepEqual(
      (await ctx.service.branches(ctx.manager.token)).branches.map((v) => v.id),
      [ctx.branch],
    );
    const row = (await ctx.pool.query('SELECT * FROM catalog_managers')).rows[0];
    assert.equal(row.token_hash.includes(ctx.manager.token), false);
    assert.equal('token' in row, false);
    assert.equal((await ctx.pool.query('SELECT count(*) FROM test_actors')).rows[0].count, '0');
    await assert.rejects(
      new CatalogAdmin(ctx.pool).branches(ctx.manager.token),
      isError('SERVICE_UNAVAILABLE'),
    );
    await assert.rejects(ctx.service.branches('a'.repeat(64)), isError('UNAUTHORIZED'));
  }));
test('draft create/read/update/delete product is isolated until explicit reviewed publication', async () =>
  fixture(async (ctx) => {
    const empty = await ctx.service.read(ctx.manager.token, ctx.branch);
    assert.equal(empty.draft, null);
    assert.equal(empty.published, null);
    await assert.rejects(ctx.service.publicCatalog(ctx.branch), isError('NOT_FOUND'));
    let state = CatalogStateSchema.parse(await ctx.seed());
    assert.equal(state.draft.revision, 1);
    assert.equal(state.draft.payload.products.length, 24);
    await assert.rejects(ctx.publish(state), isError('CONFLICT'));
    const payload = structuredClone(state.draft.payload);
    const added = {
      ...structuredClone(payload.products.at(-1)),
      id: 'operator-new',
      sku: 'operator-new',
      name: { ru: 'Блюдо оператора', kk: 'Тағам' },
    };
    payload.products.push(added);
    payload.products[0].price_minor = '529000';
    payload.products[0].description.kk = 'Сипаттама';
    state = await ctx.save(state, payload);
    assert.equal(state.draft.payload.products.length, 25);
    payload.products = payload.products.filter((v) => v.id !== 'operator-new');
    payload.content_reviewed = true;
    state = await ctx.save(state, payload);
    assert.equal(state.draft.revision, 3);
    await assert.rejects(ctx.service.publicCatalog(ctx.branch), isError('NOT_FOUND'));
    const published = await ctx.publish(state);
    assert.equal(published.published.version, 1);
    assert.equal(published.draft.revision, 4);
    assert.equal(published.draft.base_version, 1);
    assert.equal(
      (await ctx.service.publicCatalog(ctx.branch)).payload.products[0].price_minor,
      '529000',
    );
    const edited = structuredClone(published.draft.payload);
    edited.products[0].price_minor = '629000';
    const next = await ctx.save(published, edited);
    assert.equal(next.draft.payload.products[0].price_minor, '629000');
    assert.equal(
      (await ctx.service.publicCatalog(ctx.branch)).payload.products[0].price_minor,
      '529000',
    );
    assert.equal(
      (await ctx.pool.query('SELECT ordering_enabled FROM branches WHERE id=$1', [ctx.branch]))
        .rows[0].ordering_enabled,
      false,
    );
    assert.equal((await ctx.pool.query('SELECT count(*) FROM menu_releases')).rows[0].count, '0');
    assert.equal((await ctx.pool.query('SELECT count(*) FROM test_orders')).rows[0].count, '0');
  }));
test('parallel editors cannot overwrite another revision and duplicate lost-response retries append once', async () =>
  fixture(async (ctx) => {
    const first = await ctx.seed(),
      payload = structuredClone(first.draft.payload);
    payload.products[0].name.ru = 'Editor A';
    const request = { expected_revision: 1, request_id: randomUUID(), payload };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => ctx.service.save(ctx.manager.token, ctx.branch, request)),
    );
    assert.ok(responses.every((r) => JSON.stringify(r) === JSON.stringify(responses[0])));
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM catalog_draft_versions')).rows[0].count,
      '2',
    );
    await assert.rejects(
      ctx.service.save(ctx.manager.token, ctx.branch, {
        ...request,
        request_id: randomUUID(),
        payload: { ...payload, content_source: 'operator' },
      }),
      isError('CONFLICT'),
    );
    await assert.rejects(
      ctx.service.save(ctx.manager.token, ctx.branch, {
        ...request,
        payload: { ...payload, content_source: 'operator' },
      }),
      isError('CONFLICT'),
    );
    const races = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        ctx.service.save(ctx.manager.token, ctx.branch, {
          expected_revision: 2,
          request_id: randomUUID(),
          payload: { ...payload, estimated_minutes: { min: 5, max: 10 + i } },
        }),
      ),
    );
    assert.equal(races.filter((v) => v.status === 'fulfilled').length, 1);
    assert.ok(
      races.filter((v) => v.status === 'rejected').every((v) => isError('CONFLICT')(v.reason)),
    );
  }));
test('publication is atomic, idempotent and immutable; new versions preserve old published content and audit actor', async () =>
  fixture(async (ctx) => {
    let state = await ctx.seed();
    state = await ctx.save(state, { ...state.draft.payload, content_reviewed: true });
    const request = {
      expected_revision: state.draft.revision,
      expected_published_version: 0,
      request_id: randomUUID(),
      confirmation: 'publish_catalog',
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ctx.service.publish(ctx.manager.token, ctx.branch, request)),
    );
    assert.ok(results.every((r) => JSON.stringify(r) === JSON.stringify(results[0])));
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM catalog_publications')).rows[0].count,
      '1',
    );
    state = await ctx.save(results[0], {
      ...results[0].draft.payload,
      estimated_minutes: { min: 8, max: 15 },
    });
    await ctx.publish(state);
    const versions = (
      await ctx.pool.query('SELECT version,payload FROM catalog_publications ORDER BY version')
    ).rows;
    assert.equal(versions.length, 2);
    assert.notDeepEqual(
      versions[0].payload.estimated_minutes,
      versions[1].payload.estimated_minutes,
    );
    for (const table of [
      'catalog_publications',
      'catalog_draft_versions',
      'catalog_audit',
      'catalog_command_receipts',
      'catalog_manager_audit',
    ])
      await assert.rejects(ctx.pool.query(`DELETE FROM ${table}`), immutable);
    await assert.rejects(
      ctx.pool.query(
        "UPDATE catalog_publications SET payload=jsonb_set(payload,'{content_reviewed}','false')",
      ),
      immutable,
    );
    const audit = (
      await ctx.pool.query(
        'SELECT actor_id,action,from_revision,to_revision FROM catalog_audit ORDER BY to_revision',
      )
    ).rows;
    assert.ok(
      audit.every(
        (r) => r.actor_id === ctx.manager.actor_id && r.to_revision === r.from_revision + 1,
      ),
    );
    assert.equal(audit.filter((r) => r.action === 'published').length, 2);
  }));
test('same-organization unassigned branch and foreign organization remain inaccessible; ownership is also a PostgreSQL FK', async () =>
  fixture(async (ctx) => {
    const other = randomUUID();
    await ctx.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'OTHER','Synthetic other')",
      [other, ctx.org, ctx.legal],
    );
    await assert.rejects(ctx.service.read(ctx.manager.token, other), isError('FORBIDDEN'));
    await assert.rejects(
      ctx.service.seed(ctx.manager.token, other, {
        expected_revision: 0,
        request_id: randomUUID(),
      }),
      isError('FORBIDDEN'),
    );
    const foreign = randomUUID();
    await ctx.pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic foreign')", [
      foreign,
    ]);
    await assert.rejects(
      provisionCatalogManager(ctx.pool, {
        organization_id: foreign,
        name: 'Foreign actor',
        branch_ids: [ctx.branch],
      }),
      isError('FORBIDDEN'),
    );
    await assert.rejects(
      ctx.pool.query(
        'INSERT INTO catalog_manager_branches(actor_id,organization_id,branch_id) VALUES($1,$2,$3)',
        [ctx.manager.actor_id, foreign, other],
      ),
      (e) => e.code === '23503',
    );
    const state = await ctx.seed();
    await revokeCatalogManager(ctx.pool, ctx.manager.actor_id);
    for (const run of [
      () => ctx.service.read(ctx.manager.token, ctx.branch),
      () => ctx.service.branches(ctx.manager.token),
      () => ctx.save(state),
    ])
      await assert.rejects(run(), isError('UNAUTHORIZED'));
  }));
test('broken dependencies or forged publication source cannot partially save or move active pointers', async () =>
  fixture(async (ctx) => {
    const state = await ctx.seed(),
      payload = structuredClone(state.draft.payload);
    payload.products[0].modifier_groups[0].options[0].linked_product_id = 'deleted-product';
    await assert.rejects(ctx.save(state, payload), isError('INVALID_REQUEST'));
    assert.equal((await ctx.service.read(ctx.manager.token, ctx.branch)).draft.revision, 1);
    await assert.rejects(
      ctx.pool.query('UPDATE catalog_branch_heads SET draft_revision=999 WHERE branch_id=$1', [
        ctx.branch,
      ]),
      (e) => e.code === '23503',
    );
    const original = (await ctx.pool.query('SELECT * FROM catalog_draft_versions')).rows[0];
    await assert.rejects(
      ctx.pool.query(
        'INSERT INTO catalog_publications(branch_id,organization_id,version,source_revision,payload,payload_hash,actor_id) VALUES($1,$2,1,1,$3,$4,$5)',
        [
          ctx.branch,
          ctx.org,
          { ...original.payload, content_reviewed: true },
          original.payload_hash,
          ctx.manager.actor_id,
        ],
      ),
      immutable,
    );
    assert.equal(
      (await ctx.pool.query('SELECT published_version FROM catalog_branch_heads')).rows[0]
        .published_version,
      null,
    );
  }));
test('a failure recording audit rolls back the new version and all pointers', async () =>
  fixture(async (ctx) => {
    const state = await ctx.seed();
    await ctx.pool.query(
      "CREATE FUNCTION synthetic_catalog_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$",
    );
    await ctx.pool.query(
      'CREATE TRIGGER synthetic_catalog_audit_failure BEFORE INSERT ON catalog_audit FOR EACH ROW EXECUTE FUNCTION synthetic_catalog_audit_failure()',
    );
    await assert.rejects(ctx.save(state, { ...state.draft.payload, content_reviewed: true }));
    assert.deepEqual(await ctx.service.read(ctx.manager.token, ctx.branch), state);
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM catalog_draft_versions')).rows[0].count,
      '1',
    );
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM catalog_command_receipts')).rows[0].count,
      '1',
    );
  }));

test('CLI writes a scoped credential only into a new private file and revocation invalidates it', async () =>
  fixture(async (ctx) => {
    const { mkdir, writeFile, readFile, stat, rm } = await import('node:fs/promises');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile),
      directory = '.local/catalog-cli-test-' + randomUUID(),
      input = directory + '/input.json',
      output = directory + '/credential.json';
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        input,
        JSON.stringify({
          organization_id: ctx.org,
          name: 'Synthetic CLI editor',
          branch_ids: [ctx.branch],
        }),
        { mode: 0o600 },
      );
      const options = { env: { ...process.env, CLOUD_DATABASE_URL: ctx.cloud.config.databaseUrl } };
      const result = await run(
        process.execPath,
        ['packages/catalog-admin/dist/cli.js', 'provision', '--input', input, '--output', output],
        options,
      );
      const credential = JSON.parse(await readFile(output, 'utf8'));
      assert.equal((await stat(output)).mode & 0o777, 0o600);
      assert.equal(result.stdout.includes(credential.token), false);
      assert.equal((await ctx.service.branches(credential.token)).actor.id, credential.actor_id);
      await assert.rejects(
        run(
          process.execPath,
          ['packages/catalog-admin/dist/cli.js', 'provision', '--input', input, '--output', output],
          options,
        ),
      );
      assert.equal(
        (await ctx.pool.query('SELECT count(*) FROM catalog_managers')).rows[0].count,
        '2',
      );
      assert.equal(JSON.parse(await readFile(output, 'utf8')).token, credential.token);
      await run(
        process.execPath,
        ['packages/catalog-admin/dist/cli.js', 'revoke', '--actor', credential.actor_id],
        options,
      );
      await assert.rejects(ctx.service.branches(credential.token), isError('UNAUTHORIZED'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }));
test('HTTP catalog routes require scoped Bearer for editing and expose only the explicit published version', async () =>
  fixture(async (ctx) => {
    const { createRequire } = await import('node:module');
    const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
    const { Module } = require('@nestjs/common');
    const { createHttpApplication, RESOURCE } = await import('@pickchick/platform');
    const { CatalogAdminController } =
      await import('../../services/api/dist/catalog-admin-controller.js');
    const { CATALOG_ADMIN } = await import('../../packages/catalog-admin/dist/index.js');
    class CatalogTestModule {}
    Module({
      controllers: [CatalogAdminController],
      providers: [
        { provide: CATALOG_ADMIN, useValue: ctx.service },
        {
          provide: RESOURCE,
          useValue: {
            config: ctx.cloud.config,
            admission: {
              intercept(_ctx, next) {
                return next.handle();
              },
            },
          },
        },
      ],
    })(CatalogTestModule);
    const app = await createHttpApplication(CatalogTestModule);
    try {
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      const request = async (path, method = 'GET', body, token) => {
        const response = await fetch(base + path, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        assert.match(response.headers.get('cache-control'), /no-store/);
        return { status: response.status, body: await response.json() };
      };
      assert.equal((await request('/v1/admin/catalog/branches')).status, 401);
      assert.equal(
        (await request('/v1/admin/catalog/branches', 'GET', undefined, ctx.manager.token)).body
          .actor.id,
        ctx.manager.actor_id,
      );
      const path = '/v1/admin/catalog/branches/' + ctx.branch;
      const seed = await request(
        path + '/draft/seed',
        'POST',
        { expected_revision: 0, request_id: randomUUID() },
        ctx.manager.token,
      );
      assert.equal(seed.status, 200);
      CatalogStateSchema.parse(seed.body);
      const publicPath = '/v1/catalog/branches/' + ctx.branch;
      assert.equal((await request(publicPath)).status, 404);
      const payload = structuredClone(seed.body.draft.payload);
      payload.content_reviewed = true;
      for (const product of payload.products) product.description.ru = 'Я'.repeat(1800);
      const saveBody = {
        payload,
        expected_revision: seed.body.draft.revision,
        request_id: randomUUID(),
      };
      assert.ok(Buffer.byteLength(JSON.stringify(saveBody)) > 100 * 1024);
      const largeSave = await request(path + '/draft', 'PUT', saveBody, ctx.manager.token);
      assert.equal(largeSave.status, 200, 'large valid draft needs its scoped parser');
      const saved = CatalogStateSchema.parse(largeSave.body);
      assert.equal(
        (
          await request(
            path + '/draft',
            'PUT',
            { padding: 'x'.repeat(321 * 1024) },
            ctx.manager.token,
          )
        ).status,
        413,
      );
      assert.equal(
        (
          await request(
            path + '/draft/seed',
            'POST',
            { padding: 'x'.repeat(101 * 1024) },
            ctx.manager.token,
          )
        ).status,
        413,
        'ordinary commands retain 100 KiB cap',
      );
      const published = await request(
        path + '/publish',
        'POST',
        {
          expected_revision: saved.draft.revision,
          expected_published_version: 0,
          request_id: randomUUID(),
          confirmation: 'publish_catalog',
        },
        ctx.manager.token,
      );
      assert.equal(published.status, 200);
      assert.equal((await request(publicPath)).body.version, 1);
      assert.equal(
        JSON.stringify((await request(publicPath)).body).includes(ctx.manager.token),
        false,
      );
      await revokeCatalogManager(ctx.pool, ctx.manager.actor_id);
      assert.equal((await request(path, 'GET', undefined, ctx.manager.token)).status, 401);
    } finally {
      await app.close();
    }
  }));

async function catalogHttp(ctx, service, run) {
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
  const { Module } = require('@nestjs/common');
  const { createHttpApplication, RESOURCE } = await import('@pickchick/platform');
  const { CatalogAdminController } =
    await import('../../services/api/dist/catalog-admin-controller.js');
  const { CATALOG_ADMIN } = await import('../../packages/catalog-admin/dist/index.js');
  class CatalogRoleTestModule {}
  Module({
    controllers: [CatalogAdminController],
    providers: [
      { provide: CATALOG_ADMIN, useValue: service },
      {
        provide: RESOURCE,
        useValue: {
          config: ctx.cloud.config,
          admission: { intercept: (_ctx, next) => next.handle() },
        },
      },
    ],
  })(CatalogRoleTestModule);
  const app = await createHttpApplication(CatalogRoleTestModule);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    await run(async (path, method, body, token) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.match(response.headers.get('cache-control'), /no-store/);
      return { status: response.status, body: await response.json() };
    });
  } finally {
    await app.close();
  }
}

test('role enforcement: no grant is forbidden, analyst only reads, manager writes, under production grants', async () =>
  fixture(async (ctx) => {
    const analyst = await provisionCatalogManager(ctx.pool, {
      organization_id: ctx.org,
      name: 'Synthetic analyst',
      branch_ids: [ctx.branch],
    });
    const role = 'catalog_roles_' + randomUUID().replaceAll('-', '');
    await ctx.cloud.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let runtime;
    try {
      await ctx.pool.query(
        `GRANT USAGE ON SCHEMA ${ctx.cloud.schema} TO ${role}; GRANT SELECT ON branches TO ${role}`,
      );
      // Same order as provisioning: a disabled back-office revokes, catalog access re-grants.
      await ctx.pool.query(catalogAdminGrants(role, true));
      await ctx.pool.query(backofficeGrants(role, false));
      await ctx.pool.query(catalogAccessGrants(role, true));
      const url = new URL(ctx.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${ctx.cloud.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 2);
      const service = new CatalogAdmin(runtime, { enabled: true, enforceRoles: true });
      const seedBody = () => ({ expected_revision: 0, request_id: randomUUID() });
      await assert.rejects(service.read(ctx.manager.token, ctx.branch), isError('FORBIDDEN'));
      await assert.rejects(
        service.seed(ctx.manager.token, ctx.branch, seedBody()),
        isError('FORBIDDEN'),
      );
      await ctx.pool.query(
        "INSERT INTO bo_access_grants(actor_id,branch_id,role) VALUES($1,$3,'manager'),($2,$3,'analyst')",
        [ctx.manager.actor_id, analyst.actor_id, ctx.branch],
      );
      await assert.rejects(
        service.seed(analyst.token, ctx.branch, seedBody()),
        isError('FORBIDDEN'),
      );
      let state = await service.seed(ctx.manager.token, ctx.branch, seedBody());
      assert.equal((await service.read(analyst.token, ctx.branch)).draft.revision, 1);
      const payload = structuredClone(state.draft.payload);
      payload.content_reviewed = true;
      const save = (token) =>
        service.save(token, ctx.branch, {
          expected_revision: state.draft.revision,
          request_id: randomUUID(),
          payload,
        });
      await assert.rejects(save(analyst.token), isError('FORBIDDEN'));
      state = await save(ctx.manager.token);
      const publish = (token) =>
        service.publish(token, ctx.branch, {
          expected_revision: state.draft.revision,
          expected_published_version: 0,
          request_id: randomUUID(),
          confirmation: 'publish_catalog',
        });
      await catalogHttp(ctx, service, async (request) => {
        const path = '/v1/admin/catalog/branches/' + ctx.branch;
        const read = await request(path, 'GET', undefined, analyst.token);
        assert.equal(read.status, 200);
        assert.equal(read.body.draft.revision, state.draft.revision);
        const put = await request(
          path + '/draft',
          'PUT',
          { expected_revision: state.draft.revision, request_id: randomUUID(), payload },
          analyst.token,
        );
        assert.equal(put.status, 403);
        assert.equal(put.body.code, 'FORBIDDEN');
        assert.equal(put.body.error, undefined);
        const denied = await request(
          path + '/publish',
          'POST',
          {
            expected_revision: state.draft.revision,
            expected_published_version: 0,
            request_id: randomUUID(),
            confirmation: 'publish_catalog',
          },
          analyst.token,
        );
        assert.equal(denied.status, 403);
      });
      await assert.rejects(publish(analyst.token), isError('FORBIDDEN'));
      assert.equal((await publish(ctx.manager.token)).published.version, 1);
      assert.equal((await service.read(analyst.token, ctx.branch)).published.version, 1);
      // Disabled enforcement keeps the legacy token-scope behaviour (default in production).
      const legacy = new CatalogAdmin(runtime, { enabled: true });
      state = await legacy.read(analyst.token, ctx.branch);
      assert.equal(
        (
          await legacy.save(analyst.token, ctx.branch, {
            expected_revision: state.draft.revision,
            request_id: randomUUID(),
            payload: state.draft.payload,
          })
        ).draft.revision,
        state.draft.revision + 1,
      );
      for (const sql of [
        "UPDATE bo_access_grants SET role='manager'",
        'DELETE FROM bo_access_grants',
        `INSERT INTO bo_access_grants(actor_id,branch_id,role) VALUES('${randomUUID()}','${ctx.branch}','manager')`,
      ])
        await assert.rejects(runtime.query(sql), (e) => e.code === '42501');
      await assert.rejects(
        runtime.query('UPDATE bo_access_grants SET lock_anchor=false'),
        immutable,
      );
    } finally {
      if (runtime) await runtime.end();
      await ctx.pool.query(`DROP OWNED BY ${role}`);
      await ctx.cloud.admin.query(`DROP ROLE ${role}`);
    }
  }));

test('HTTP publication errors expose only the precise reason code', async () =>
  fixture(async (ctx) => {
    let state = await ctx.seed();
    const payload = structuredClone(state.draft.payload);
    payload.content_reviewed = true;
    payload.products[0].channel_prices_minor = { kiosk: '100' };
    state = await ctx.save(state, payload);
    await catalogHttp(ctx, ctx.service, async (request) => {
      const response = await request(
        '/v1/admin/catalog/branches/' + ctx.branch + '/publish',
        'POST',
        {
          expected_revision: state.draft.revision,
          expected_published_version: 0,
          request_id: randomUUID(),
          confirmation: 'publish_catalog',
        },
        ctx.manager.token,
      );
      assert.equal(response.status, 409);
      const { error, ...envelope } = response.body;
      assert.deepEqual(error, { code: 'CHANNEL_PRICES_NOT_SUPPORTED' });
      assert.deepEqual(Object.keys(envelope).sort(), [
        'code',
        'message_key',
        'retryable',
        'trace_id',
      ]);
      assert.equal(envelope.code, 'CONFLICT');
      assert.equal(envelope.message_key, 'errors.conflict');
      assert.equal(envelope.retryable, false);
      assert.match(envelope.trace_id, /^[a-f0-9-]{36}$/);
    });
    assert.equal((await ctx.service.read(ctx.manager.token, ctx.branch)).published, null);
  }));
