/** LOCAL diagnostic only. Synthetic trusted finance -> actual HTTP transport ->
 * ten isolated LAN services. Not an RPS, physical restaurant or production SLO test.
 * Supervisor owns schema cleanup even if the measured child times out/crashes.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URLSearchParams } from 'node:url';
import { setInterval, clearInterval } from 'node:timers';
import { cpus, totalmem, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  HarnessError,
  safeCode,
  defaults,
  checkedUrl,
  checkedSchema,
  scopedUrl,
  parseArgs,
  command,
  dockerProof,
  boundedMap,
  quantiles,
} from './fulfillment-capacity-support.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const file = fileURLToPath(import.meta.url);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const round = (value) => Math.round(value * 1000) / 1000;
const MAX_RUN_MS = 480000; // supervisor stops child at eight minutes; cleanup has two minutes.
const emit = (value) => process.send?.(value);

async function sourceProof() {
  const paths = [
    'packages/database',
    'packages/commerce-core',
    'packages/contracts',
    'packages/edge-fulfillment',
    'packages/fulfillment-transport',
    'packages/local-orders',
    'packages/menu-sync',
    'packages/platform',
    'packages/test-fixtures',
    'packages/catalog-admin',
    'packages/catalog-pricing',
    'packages/customer-identity',
    'packages/phone-verification',
    'packages/test-order-flow',
    'services/api',
    'services/edge',
  ];
  const sourcePaths = [
    ...paths.map((p) => `${p}/src`),
    'db/cloud/migrations',
    'db/edge/migrations',
  ];
  if (await command('git', ['status', '--porcelain', '--', ...sourcePaths], root))
    throw new HarnessError('RUNTIME_SOURCE_DIRTY');
  const sources = {};
  for (const p of (await command('git', ['ls-files', ...sourcePaths], root))
    .split('\n')
    .filter(Boolean))
    sources[p] = hash(await readFile(resolve(root, p)));
  const compiled = {};
  for (const p of paths)
    for (const name of (await readdir(resolve(root, p, 'dist')))
      .filter((n) => n.endsWith('.js'))
      .sort())
      compiled[`${p}/dist/${name}`] = hash(await readFile(resolve(root, p, 'dist', name)));
  return {
    runtime_source_commit: await command('git', ['rev-parse', 'HEAD'], root),
    runtime_source_sha256: hash(JSON.stringify(sources)),
    compiled_javascript: compiled,
    harness_sha256: hash(await readFile(file)),
    helper_sha256: hash(
      await readFile(new URL('./fulfillment-capacity-support.mjs', import.meta.url)),
    ),
  };
}

async function childRun(config) {
  const { createPool, migrate } = await import('../../packages/database/dist/index.js');
  const { CommerceRepository, digest } = await import('../../packages/commerce-core/dist/index.js');
  const { provisionDevice } = await import('../../packages/menu-sync/dist/index.js');
  const { provisionStaff } = await import('../../packages/local-orders/dist/index.js');
  const { provisionFulfillment, grantStation } =
    await import('../../packages/edge-fulfillment/dist/index.js');
  const { provisionFulfillmentTransport, syncFulfillmentOnce } =
    await import('../../packages/fulfillment-transport/dist/index.js');
  const { fixtureMenu } = await import('../../packages/test-fixtures/dist/index.js');
  const { createApi } = await import('../../services/api/dist/index.js');
  const { createEdge } = await import('../../services/edge/dist/index.js');
  const {
    FulfillmentKitchenSchema,
    FulfillmentDisplaySchema,
    FulfillmentSummarySchema,
    ReadinessSchema,
  } = await import('../../packages/contracts/dist/index.js');
  const started = performance.now(),
    apps = [],
    pools = [],
    branches = [];
  let phase = 'migrate',
    stopped = false,
    peakRss = process.memoryUsage().rss;
  const result = {
    phases: {},
    branches: [],
    http: {},
    worker_states: {},
    errors: {},
    assertions: {},
    memory: {
      scope:
        'One child Node process: harness, all API/LAN services and workers; excludes PostgreSQL/Docker.',
      rss_before_bytes: peakRss,
    },
  };
  const memoryTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 100);
  const onStop = () => {
    stopped = true;
  };
  process.on('SIGTERM', onStop);
  process.on('SIGINT', onStop);
  const check = () => {
    if (stopped) throw new HarnessError('INTERRUPTED');
    if (performance.now() - started > MAX_RUN_MS - 15000) throw new HarnessError('RUN_TIME_LIMIT');
  };
  const allowedOrigins = new Set();
  const observedFetch = async (url, init = {}) => {
    check();
    const u = new URL(url);
    if (
      u.hostname !== '127.0.0.1' ||
      u.protocol !== 'http:' ||
      u.username ||
      u.password ||
      !allowedOrigins.has(u.origin)
    )
      throw new HarnessError('NONLOCAL_HTTP_FORBIDDEN');
    const key = u.pathname.startsWith('/internal/')
      ? `transport_${u.pathname.split('/').at(-1)}`
      : u.pathname.endsWith('/actions')
        ? 'lan_actions'
        : u.pathname.endsWith('/kitchen')
          ? 'lan_kitchen'
          : u.pathname.endsWith('/display')
            ? 'lan_display'
            : 'readiness';
    const metric = (result.http[key] ??= {
      attempts: 0,
      statuses: {},
      network_errors: 0,
      samples: [],
    });
    metric.attempts++;
    const at = performance.now();
    try {
      const response = await fetch(u, {
        ...init,
        redirect: 'error',
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      });
      metric.statuses[response.status] = (metric.statuses[response.status] ?? 0) + 1;
      return response;
    } catch (error) {
      metric.network_errors++;
      throw error;
    } finally {
      metric.samples.push(performance.now() - at);
    }
  };
  // LAN reads consume a bounded complete body; the production transport has its own
  // full-body deadline and bounds. Timings above end at headers, not full body.
  async function json(url, schema, init = {}) {
    const signal = AbortSignal.timeout(5000);
    const response = await observedFetch(url, { ...init, signal });
    if (!response.ok) throw new HarnessError(`HTTP_${response.status}`);
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? ''))
      throw new HarnessError('INVALID_RESPONSE');
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 3 * 1024 * 1024) {
        await reader.cancel();
        throw new HarnessError('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }
  const headers = (actor) => ({
    Authorization: `Bearer ${actor.token}`,
    'X-Staff-Session-Id': actor.session_id,
    'X-Terminal-Id': actor.terminal_id,
  });
  async function pages(branch, mode, actor, station) {
    const items = [],
      seen = new Set();
    let cursor,
      count = 0;
    for (;;) {
      check();
      const query = new URLSearchParams({ limit: '37' });
      if (station) query.set('stationId', station);
      if (cursor) query.set(mode === 'display' ? 'afterNumber' : 'afterOrderId', cursor);
      const page = await json(
        `${branch.origin}/edge/v1/fulfillment/${mode}?${query}`,
        mode === 'display' ? FulfillmentDisplaySchema : FulfillmentKitchenSchema,
        { headers: headers(actor) },
      );
      count++;
      items.push(...page.items);
      cursor = mode === 'display' ? page.nextAfterNumber : page.nextAfterOrderId;
      if (cursor === null) break;
      if (seen.has(cursor) || count > 30 || items.length > 1000)
        throw new HarnessError('BAD_PAGINATION');
      seen.add(cursor);
    }
    return { items, pages: count };
  }
  async function runPhase(name, operation) {
    check();
    phase = name;
    emit({ type: 'phase', phase: name, status: 'started' });
    const at = performance.now();
    await operation();
    result.phases[name] = { seconds: round((performance.now() - at) / 1000) };
    emit({ type: 'phase', phase: name, ...result.phases[name], status: 'passed' });
  }
  let cloud;
  try {
    const cloudUrl = scopedUrl(config.urls.cloud, 'cloud', config.schemas.cloud);
    cloud = createPool(cloudUrl, 4);
    pools.push(cloud);
    await migrate(cloud, resolve(root, 'db/cloud/migrations'), 'cloud');
    const org = randomUUID(),
      legal = randomUUID();
    await cloud.query(
      "INSERT INTO organizations(id,name) VALUES($1,'Synthetic transport capacity')",
      [org],
    );
    await cloud.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic only','000000000000')",
      [legal, org],
    );
    const commerce = new CommerceRepository(cloud);
    await runPhase('setup', async () => {
      for (let index = 0; index < config.schemas.edges.length; index++) {
        check();
        const edgeUrl = scopedUrl(config.urls.edge, 'edge', config.schemas.edges[index]);
        const pool = createPool(edgeUrl, 2);
        pools.push(pool);
        await migrate(pool, resolve(root, 'db/edge/migrations'), 'edge');
        const scope = {
          organizationId: org,
          branchId: randomUUID(),
          deviceId: randomUUID(),
          producerId: randomUUID(),
        };
        const branch = {
          index,
          pool,
          scope,
          orders: [],
          started: new Set(),
          prep: randomUUID(),
          assembly: randomUUID(),
          release: randomUUID(),
          payment: randomUUID(),
          fiscal: randomUUID(),
        };
        branches.push(branch);
        branch.sales = {
          organizationId: org,
          branchId: scope.branchId,
          principalId: randomUUID(),
          role: 'sales',
        };
        await cloud.query(
          "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,$4,'Synthetic capacity branch')",
          [scope.branchId, org, legal, `CAP-${index}`],
        );
        await cloud.query(
          "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES($1,$2,$3,'edge','Synthetic capacity edge')",
          [scope.deviceId, scope.branchId, org],
        );
        const menu = { ...fixtureMenu, branch_id: scope.branchId, release_id: branch.release };
        await cloud.query(
          'INSERT INTO menu_releases(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,1,1,$3,$4,clock_timestamp())',
          [branch.release, scope.branchId, menu, digest(menu)],
        );
        for (const [id, kind] of [
          [branch.payment, 'payment'],
          [branch.fiscal, 'fiscal'],
        ])
          await cloud.query(
            "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,legal_entity_id,kind,provider,external_reference,enabled) VALUES($1,$2,$3,$4,$5,'synthetic-capacity-only',$6,true)",
            [id, org, scope.branchId, legal, kind, id],
          );
        branch.identity = await provisionDevice(cloud, scope.deviceId);
        await provisionFulfillmentTransport(cloud, scope);
        await pool.query(
          "INSERT INTO branch_config(id,code,name,timezone,ordering_enabled) VALUES($1,$2,'Synthetic capacity edge','Asia/Almaty',true)",
          [scope.branchId, `CAP-${index}`],
        );
        await provisionFulfillment(pool, {
          ...scope,
          stations: [
            { id: branch.prep, kind: 'prep', name: 'Synthetic prep' },
            { id: branch.assembly, kind: 'assembly', name: 'Synthetic assembly' },
          ],
          routing: {
            version: 1,
            assemblyStationId: branch.assembly,
            routes: [{ productId: 'burger', stationId: branch.prep, kind: 'prep' }],
          },
        });
        for (const [key, station] of [
          ['cook', branch.prep],
          ['packer', branch.assembly],
        ]) {
          branch[key] = await provisionStaff(pool, scope.branchId, {
            staff_id: randomUUID(),
            terminal_id: randomUUID(),
            name: 'Synthetic capacity staff',
            role: 'kitchen',
          });
          await grantStation(pool, scope.branchId, branch[key].staff_id, station);
        }
        const app = await createEdge({
          service: 'edge',
          environment: 'test',
          databaseUrl: edgeUrl,
          databasePoolMax: 2,
          httpMaxInFlight: 8,
          branchId: scope.branchId,
          edgeDeviceId: scope.deviceId,
          edgeFulfillmentEnabled: true,
          fulfillmentTransportEnabled: true,
          port: 0,
        });
        apps.push(app);
        await app.listen(0, '127.0.0.1');
        branch.origin = await app.getUrl();
        allowedOrigins.add(branch.origin);
      }
      const app = await createApi({
        service: 'api',
        environment: 'test',
        databaseUrl: cloudUrl,
        databasePoolMax: 8,
        httpMaxInFlight: 24,
        fulfillmentTransportEnabled: true,
        customerAuthEnabled: false,
        testOrderFlowEnabled: false,
        catalogAdminEnabled: false,
        port: 0,
      });
      apps.push(app);
      await app.listen(0, '127.0.0.1');
      const origin = await app.getUrl();
      allowedOrigins.add(origin);
      for (const b of branches)
        b.worker = { enabled: true, branchId: b.scope.branchId, origin, identity: b.identity };
      for (const origin of allowedOrigins)
        assert.equal((await json(`${origin}/health/ready`, ReadinessSchema)).ready, true);
    });
    await runPhase('create_orders', () =>
      boundedMap(branches, 10, async (b) => {
        for (let index = 0; index < config.ordersPerBranch; index++) {
          check();
          const q = await commerce.issueQuote(b.sales, randomUUID(), {
            releaseId: b.release,
            channel: 'mobile',
            serviceMode: index % 2 ? 'takeaway' : 'dine_in',
            currency: 'KZT',
            ttlSeconds: 300,
            lines: [
              {
                lineId: randomUUID(),
                productId: 'burger',
                title: 'Synthetic capacity burger',
                description: 'Synthetic only; no customer data',
                quantity: 2,
                unitPriceMinor: '150000',
                discountMinor: '0',
                taxCode: 'SYNTHETIC',
              },
            ],
          });
          const order = await commerce.createOrder(b.sales, randomUUID(), {
            quoteId: q.quoteId,
            fiscalAccountId: b.fiscal,
          });
          b.orders.push(order.orderId);
        }
      }),
    );
    async function drain(expectedStates) {
      await boundedMap(branches, 10, async (b) => {
        for (let turn = 0; turn < config.ordersPerBranch * 4 + 20; turn++) {
          check();
          const state = await syncFulfillmentOnce(b.pool, b.worker, { fetch: observedFetch });
          result.worker_states[state.state] = (result.worker_states[state.state] ?? 0) + 1;
          if (
            !['applied', 'acknowledged', 'idle'].includes(state.state) ||
            state.error ||
            state.reverseError ||
            state.unresolvedFailures ||
            state.unresolvedReverseFailures
          )
            throw new HarnessError(
              `WORKER_${state.error ?? state.reverseError ?? 'UNEXPECTED_STATE'}`,
            );
          if (state.state !== 'idle') continue;
          const count = (
            await cloud.query(
              'SELECT count(*) FROM cloud_fulfillment_projection WHERE branch_id=$1 AND state=ANY($2)',
              [b.scope.branchId, expectedStates],
            )
          ).rows[0].count;
          const forward = (
            await cloud.query(
              "SELECT count(*) FROM commerce_outbox e JOIN commerce_orders o ON o.id=e.order_id WHERE o.branch_id=$1 AND e.event_type IN ('edge.admission_requested','edge.kitchen_admission_requested') AND e.acknowledged_at IS NULL",
              [b.scope.branchId],
            )
          ).rows[0].count;
          const reverse = (
            await b.pool.query(
              'SELECT count(*) FROM fulfillment_outbox WHERE acknowledged_at IS NULL',
            )
          ).rows[0].count;
          assert.equal(Number(count), config.ordersPerBranch);
          assert.equal(forward, '0');
          assert.equal(reverse, '0');
          return;
        }
        throw new HarnessError('DRAIN_BOUND_EXCEEDED');
      });
    }
    await runPhase('http_reservations', () => drain(['held']));
    await runPhase('synthetic_finance', () =>
      boundedMap(branches, 10, async (b) => {
        for (const orderId of b.orders) {
          check();
          const attempt = await commerce.startPaymentAttempt(b.sales, randomUUID(), {
            orderId,
            providerAccountId: b.payment,
          });
          await commerce.observePayment(
            { organizationId: org, branchId: b.scope.branchId, accountId: b.payment },
            {
              eventId: randomUUID(),
              attemptId: attempt.attemptId,
              outcome: 'captured',
              operationId: randomUUID(),
              amountMinor: attempt.amountMinor,
              occurredAt: new Date().toISOString(),
            },
          );
          const sale = (await commerce.readOrder(b.sales, orderId)).fiscalDocuments[0];
          await commerce.observeFiscal(
            { organizationId: org, branchId: b.scope.branchId, accountId: b.fiscal },
            {
              eventId: randomUUID(),
              documentId: sale.id,
              outcome: 'issued',
              providerDocumentId: randomUUID(),
              fiscalMark: 'synthetic-only',
              receiptUrl: 'https://example.invalid/synthetic-capacity',
              amountMinor: sale.amount_minor,
              occurredAt: new Date().toISOString(),
            },
          );
        }
      }),
    );
    await runPhase('http_kitchen_admission', () => drain(['accepted']));
    await runPhase('lan_start_half', () =>
      boundedMap(branches, 10, async (b) => {
        const before = await pages(b, 'kitchen', b.cook, b.prep);
        assert.equal(before.items.length, config.ordersPerBranch);
        for (const order of before.items.slice(0, Math.floor(config.ordersPerBranch / 2))) {
          const task = order.tasks.find((t) => t.stationId === b.prep);
          assert.ok(task);
          const reply = await json(
            `${b.origin}/edge/v1/fulfillment/orders/${order.orderId}/actions`,
            FulfillmentSummarySchema,
            {
              method: 'POST',
              headers: {
                ...headers(b.cook),
                'Content-Type': 'application/json',
                'Idempotency-Key': randomUUID(),
              },
              body: JSON.stringify({
                action: 'start_task',
                expectedVersion: order.version,
                taskId: task.taskId,
                expectedTaskVersion: task.version,
              }),
            },
          );
          assert.equal(reply.state, 'in_production');
          b.started.add(order.orderId);
        }
      }),
    );
    await runPhase('http_task_facts', () => drain(['accepted', 'in_production']));
    await runPhase('verify_active_snapshot', () =>
      boundedMap(branches, 10, async (b) => {
        const prep = await pages(b, 'kitchen', b.cook, b.prep);
        const assembly = await pages(b, 'kitchen', b.packer, b.assembly);
        const display = await pages(b, 'display', b.packer);
        const orderIds = [...b.orders].sort();
        assert.deepEqual(prep.items.map((o) => o.orderId).sort(), orderIds);
        assert.deepEqual(assembly.items.map((o) => o.orderId).sort(), orderIds);
        assert.equal(new Set(display.items.map((o) => o.number)).size, config.ordersPerBranch);
        assert.deepEqual(
          display.items.map((o) => o.number).sort(),
          prep.items.map((o) => o.displayNumber).sort(),
        );
        assert.ok(display.items.every((o) => o.state === 'preparing'));
        const columns =
          'order_id,branch_id,device_id,reservation_id,quote_id,quote_hash,owner_hash,version,state,display_number,routing_version,assembly_station_id';
        const edge = (
          await b.pool.query(`SELECT ${columns} FROM fulfillment_reservations ORDER BY order_id`)
        ).rows;
        const projected = (
          await cloud.query(
            `SELECT ${columns} FROM cloud_fulfillment_projection WHERE branch_id=$1 ORDER BY order_id`,
            [b.scope.branchId],
          )
        ).rows;
        assert.deepEqual(projected, edge);
        const byId = new Map(edge.map((r) => [r.order_id, r]));
        const allTasks = (await b.pool.query('SELECT * FROM fulfillment_tasks')).rows;
        const tasksById = new Map(allTasks.map((task) => [task.id, task]));
        assert.equal(allTasks.length, config.ordersPerBranch);
        for (const order of [...prep.items, ...assembly.items]) {
          const row = byId.get(order.orderId);
          assert.equal(order.branchId, b.scope.branchId);
          assert.equal(order.version, row.version);
          assert.equal(order.state, b.started.has(order.orderId) ? 'in_production' : 'accepted');
          assert.equal(order.state, row.state);
          assert.equal(order.displayNumber, row.display_number);
          assert.equal(order.tasks.length, 1);
          for (const task of order.tasks) {
            const saved = tasksById.get(task.taskId);
            assert.ok(saved);
            assert.equal(saved.order_id, order.orderId);
            assert.equal(task.version, saved.version);
            assert.equal(task.state, saved.state);
            assert.equal(task.stationId, saved.station_id);
          }
        }
        const tasks = (
          await b.pool.query(
            "SELECT order_id,id AS task_id,station_id,version,state FROM fulfillment_tasks WHERE state='in_progress' ORDER BY order_id,id",
          )
        ).rows;
        const observed = (
          await cloud.query(
            'SELECT order_id,task_id,station_id,version,state FROM cloud_fulfillment_observed_tasks WHERE order_id=ANY($1) ORDER BY order_id,task_id',
            [b.orders],
          )
        ).rows;
        assert.deepEqual(observed, tasks);
        assert.equal(tasks.length, b.started.size);
        const versionCheck = (
          await cloud.query(
            'SELECT count(*) FROM cloud_fulfillment_projection p WHERE p.branch_id=$1 AND p.version=(SELECT MAX(v.version) FROM cloud_fulfillment_versions v WHERE v.order_id=p.order_id)',
            [b.scope.branchId],
          )
        ).rows[0].count;
        assert.equal(Number(versionCheck), config.ordersPerBranch);
        const financial = (
          await cloud.query(
            `SELECT count(*) orders, count(*) FILTER(WHERE o.attention_required) attention,
        count(*) FILTER(WHERE (SELECT SUM(c.amount_minor) FROM commerce_captures c WHERE c.order_id=o.id)=o.total_minor) exact_capture,
        count(*) FILTER(WHERE EXISTS(SELECT 1 FROM commerce_fiscal_documents f WHERE f.order_id=o.id AND f.kind='sale' AND f.state='issued')) issued_sale
        FROM commerce_orders o WHERE branch_id=$1`,
            [b.scope.branchId],
          )
        ).rows[0];
        assert.equal(Number(financial.orders), config.ordersPerBranch);
        assert.equal(financial.attention, '0');
        assert.equal(financial.exact_capture, financial.orders);
        assert.equal(financial.issued_sale, financial.orders);
        const pending = (
          await b.pool.query('SELECT pending_cloud FROM fulfillment_transport_state')
        ).rows;
        assert.ok(pending.length === 1 && pending[0].pending_cloud === null);
        const inboxCount = Number(
          (await b.pool.query('SELECT count(*) FROM fulfillment_inbox')).rows[0].count,
        );
        assert.equal(inboxCount, config.ordersPerBranch * 2);
        result.branches.push({
          branch_index: b.index,
          active_orders: prep.items.length,
          accepted: prep.items.length - b.started.size,
          in_production: b.started.size,
          prep_orders: prep.items.length,
          assembly_orders: assembly.items.length,
          display_orders: display.items.length,
          cloud_projection_orders: projected.length,
          matching_order_versions: projected.length,
          matching_observed_task_versions: observed.length,
          edge_inbox_commands: inboxCount,
          pages: { prep: prep.pages, assembly: assembly.pages, display: display.pages },
          cloud_forward_unacknowledged: 0,
          edge_reverse_unacknowledged: 0,
          pending_cloud: false,
        });
      }),
    );
    const total = config.schemas.edges.length * config.ordersPerBranch;
    const counts = (
      await cloud.query(`SELECT
      (SELECT count(*) FROM commerce_orders) orders,
      (SELECT count(*) FROM cloud_fulfillment_projection WHERE state IN ('accepted','in_production')) active_projection,
      (SELECT count(*) FROM commerce_captures) captures,
      (SELECT count(*) FROM commerce_fiscal_documents WHERE kind='sale' AND state='issued') sales,
      (SELECT count(*) FROM cloud_fulfillment_inbox) received_facts`)
    ).rows[0];
    for (const key of ['orders', 'active_projection', 'captures', 'sales'])
      assert.equal(Number(counts[key]), total);
    assert.equal(
      Number(counts.received_facts),
      total * 2 + branches.reduce((n, b) => n + b.started.size, 0),
    );
    result.assertions = {
      ...counts,
      all_active_at_same_barrier: true,
      branch_and_station_membership: true,
      all_pages_read: true,
      aggregate_and_observed_task_versions_match: true,
      durable_forward_and_reverse_queues_drained: true,
      provider_calls: 0,
    };
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.failed_phase = phase;
    result.errors[safeCode(error)] = 1;
  } finally {
    clearInterval(memoryTimer);
    result.branches.sort((a, b) => a.branch_index - b.branch_index);
    result.memory.sampled_peak_rss_bytes = Math.max(peakRss, process.memoryUsage().rss);
    result.memory.rss_end_bytes = process.memoryUsage().rss;
    result.memory.heap_used_end_bytes = process.memoryUsage().heapUsed;
    for (const metric of Object.values(result.http)) {
      metric.header_latency = quantiles(metric.samples);
      delete metric.samples;
    }
    result.total_http_attempts = Object.values(result.http).reduce((n, m) => n + m.attempts, 0);
    result.total_http_non_2xx = Object.values(result.http).reduce(
      (n, m) =>
        n +
        Object.entries(m.statuses).reduce(
          (sum, [status, count]) =>
            sum + (Number(status) >= 200 && Number(status) < 300 ? 0 : count),
          0,
        ),
      0,
    );
    result.total_http_network_errors = Object.values(result.http).reduce(
      (n, m) => n + m.network_errors,
      0,
    );
    result.duration_seconds = round((performance.now() - started) / 1000);
    emit({ type: 'result', result });
    const closed = await Promise.allSettled(apps.map((app) => app.close()));
    const ended = await Promise.allSettled(pools.map((pool) => pool.end()));
    if ([...closed, ...ended].some((r) => r.status === 'rejected')) emit({ type: 'close_failed' });
    process.removeListener('SIGTERM', onStop);
    process.removeListener('SIGINT', onStop);
  }
}

async function main(options) {
  const began = performance.now();
  const branches = options.quick ? 2 : 10,
    ordersPerBranch = options.quick ? 3 : 100;
  const nonce = randomUUID().replaceAll('-', '');
  const schemas = {
    cloud: `ftcap_${nonce}_cloud`,
    edges: Array.from({ length: branches }, (_, i) => `ftcap_${nonce}_edge_${i}`),
  };
  const urls = {
    cloud: checkedUrl(
      process.env.TRANSPORT_CAPACITY_CLOUD_DATABASE_URL ?? defaults.cloud,
      'cloud',
    ).toString(),
    edge: checkedUrl(
      process.env.TRANSPORT_CAPACITY_EDGE_DATABASE_URL ?? defaults.edge,
      'edge',
    ).toString(),
  };
  const report = {
    schema_version: 1,
    scenario: options.quick ? 'transport_quick_diagnostic' : 'transport_multibranch_baseline',
    status: 'running',
    started_at: new Date().toISOString(),
    production_capacity_proven: false,
    parameters: {
      branches,
      orders_per_branch: ordersPerBranch,
      total_active_orders: branches * ordersPerBranch,
      cloud_schemas: 1,
      cloud_api_processes: 1,
      edge_schemas: branches,
      lan_services: branches,
      simultaneous_branch_workers: branches,
      page_limit: 37,
      max_runtime_seconds: 600,
      max_cloud_connections: 13,
      max_edge_connections: 1 + branches * 4,
    },
    machine: {
      platform: platform(),
      architecture: arch(),
      cpu_model: cpus()[0]?.model,
      logical_cpus: cpus().length,
      memory_total_bytes: totalmem(),
      node: process.version,
    },
    cleanup: { created: [], dropped: [], verified_absent: false },
    limitations: [
      'Local shared Mac/Docker, one process for API/LAN/workers; no production or physical SLO claim.',
      '1000 simultaneously active orders, not 1000 HTTP requests or new orders per second; no new identity population.',
      'Synthetic trusted foundation quotes/payment/fiscal observations; no public checkout, bank, SMS, KKM, refunds or stock.',
      'No WAN outage, disk recovery, Redis, browser rendering, soak, 20-branch skew or credential-rotation load in this run.',
      'Observed cloud task deltas are compared only for started tasks; never claimed as a full kitchen projection.',
      'HTTP latency samples end at response headers; phase duration includes full body consumption and database work.',
    ],
  };
  const admins = {},
    owned = [];
  let child,
    childResult,
    interrupted = false,
    timer,
    killTimer;
  const stop = () => {
    interrupted = true;
    child?.kill('SIGTERM');
    killTimer ??= setTimeout(() => child?.kill('SIGKILL'), 3000);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    report.source = await sourceProof();
    const proof = await dockerProof();
    const { createPool } = await import('../../packages/database/dist/index.js');
    report.database = {};
    for (const kind of ['cloud', 'edge']) {
      if (interrupted) throw new HarnessError('INTERRUPTED');
      const admin = createPool(urls[kind], 1);
      admins[kind] = admin;
      const identity = (
        await admin.query('SELECT system_identifier::text FROM pg_control_system()')
      ).rows[0];
      assert.equal(identity.system_identifier, proof[kind].systemId);
      const limits = (
        await admin.query(`SELECT current_setting('max_connections')::int max,
        current_setting('superuser_reserved_connections')::int reserved,
        (SELECT count(*)::int FROM pg_stat_activity WHERE backend_type='client backend') used`)
      ).rows[0];
      const planned = kind === 'cloud' ? 12 : branches * 4;
      if (limits.max - limits.reserved - limits.used < planned + 8)
        throw new HarnessError('INSUFFICIENT_CONNECTION_HEADROOM');
      report.database[kind] = {
        image: proof[kind].image,
        local_docker_identity_match: true,
        max_connections: limits.max,
        other_connections_at_preflight: limits.used - 1,
        planned_child_max_connections: planned,
        version: (await admin.query('SELECT version()')).rows[0].version,
      };
      for (const name of kind === 'cloud' ? [schemas.cloud] : schemas.edges) {
        if (interrupted || performance.now() - began > MAX_RUN_MS)
          throw new HarnessError('RUN_TIME_LIMIT');
        checkedSchema(name);
        assert.equal(
          (await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [name])).rowCount,
          0,
        );
        // Track the unique, verified-absent namespace before CREATE: even a lost
        // CREATE response is cleaned by the supervisor, never another schema.
        owned.push({ kind, name });
        await admin.query(`CREATE SCHEMA ${name}`);
        report.cleanup.created.push(name);
      }
    }
    child = fork(file, ['--child'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    report.child_stderr_bytes = 0;
    child.stderr.on('data', (data) => {
      report.child_stderr_bytes += data.byteLength;
    });
    child.on('message', (message) => {
      if (message?.type === 'phase') console.error(JSON.stringify(message));
      else if (message?.type === 'result') childResult = message.result;
      else if (message?.type === 'close_failed') report.child_close_failed = true;
    });
    const exit = new Promise((resolveExit, reject) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
      child.once('error', reject);
    });
    timer = setTimeout(stop, Math.max(1, MAX_RUN_MS - (performance.now() - began)));
    child.send({ schemas, urls, ordersPerBranch });
    report.child_exit = await exit;
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (interrupted) throw new HarnessError('INTERRUPTED_OR_TIME_LIMIT');
    if (report.child_exit.code !== 0 || !childResult) throw new HarnessError('CHILD_FAILED');
    report.result = childResult;
    report.status = childResult.status;
    if (report.child_close_failed) report.status = 'failed';
  } catch (error) {
    report.status = 'failed';
    report.error_code = safeCode(error);
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
    // Only this run's verified-absent random names; no containers/volumes/default
    // schemas are deleted. Child death closes every workload connection first.
    const cleanupErrors = [];
    await Promise.all(
      ['cloud', 'edge'].map(async (kind) => {
        const admin = admins[kind];
        if (!admin) return;
        for (const { name } of owned.filter((o) => o.kind === kind).reverse()) {
          try {
            await admin.query(`DROP SCHEMA IF EXISTS ${checkedSchema(name)} CASCADE`);
            assert.equal(
              (await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [name])).rowCount,
              0,
            );
            report.cleanup.dropped.push(name);
          } catch (error) {
            cleanupErrors.push({ schema: name, code: safeCode(error) });
          }
        }
        await admin.end();
      }),
    );
    report.cleanup.verified_absent =
      owned.length > 0 && report.cleanup.dropped.length === owned.length;
    if (cleanupErrors.length) {
      report.cleanup.errors = cleanupErrors;
      report.status = 'failed';
    }
    report.duration_seconds = round((performance.now() - began) / 1000);
    report.finished_at = new Date().toISOString();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (options.output) {
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'passed') process.exitCode = 1;
  }
}

if (process.argv[2] === '--child') {
  if (!process.send) throw new HarnessError('SUPERVISOR_REQUIRED');
  process.once('message', async (config) => {
    try {
      await childRun(config);
      process.disconnect();
    } catch (e) {
      emit({ type: 'result', result: { status: 'failed', errors: { [safeCode(e)]: 1 } } });
      process.disconnect();
      process.exitCode = 1;
    }
  });
} else {
  try {
    const options = parseArgs(process.argv.slice(2), root);
    if (options.selfTest) {
      await import('./fulfillment-capacity.test.mjs');
    } else await main(options);
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error_code: safeCode(error) }));
    process.exitCode = 1;
  }
}
