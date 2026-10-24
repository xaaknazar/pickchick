/**
 * Offline stand: one restaurant on one machine (docs/operations/offline-stand.md).
 *
 * Real processes: cloud API (services/api), cashier edge (services/edge) and the three cashier
 * sync workers (worker.mjs, native Windows pacing). Each run owns one schema in the local cloud
 * and edge databases. WAN = FaultProxy between the workers and the API; LAN = FaultProxy between
 * the kitchen screen and the edge. The POS client talks to the edge on loopback, as on the
 * cashier monoblock. Synthetic data only; no network beyond 127.0.0.1.
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { provisionDevice, publishMenu, projectCatalogMenu } from '@pickchick/menu-sync';
import { provisionStaff, openCashShift } from '@pickchick/local-orders';
import { provisionFulfillment, grantStation } from '@pickchick/edge-fulfillment';
import { provisionFulfillmentTransport } from '@pickchick/fulfillment-transport';
import { provisionEdgePosSync, provisionCloudPosSync } from '@pickchick/pos-order-sync';
import { FaultProxy } from './fault-proxy.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const catalogPricing = () => import('../../packages/catalog-pricing/dist/index.js');

export class StandError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

/** Only the local development databases; the stand never touches another host. */
export function checkedAdminUrl(raw, kind) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new StandError('UNSAFE_DATABASE_URL', kind);
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== `/pickchick_${kind === 'restore' ? 'edge' : kind}` ||
    url.search ||
    url.hash
  )
    throw new StandError('UNSAFE_DATABASE_URL', kind);
  return url;
}
export const SCHEMA_PATTERN = /^offstand_[a-f0-9]{16}$/;
export function scopedUrl(adminUrl, schema) {
  if (!SCHEMA_PATTERN.test(schema)) throw new StandError('UNOWNED_SCHEMA');
  const url = new URL(adminUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

/** Synthetic catalog: a prep item with a linked sauce option, sides, a drink, a combo of
 * modifier-free components (catalog pricing refuses combo components with options) and two
 * items (pie, tea) that the scenarios stop and release. */
export function standCatalog() {
  const text = (ru) => ({ ru, kk: '' });
  const product = (id, price, extra = {}) => ({
    id,
    sku: id.toUpperCase().replaceAll('-', '_'),
    name: text('Стенд ' + id),
    description: text('Синтетическая позиция стенда'),
    category_id: 'food',
    price_minor: price,
    image_asset_key: 'i0.jpg',
    available: true,
    prep_required: true,
    prep_minutes: 5,
    serving_label: text('1 шт'),
    weight_g: 100,
    volume_ml: null,
    ingredients: text('Синтетический состав'),
    allergens: [],
    allergens_status: 'declared',
    nutrition: { basis: 'per_serving', energy_kcal: 100, protein_g: 1, fat_g: 1, carbs_g: 1 },
    nutrition_status: 'operator_entered',
    kind: 'item',
    combo_components: [],
    modifier_groups: [],
    ...extra,
  });
  return {
    schema_version: 1,
    currency: 'KZT',
    content_source: 'operator',
    content_reviewed: true,
    categories: [{ id: 'food', name: text('Стенд') }],
    products: [
      product('burger', '150000', {
        modifier_groups: [
          {
            id: 'extra',
            title: text('Добавки'),
            min: 0,
            max: 2,
            options: [
              {
                id: 'sauce',
                label: text('Соус'),
                price_delta_minor: '20000',
                default_quantity: 0,
                max_quantity: 2,
                available: true,
                nutrition_multiplier: 1,
                linked_product_id: 'sauce',
              },
            ],
          },
        ],
      }),
      product('wings', '120000'),
      product('fries', '90000'),
      product('cola', '60000', { prep_required: false }),
      product('sauce', '20000', { prep_required: false }),
      product('pie', '50000', { prep_required: false }),
      product('tea', '30000', { prep_required: false }),
      product('combo-day', '250000', {
        kind: 'combo',
        combo_components: [
          { product_id: 'wings', quantity: 1 },
          { product_id: 'fries', quantity: 1 },
          { product_id: 'cola', quantity: 1 },
        ],
      }),
    ],
    estimated_minutes: { min: 5, max: 15 },
    upsell_product_ids: ['sauce'],
  };
}

const SERVICES = {
  api: { script: 'services/api/dist/main.js', args: [] },
  edge: { script: 'services/edge/dist/main.js', args: [] },
  fulfillment: { script: 'tests/offline-stand/worker.mjs', args: ['fulfillment'] },
  pos: { script: 'tests/offline-stand/worker.mjs', args: ['pos'] },
  menu: { script: 'tests/offline-stand/worker.mjs', args: ['menu'] },
};
export const WORKERS = ['fulfillment', 'pos', 'menu'];

export class Stand {
  constructor({ runDir, cloudUrl, edgeUrl, restoreUrl, seed = 1, log = () => {} }) {
    this.runDir = runDir;
    this.admin = {
      cloud: checkedAdminUrl(cloudUrl, 'cloud').toString(),
      edge: checkedAdminUrl(edgeUrl, 'edge').toString(),
      restore: restoreUrl ? checkedAdminUrl(restoreUrl, 'restore').toString() : null,
    };
    this.schema = `offstand_${randomBytes(8).toString('hex')}`;
    this.seed = seed;
    this.log = log;
    this.processes = {};
    this.restarts = Object.fromEntries(Object.keys(SERVICES).map((name) => [name, 0]));
    this.created = { cloud: false, edge: false, restore: false };
    this.edgeAdmin = this.admin.edge;
  }

  get cloudUrl() {
    return scopedUrl(this.admin.cloud, this.schema);
  }
  get edgeUrl() {
    return scopedUrl(this.edgeAdmin, this.schema);
  }

  async create() {
    await mkdir(resolve(this.runDir, 'logs'), { recursive: true, mode: 0o700 });
    for (const kind of ['cloud', 'edge']) {
      const admin = createPool(this.admin[kind], 1);
      try {
        if (
          (await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [this.schema])).rowCount
        )
          throw new StandError('SCHEMA_EXISTS');
        this.created[kind] = true;
        await admin.query(`CREATE SCHEMA ${this.schema}`);
      } finally {
        await admin.end();
      }
    }
    this.cloud = createPool(this.cloudUrl, 6);
    this.edge = createPool(this.edgeUrl, 4);
    await migrate(this.cloud, resolve(root, 'db/cloud/migrations'), 'cloud');
    await migrate(this.edge, resolve(root, 'db/edge/migrations'), 'edge');
    await this.seed_();
    this.ports = { api: await freePort(), edge: await freePort() };
    this.wan = new FaultProxy({
      name: 'wan',
      target: `http://127.0.0.1:${this.ports.api}`,
      seed: this.seed,
    });
    this.lan = new FaultProxy({
      name: 'lan',
      target: `http://127.0.0.1:${this.ports.edge}`,
      seed: this.seed + 1,
    });
    await this.wan.start();
    await this.lan.start();
    this.apiOrigin = `http://127.0.0.1:${this.ports.api}`;
    this.edgeOrigin = `http://127.0.0.1:${this.ports.edge}`;
    for (const name of Object.keys(SERVICES)) await this.start(name);
    await this.waitFor('menu applied on the edge', async () =>
      Boolean((await this.edge.query('SELECT 1 FROM active_menu')).rowCount),
    );
    await this.waitFor('cloud sees a fresh cashier heartbeat', () => this.cloudAvailabilityFresh());
  }

  async seed_() {
    const ids = (this.ids = {
      org: randomUUID(),
      legal: randomUUID(),
      branch: randomUUID(),
      device: randomUUID(),
      transportProducer: randomUUID(),
      prep: randomUUID(),
      assembly: randomUUID(),
      payment: randomUUID(),
      kioskPayment: randomUUID(),
      fiscal: randomUUID(),
      kiosk: randomUUID(),
      comboProgram: randomUUID(),
      catalogManager: randomUUID(),
    });
    const c = this.cloud,
      e = this.edge;
    await c.query("INSERT INTO organizations(id,name) VALUES($1,'Offline stand synthetic')", [
      ids.org,
    ]);
    await c.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Offline stand synthetic','000000000000')",
      [ids.legal, ids.org],
    );
    await c.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'OFF','Offline stand')",
      [ids.branch, ids.org, ids.legal],
    );
    await c.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES($1,$2,$3,'edge','Offline stand edge')",
      [ids.device, ids.branch, ids.org],
    );
    this.identity = await provisionDevice(c, ids.device);
    this.identityPath = resolve(this.runDir, 'device-identity.json');
    await writeFile(this.identityPath, JSON.stringify(this.identity) + '\n', { mode: 0o600 });
    const scope = {
      organizationId: ids.org,
      branchId: ids.branch,
      deviceId: ids.device,
      producerId: ids.transportProducer,
    };
    await provisionFulfillmentTransport(c, scope);
    for (const [id, kind, provider] of [
      [ids.payment, 'payment', 'synthetic-offline-stand'],
      [ids.kioskPayment, 'payment', 'kaspi-qr'],
      [ids.fiscal, 'fiscal', 'synthetic-offline-stand'],
    ])
      await c.query(
        'INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,legal_entity_id,kind,provider,external_reference,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,true)',
        [id, ids.org, ids.branch, ids.legal, kind, provider, id],
      );
    this.kioskKey = randomBytes(32).toString('hex');
    await c.query(
      'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
      [ids.kiosk, ids.org, ids.branch, createHash('sha256').update(this.kioskKey).digest('hex')],
    );
    await c.query(
      "INSERT INTO combo_reward_programs(id,organization_id,branch_id,version,gift_product_id,starts_at,approval_reference) VALUES($1,$2,$3,'seven-paid-combos-v1','pick-combo',clock_timestamp()-interval '1 day','Synthetic offline stand')",
      [ids.comboProgram, ids.org, ids.branch],
    );
    // Catalog publication -> projected cashier menu, exactly as the catalog listener publishes it.
    const { catalogPayloadHash } = await catalogPricing();
    const payload = (this.catalog = standCatalog());
    const hash = catalogPayloadHash(payload);
    await c.query(
      "INSERT INTO catalog_managers(id,organization_id,name,token_hash) VALUES($1,$2,'Offline stand manager',$3)",
      [ids.catalogManager, ids.org, createHash('sha256').update(ids.catalogManager).digest('hex')],
    );
    await c.query(
      'INSERT INTO catalog_draft_versions(branch_id,organization_id,revision,payload,payload_hash,actor_id) VALUES($1,$2,1,$3,$4,$5)',
      [ids.branch, ids.org, payload, hash, ids.catalogManager],
    );
    const published = (
      await c.query(
        'INSERT INTO catalog_publications(branch_id,organization_id,version,source_revision,payload,payload_hash,actor_id) VALUES($1,$2,1,1,$3,$4,$5) RETURNING published_at',
        [ids.branch, ids.org, payload, hash, ids.catalogManager],
      )
    ).rows[0].published_at;
    await c.query(
      'INSERT INTO catalog_branch_heads(branch_id,organization_id,draft_revision,published_version) VALUES($1,$2,1,1)',
      [ids.branch, ids.org],
    );
    await c.query('UPDATE branches SET ordering_enabled=true WHERE id=$1', [ids.branch]);
    this.menu = projectCatalogMenu(payload, ids.branch, 1, published.toISOString());
    await publishMenu(c, this.menu);
    await c.query(
      'INSERT INTO catalog_menu_deliveries(branch_id,catalog_version,release_id,device_id) VALUES($1,1,$2,$3)',
      [ids.branch, this.menu.release_id, ids.device],
    );
    // Cashier edge: unpaid service to the kitchen, two stations, routing derived on menu apply.
    await e.query(
      "INSERT INTO branch_config(id,code,name,timezone,ordering_enabled) VALUES($1,'OFF','Offline stand','Asia/Almaty',true)",
      [ids.branch],
    );
    await e.query("UPDATE branch_config SET pos_service_mode='unpaid_service' WHERE id=$1", [
      ids.branch,
    ]);
    await provisionFulfillment(e, {
      ...scope,
      stations: [
        { id: ids.prep, kind: 'prep', name: 'Стенд: кухня' },
        { id: ids.assembly, kind: 'assembly', name: 'Стенд: сборка и выдача' },
      ],
      routing: {
        version: 1,
        assemblyStationId: ids.assembly,
        routes: [{ productId: 'burger', stationId: ids.prep, kind: 'prep' }],
      },
    });
    const posScope = await provisionEdgePosSync(e, {
      organizationId: ids.org,
      branchId: ids.branch,
      deviceId: ids.device,
    });
    await provisionCloudPosSync(c, posScope);
    this.terminal = randomUUID();
    this.staffSetup = {
      cashier: { staff_id: randomUUID(), terminal_id: this.terminal, role: 'cashier' },
      manager: { staff_id: randomUUID(), terminal_id: this.terminal, role: 'shift_manager' },
      cook: { staff_id: randomUUID(), terminal_id: randomUUID(), role: 'kitchen' },
      packer: { staff_id: randomUUID(), terminal_id: randomUUID(), role: 'kitchen' },
    };
    await this.refreshStaff();
    await grantStation(e, ids.branch, this.staffSetup.cook.staff_id, ids.prep);
    await grantStation(e, ids.branch, this.staffSetup.packer.staff_id, ids.assembly);
    this.shift = await openCashShift(e, ids.branch, this.auth('manager'), randomUUID(), {
      opening_cash_minor: '0',
    });
  }

  /** Staff access lasts 8 hours on the edge; a long soak signs everyone in again each hour. */
  async refreshStaff() {
    this.staff = {};
    for (const [key, setup] of Object.entries(this.staffSetup))
      this.staff[key] = await provisionStaff(this.edge, this.ids.branch, {
        ...setup,
        name: `Стенд ${key}`,
      });
  }
  auth(key) {
    const c = this.staff[key];
    return { sessionId: c.session_id, token: c.token };
  }

  env(name) {
    const base = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      APP_ENV: 'test',
      NODE_OPTIONS: '--max-old-space-size=384',
      DB_POOL_MAX: '4',
    };
    if (name === 'api')
      return {
        ...base,
        CLOUD_DATABASE_URL: this.cloudUrl,
        REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0',
        API_PORT: String(this.ports.api),
        CLOUD_FULFILLMENT_TRANSPORT_ENABLED: 'true',
        CLOUD_POS_ORDER_SYNC_ENABLED: 'true',
      };
    const edge = {
      ...base,
      EDGE_DATABASE_URL: this.edgeUrl,
      EDGE_BRANCH_ID: this.ids.branch,
      EDGE_DEVICE_ID: this.ids.device,
      EDGE_FULFILLMENT_ENABLED: 'true',
    };
    if (name === 'edge')
      return { ...edge, EDGE_PORT: String(this.ports.edge), EDGE_REMOTE_STOPS_ENABLED: 'true' };
    return {
      ...edge,
      EDGE_FULFILLMENT_TRANSPORT_ENABLED: 'true',
      EDGE_POS_ORDER_SYNC_ENABLED: 'true',
      FULFILLMENT_TRANSPORT_PROTOCOL: '4',
      OFFLINE_STAND_CLOUD_ORIGIN: this.wan.url,
      OFFLINE_STAND_IDENTITY: this.identityPath,
    };
  }

  async start(name) {
    if (this.processes[name]) throw new StandError('ALREADY_RUNNING', name);
    // Every start after the first one is a restart (crash drills, reconnect healing).
    if (this.started?.has(name)) this.restarts[name]++;
    (this.started ??= new Set()).add(name);
    const spec = SERVICES[name];
    const logFile = await open(resolve(this.runDir, 'logs', `${name}.log`), 'a', 0o600);
    const child = spawn(process.execPath, [resolve(root, spec.script), ...spec.args], {
      cwd: root,
      env: this.env(name),
      stdio: ['ignore', logFile.fd, logFile.fd],
    });
    const exited = new Promise((done) =>
      child.once('exit', (code, signal) => done({ code, signal })),
    );
    this.processes[name] = { child, exited, logFile };
    exited.then(() => logFile.close().catch(() => {}));
    if (name === 'api') await this.waitReady(this.apiOrigin, name);
    if (name === 'edge') await this.waitReady(this.edgeOrigin, name);
  }

  /** SIGKILL models a crash (power, process killed between commit and ACK); SIGTERM a stop. */
  async stop(name, signal = 'SIGTERM') {
    const entry = this.processes[name];
    if (!entry) return null;
    delete this.processes[name];
    if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill(signal);
    const timer = setTimeout(() => entry.child.kill('SIGKILL'), 10000);
    const result = await entry.exited;
    clearTimeout(timer);
    return result;
  }
  async restart(name, signal = 'SIGKILL') {
    await this.stop(name, signal);
    await this.start(name);
  }
  running(name) {
    return Boolean(this.processes[name]);
  }

  async waitReady(origin, name, timeoutMs = 60000) {
    await this.waitFor(
      `${name} ready`,
      async () => {
        try {
          const response = await fetch(`${origin}/health/ready`, {
            signal: AbortSignal.timeout(2000),
          });
          return response.ok && (await response.json()).ready === true;
        } catch {
          return false;
        }
      },
      timeoutMs,
      250,
    );
  }
  async waitFor(label, predicate, timeoutMs = 120000, intervalMs = 500) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new StandError('TIMEOUT', label);
      await sleep(intervalMs);
    }
  }

  async cloudAvailabilityFresh() {
    const row = (
      await this.cloud.query(
        "SELECT observed_at>clock_timestamp()-interval '30 seconds' AS fresh FROM cloud_branch_availability WHERE branch_id=$1",
        [this.ids.branch],
      )
    ).rows[0];
    return row?.fresh === true;
  }

  /** Catalog pricing for kiosk/mobile quotes (same module the checkouts use). */
  async pricing() {
    return catalogPricing();
  }

  async close({ keep = false } = {}) {
    for (const name of [...WORKERS, 'edge', 'api']) await this.stop(name).catch(() => {});
    await this.wan?.close().catch(() => {});
    await this.lan?.close().catch(() => {});
    await this.cloud?.end().catch(() => {});
    await this.edge?.end().catch(() => {});
    const dropped = [];
    if (!keep)
      for (const [kind, url] of [
        ['cloud', this.admin.cloud],
        ['edge', this.admin.edge],
        ['restore', this.admin.restore],
      ]) {
        if (!this.created[kind] || !url) continue;
        const admin = createPool(url, 1);
        const client = await admin.connect();
        try {
          await client.query('SET statement_timeout = 0');
          await client.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
          dropped.push(kind);
        } finally {
          client.release();
          await admin.end();
        }
      }
    return { dropped, kept: keep ? this.schema : null };
  }
}
