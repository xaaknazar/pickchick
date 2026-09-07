/** Local-only measurements of current PostgreSQL identity queries and CommerceRepository.
 * No HTTP, customer auth, decryption, bank/KKM adapter, edge delivery or kitchen is started.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, dirname } from 'node:path';
import { cpus, totalmem, freemem, loadavg, platform, arch, release } from 'node:os';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createPool, migrate } from '../../packages/database/dist/index.js';
import { CommerceRepository, digest } from '../../packages/commerce-core/dist/index.js';
import { fixtureMenu } from '../../packages/test-fixtures/dist/index.js';
const runFile = promisify(execFile),
  root = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_URL =
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
const round = (n) => Math.round(n * 1000) / 1000;
class HarnessError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function checkedUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HarnessError('UNSAFE_DATABASE_URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55432' ||
    url.pathname !== '/pickchick_cloud' ||
    url.username !== 'pickchick_local' ||
    !url.password ||
    url.search ||
    url.hash
  )
    throw new HarnessError('UNSAFE_DATABASE_URL');
  return url;
}
function parseArgs(argv) {
  const options = { quick: false, selfTest: false, concurrency: 16, output: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quick') options.quick = true;
    else if (a === '--self-test') options.selfTest = true;
    else if (a === '--concurrency') {
      options.concurrency = Number(argv[++i]);
      if (
        !Number.isInteger(options.concurrency) ||
        options.concurrency < 1 ||
        options.concurrency > 32
      )
        throw new HarnessError('INVALID_CONCURRENCY');
    } else if (a === '--output') {
      const path = argv[++i];
      if (!path) throw new HarnessError('INVALID_OUTPUT');
      const full = resolve(root, path),
        rel = relative(root, full);
      if (!/^(tests\/load\/results|\.local\/capacity)\/[a-zA-Z0-9._-]+\.json$/.test(rel))
        throw new HarnessError('INVALID_OUTPUT');
      options.output = full;
    } else throw new HarnessError('INVALID_ARGUMENT');
  }
  return options;
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
const lookup = (n) =>
  createHash('md5').update(`capacity-lookup-a:${n}`).digest('hex') +
  createHash('md5').update(`capacity-lookup-b:${n}`).digest('hex');
function summary(values, errors, seconds) {
  const sorted = [...values].sort((a, b) => a - b),
    p = (n) => (sorted.length ? round(sorted[Math.ceil(sorted.length * n) - 1]) : null);
  return {
    operations: sorted.length,
    errors,
    seconds: round(seconds),
    operations_per_second: seconds > 0 ? round(sorted.length / seconds) : null,
    p50_ms: p(0.5),
    p95_ms: p(0.95),
    p99_ms: p(0.99),
    max_ms: sorted.length ? round(sorted.at(-1)) : null,
  };
}
async function command(binary, args) {
  try {
    return (
      await runFile(binary, args, { cwd: root, timeout: 15000, maxBuffer: 1048576 })
    ).stdout.trim();
  } catch {
    throw new HarnessError('LOCAL_TOOL_FAILED');
  }
}
async function dockerProof() {
  if (process.env.DOCKER_HOST && !/^(unix:\/\/|npipe:\/\/)/.test(process.env.DOCKER_HOST))
    throw new HarnessError('REMOTE_DOCKER_FORBIDDEN');
  const context = await command('docker', ['context', 'show']);
  const endpoint = JSON.parse(
    await command('docker', [
      'context',
      'inspect',
      context,
      '--format',
      '{{json .Endpoints.docker.Host}}',
    ]),
  );
  if (!/^(unix:\/\/|npipe:\/\/)/.test(endpoint)) throw new HarnessError('REMOTE_DOCKER_FORBIDDEN');
  const ids = (
    await command('docker', [
      'ps',
      '--filter',
      'label=com.docker.compose.project=pickchick-local',
      '--filter',
      'label=com.docker.compose.service=cloud-db',
      '--format',
      '{{.ID}}',
    ])
  )
    .split('\n')
    .filter(Boolean);
  if (ids.length !== 1 || !/^[a-f0-9]+$/.test(ids[0]))
    throw new HarnessError('LOCAL_COMPOSE_DATABASE_REQUIRED');
  const id = ids[0],
    ports = JSON.parse(
      await command('docker', ['inspect', id, '--format', '{{json .NetworkSettings.Ports}}']),
    );
  if (!ports['5432/tcp']?.some((p) => p.HostIp === '127.0.0.1' && p.HostPort === '55432'))
    throw new HarnessError('LOCAL_COMPOSE_BINDING_MISMATCH');
  const info = JSON.parse(
    await command('docker', [
      'info',
      '--format',
      '{"cpus":{{.NCPU}},"memory_bytes":{{.MemTotal}},"server_version":"{{.ServerVersion}}","storage_driver":"{{.Driver}}","operating_system":"{{.OperatingSystem}}"}',
    ]),
  );
  const container = JSON.parse(
    await command('docker', [
      'inspect',
      id,
      '--format',
      '{"image_reference":"{{.Config.Image}}","image_id":"{{.Image}}","memory_limit_bytes":{{.HostConfig.Memory}},"nano_cpus":{{.HostConfig.NanoCpus}},"cpu_quota":{{.HostConfig.CpuQuota}},"cpu_period":{{.HostConfig.CpuPeriod}}}',
    ]),
  );
  const controlId = await command('docker', [
    'exec',
    id,
    'psql',
    '-U',
    'pickchick_local',
    '-d',
    'pickchick_cloud',
    '-At',
    '-c',
    'SELECT system_identifier FROM pg_control_system()',
  ]);
  if (!/^\d+$/.test(controlId)) throw new HarnessError('LOCAL_CONTAINER_IDENTITY_UNAVAILABLE');
  const df = (await command('docker', ['exec', id, 'df', '-Pk', '/var/lib/postgresql']))
    .split('\n')
    .at(-1)
    .trim()
    .split(/\s+/);
  const freeBytes = Number(df[3]) * 1024;
  if (!Number.isFinite(freeBytes) || freeBytes < 2 * 1024 ** 3)
    throw new HarnessError('LOCAL_DOCKER_DISK_LOW');
  return {
    controlId,
    report: {
      context_transport: 'local socket',
      compose_project: 'pickchick-local',
      compose_service: 'cloud-db',
      host_binding: '127.0.0.1:55432',
      vm: info,
      container,
      disk_available_bytes_before: freeBytes,
    },
  };
}
async function sourceProof() {
  const paths = [
    'packages/database/src',
    'packages/commerce-core/src',
    'packages/test-fixtures/src',
    'packages/contracts/src',
    'db/cloud/migrations',
  ];
  const dirty = await command('git', ['status', '--porcelain', '--', ...paths]);
  if (dirty) throw new HarnessError('RUNTIME_SOURCE_DIRTY');
  const sourceCommit = await command('git', ['rev-parse', 'HEAD']);
  const listed = (await command('git', ['ls-files', ...paths])).split('\n').filter(Boolean);
  const sources = {};
  for (const path of listed) sources[path] = hash(await readFile(resolve(root, path)));
  const artifacts = {};
  for (const pkg of ['database', 'commerce-core', 'test-fixtures', 'contracts']) {
    for (const f of (await readdir(resolve(root, `packages/${pkg}/dist`)))
      .filter((n) => n.endsWith('.js'))
      .sort()) {
      const path = `packages/${pkg}/dist/${f}`;
      artifacts[path] = hash(await readFile(resolve(root, path)));
    }
  }
  return {
    runtime_source_commit: sourceCommit,
    runtime_source_tree_sha256: hash(JSON.stringify(sources)),
    runtime_source_files: sources,
    compiled_javascript: artifacts,
    harness_sha256: hash(await readFile(fileURLToPath(import.meta.url))),
  };
}
function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : error instanceof assert.AssertionError
      ? 'ASSERTION_FAILED'
      : 'HARNESS_ERROR';
}
async function selfTest() {
  assert.equal(checkedUrl(DEFAULT_URL).port, '55432');
  for (const invalid of [
    DEFAULT_URL.replace('127.0.0.1', '203.0.113.42'),
    DEFAULT_URL.replace('127.0.0.1', 'localhost'),
    DEFAULT_URL.replace('55432', '5432'),
    DEFAULT_URL.replace('pickchick_cloud', 'postgres'),
    DEFAULT_URL.replace('pickchick_local:', 'root:'),
    DEFAULT_URL + '?options=-c%20search_path=public',
    DEFAULT_URL + '#secret',
    'not-a-url',
  ])
    assert.throws(() => checkedUrl(invalid), { code: 'UNSAFE_DATABASE_URL' });
  assert.throws(() => parseArgs(['--concurrency', '1000']));
  assert.throws(() => parseArgs(['--output', '../../escape.json']));
  assert.deepEqual(summary([4, 1, 2, 3], 0, 1), {
    operations: 4,
    errors: 0,
    seconds: 1,
    operations_per_second: 4,
    p50_ms: 2,
    p95_ms: 4,
    p99_ms: 4,
    max_ms: 4,
  });
  assert.equal(new Set(Array.from({ length: 10000 }, (_, i) => lookup(i))).size, 10000);
  console.log(
    JSON.stringify({ self_test: 'passed', network_connections: 0, database_mutations: 0 }),
  );
}
async function main(options) {
  const report = {
    schema_version: 1,
    scenario: options.quick ? 'quick_synthetic_diagnostic' : 'local_market_core_baseline',
    started_at: new Date().toISOString(),
    status: 'running',
    production_capacity_proven: false,
    physical_kitchen_capacity_proven: false,
    external_provider_calls: 0,
    identity_auth_calls: 0,
    source: null,
    parameters: {
      identity_rows: options.quick ? 10000 : 1000000,
      orders: options.quick ? 20 : 1000,
      branches: options.quick ? 2 : 10,
      concurrency: options.concurrency,
      pool_max: options.concurrency,
      identity_lookup_samples: options.quick ? 1000 : 10000,
      identity_batch_size: 10000,
      duplicate_replays_per_command: 2,
    },
    machine: {
      platform: platform(),
      architecture: arch(),
      os_release: release(),
      cpu_model: cpus()[0]?.model ?? 'unknown',
      logical_cpus: cpus().length,
      memory_total_bytes: totalmem(),
      memory_free_bytes_before: freemem(),
      load_average_before: loadavg(),
      node: process.version,
    },
    docker: null,
    postgres: null,
    metrics: {},
    assertions: {},
    cleanup: {
      schema_created: false,
      drop_attempted: false,
      dropped: false,
      verified_absent: false,
    },
    limits: [
      'Local single run; not a production acceptance or RPS guarantee.',
      'Identity bulk rows are not registrations: no valid phone, encryption, OTP, consent or session lifecycle is exercised.',
      'Internal trusted commerce fixtures bypass HTTP/auth/pricing bridge and external providers.',
      'Outbox rows remain undelivered; no cloud-edge bridge, physical KDS, queue capacity, stock, bonus ledger, Redis, WAN, failover or soak is exercised.',
      'Seeded data and measurements share warm PostgreSQL/OS caches; no cold-cache claim.',
      'Other workloads on this developer host/Docker VM may influence timings.',
    ],
  };
  const url = checkedUrl(process.env.CAPACITY_DATABASE_URL ?? DEFAULT_URL);
  let admin,
    pool,
    schema,
    stage = 'preflight',
    interrupted = false;
  const start = performance.now(),
    histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const signal = () => {
    interrupted = true;
  };
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);
  const checkStop = () => {
    if (interrupted) throw new HarnessError('INTERRUPTED');
    if (performance.now() - start > 600000) throw new HarnessError('RUN_TIME_LIMIT');
  };
  async function measure(name, items, operation) {
    checkStop();
    stage = name;
    const values = [],
      errorCodes = {};
    let next = 0,
      active = 0,
      peak = 0;
    const began = performance.now();
    let stopped = false;
    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, items.length) }, async () => {
        while (!stopped && next < items.length) {
          let item;
          try {
            checkStop();
            item = items[next++];
          } catch (error) {
            errorCodes[safeCode(error)] = (errorCodes[safeCode(error)] ?? 0) + 1;
            stopped = true;
            break;
          }
          const beganOp = performance.now();
          active++;
          peak = Math.max(peak, active);
          try {
            await operation(item);
          } catch (error) {
            const code = safeCode(error);
            errorCodes[code] = (errorCodes[code] ?? 0) + 1;
            stopped = true;
          } finally {
            active--;
            values.push(performance.now() - beganOp);
          }
        }
      }),
    );
    const errors = Object.values(errorCodes).reduce((sum, n) => sum + n, 0);
    report.metrics[name] = {
      ...summary(values, errors, (performance.now() - began) / 1000),
      scheduled: next,
      requested: items.length,
      peak_active: peak,
      error_codes: errorCodes,
    };
    console.error(
      JSON.stringify({
        phase: name,
        operations: values.length,
        errors,
        seconds: report.metrics[name].seconds,
      }),
    );
    if (errors) throw new HarnessError('MEASURE_ERRORS');
    assert.equal(next, items.length);
  }
  try {
    report.source = await sourceProof();
    const docker = await dockerProof();
    report.docker = docker.report;
    admin = createPool(url.toString(), 2);
    const control = (await admin.query('SELECT system_identifier::text FROM pg_control_system()'))
      .rows[0].system_identifier;
    if (control !== docker.controlId) throw new HarnessError('LOCAL_CONTAINER_DATABASE_MISMATCH');
    report.assertions.local_docker_identity_match = true;
    const identity = (
      await admin.query(
        'SELECT current_database() db,current_user AS role,version() version,pg_postmaster_start_time() started',
      )
    ).rows[0];
    assert.equal(identity.db, 'pickchick_cloud');
    assert.equal(identity.role, 'pickchick_local');
    const settings = (
      await admin.query(
        'SELECT name,setting,unit,source FROM pg_settings WHERE name=ANY($1) ORDER BY name',
        [
          [
            'server_version_num',
            'shared_buffers',
            'effective_cache_size',
            'work_mem',
            'maintenance_work_mem',
            'max_connections',
            'fsync',
            'synchronous_commit',
            'full_page_writes',
            'wal_level',
            'max_wal_size',
            'checkpoint_timeout',
            'random_page_cost',
            'effective_io_concurrency',
            'max_parallel_workers_per_gather',
            'jit',
            'track_io_timing',
          ],
        ],
      )
    ).rows;
    report.postgres = {
      version: identity.version,
      started_at: identity.started,
      settings,
      other_client_backends_before: Number(
        (
          await admin.query(
            "SELECT count(*) count FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()",
          )
        ).rows[0].count,
      ),
    };
    stage = 'temporary_schema';
    schema = 'capacity_' + randomUUID().replaceAll('-', '');
    report.cleanup.schema = schema;
    await admin.query(`CREATE SCHEMA ${schema}`);
    report.cleanup.schema_created = true;
    const scoped = new URL(url);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(scoped.toString(), options.concurrency);
    assert.deepEqual(
      (await pool.query('SELECT current_schemas(false)::text[] schemas')).rows[0].schemas,
      [schema],
    );
    report.assertions.only_temporary_search_path = true;
    report.migrations = await migrate(pool, resolve(root, 'db/cloud/migrations'), 'cloud');
    report.postgres.session = (
      await pool.query(
        "SELECT current_setting('statement_timeout') statement_timeout,current_setting('application_name') application_name,current_setting('search_path') search_path",
      )
    ).rows[0];
    stage = 'identity_seed';
    const seedStart = performance.now();
    for (
      let begin = 1;
      begin <= report.parameters.identity_rows;
      begin += report.parameters.identity_batch_size
    ) {
      checkStop();
      const end = Math.min(
        report.parameters.identity_rows,
        begin + report.parameters.identity_batch_size - 1,
      );
      await pool.query(
        `INSERT INTO identity_customers(id,phone_lookup,phone_cipher,profile_cipher,created_at)
 SELECT gen_random_uuid(),md5('capacity-lookup-a:'||i)||md5('capacity-lookup-b:'||i),
 'SYNTHETIC_INVALID_CIPHER:'||substr(md5('phone-a:'||i)||md5('phone-b:'||i),1,64-length('SYNTHETIC_INVALID_CIPHER:')),
 'SYNTHETIC_INVALID_CIPHER:'||substr(repeat(md5('profile:'||i),8),1,256-length('SYNTHETIC_INVALID_CIPHER:')),clock_timestamp()
 FROM generate_series($1::integer,$2::integer) AS i`,
        [begin, end],
      );
    }
    report.identity = {
      insert_seconds: round((performance.now() - seedStart) / 1000),
      rows: Number(
        (await pool.query('SELECT count(*) count FROM identity_customers')).rows[0].count,
      ),
      opaque_phone_bytes: 64,
      opaque_profile_bytes: 256,
      lookup_generation:
        'two MD5 digests over synthetic ordinal labels; unique constraint and distinct count verified; not a phone HMAC',
      opaque_payload:
        'SYNTHETIC_INVALID_CIPHER prefix, intentionally not decryptable and never passed to auth',
    };
    assert.equal(report.identity.rows, report.parameters.identity_rows);
    assert.equal(
      Number(
        (await pool.query('SELECT count(DISTINCT phone_lookup) count FROM identity_customers'))
          .rows[0].count,
      ),
      report.parameters.identity_rows,
    );
    report.assertions.identity_unique_rows = report.parameters.identity_rows;
    await pool.query('ANALYZE identity_customers');
    report.identity.sizes = (
      await pool.query(
        "SELECT pg_relation_size('identity_customers')::text heap_bytes,pg_table_size('identity_customers')::text table_bytes,pg_indexes_size('identity_customers')::text indexes_bytes,pg_total_relation_size('identity_customers')::text total_bytes",
      )
    ).rows[0];
    report.identity.indexes = (
      await pool.query(
        "SELECT indexrelname,pg_relation_size(indexrelid)::text bytes FROM pg_stat_user_indexes WHERE schemaname=current_schema() AND relname='identity_customers' ORDER BY indexrelname",
      )
    ).rows;
    assert.equal(report.identity.indexes.length, 2);
    assert.equal(
      report.identity.indexes.reduce((n, v) => n + BigInt(v.bytes), 0n).toString(),
      report.identity.sizes.indexes_bytes,
    );
    const opaqueSizes = (
      await pool.query(
        'SELECT min(octet_length(phone_cipher)) phone_min,max(octet_length(phone_cipher)) phone_max,min(octet_length(profile_cipher)) profile_min,max(octet_length(profile_cipher)) profile_max FROM identity_customers',
      )
    ).rows[0];
    assert.deepEqual(opaqueSizes, {
      phone_min: 64,
      phone_max: 64,
      profile_min: 256,
      profile_max: 256,
    });
    report.identity.opaque_payload_sizes_verified = true;
    const sample = lookup(Math.floor(report.parameters.identity_rows / 2));
    for (const [key, sql] of [
      ['lookup', 'SELECT * FROM identity_customers WHERE phone_lookup=$1'],
      ['lookup_for_update', 'SELECT * FROM identity_customers WHERE phone_lookup=$1 FOR UPDATE'],
    ]) {
      const plan = (await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, [sample]))
        .rows[0]['QUERY PLAN'];
      report.identity[key + '_plan'] = JSON.parse(
        JSON.stringify(plan).replaceAll(sample, 'SYNTHETIC_LOOKUP_REDACTED'),
      );
      const hasIndex = (node) =>
        node['Index Name'] === 'identity_customers_phone_lookup_key' ||
        (node.Plans ?? []).some(hasIndex);
      assert.equal(hasIndex(plan[0].Plan), true);
    }
    report.assertions.lookup_uses_unique_index = true;
    const lookupJobs = Array.from({ length: report.parameters.identity_lookup_samples }, (_, i) => {
      const hit = i % 10 !== 0,
        n = hit
          ? ((i * 104729) % report.parameters.identity_rows) + 1
          : report.parameters.identity_rows + i + 1;
      return { value: lookup(n), hit };
    });
    for (const job of lookupJobs.slice(0, 100))
      await pool.query('SELECT * FROM identity_customers WHERE phone_lookup=$1', [job.value]);
    for (const [name, suffix] of [
      ['identity_lookup', ''],
      ['identity_lookup_for_update', ' FOR UPDATE'],
    ])
      await measure(name, lookupJobs, async (job) => {
        const rows = (
          await pool.query('SELECT * FROM identity_customers WHERE phone_lookup=$1' + suffix, [
            job.value,
          ])
        ).rows;
        assert.equal(rows.length, job.hit ? 1 : 0);
        if (job.hit)
          assert.equal(rows[0].phone_cipher.startsWith('SYNTHETIC_INVALID_CIPHER:'), true);
      });
    report.identity.lookup_mix = {
      expected_hits: lookupJobs.filter((j) => j.hit).length,
      expected_misses: lookupJobs.filter((j) => !j.hit).length,
      warmup_queries_excluded: 100,
      for_update_uses_autocommit: true,
    };
    stage = 'commerce_setup';
    const org = randomUUID(),
      legal = randomUUID();
    await pool.query(
      "INSERT INTO organizations(id,name) VALUES($1,'CAPACITY SYNTHETIC — NOT A RESTAURANT')",
      [org],
    );
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'CAPACITY SYNTHETIC','000000000000')",
      [legal, org],
    );
    const branches = [];
    for (let i = 0; i < report.parameters.branches; i++) {
      const branch = randomUUID(),
        device = randomUUID(),
        releaseId = randomUUID(),
        payment = randomUUID(),
        fiscal = randomUUID();
      await pool.query(
        "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,$4,'CAPACITY SYNTHETIC')",
        [branch, org, legal, `CAPACITY-${i + 1}`],
      );
      await pool.query(
        "INSERT INTO devices(id,branch_id,organization_id,kind,name,status) VALUES($1,$2,$3,'edge','CAPACITY SYNTHETIC','active')",
        [device, branch, org],
      );
      const menu = { ...fixtureMenu, branch_id: branch, release_id: releaseId };
      await pool.query(
        'INSERT INTO menu_releases(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,1,1,$3,$4,clock_timestamp())',
        [releaseId, branch, menu, digest(menu)],
      );
      for (const [id, kind] of [
        [payment, 'payment'],
        [fiscal, 'fiscal'],
      ])
        await pool.query(
          "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1,$2,$3,$4,'synthetic-capacity',$5,true,$6)",
          [id, org, branch, kind, `synthetic-capacity:${id}`, legal],
        );
      branches.push({
        index: i + 1,
        branch,
        releaseId,
        payment,
        fiscal,
        edge: { organizationId: org, branchId: branch, deviceId: device },
        provider: { organizationId: org, branchId: branch, accountId: payment },
        fiscalProvider: { organizationId: org, branchId: branch, accountId: fiscal },
      });
    }
    const customers = (
      await pool.query('SELECT id FROM identity_customers ORDER BY phone_lookup LIMIT $1', [
        report.parameters.orders,
      ])
    ).rows;
    const item = fixtureMenu.items[0],
      orders = Array.from({ length: report.parameters.orders }, (_, i) => {
        const b = branches[i % branches.length];
        return {
          index: i,
          cohort: Math.floor(i / branches.length) % 10,
          b,
          scope: {
            organizationId: org,
            branchId: b.branch,
            principalId: randomUUID(),
            role: 'sales',
          },
          quoteKey: randomUUID(),
          orderKey: randomUUID(),
          attemptKey: randomUUID(),
          priced: {
            releaseId: b.releaseId,
            customerId: customers[i].id,
            channel: 'mobile',
            serviceMode: i % 2 ? 'takeaway' : 'dine_in',
            currency: 'KZT',
            ttlSeconds: 900,
            lines: [
              {
                lineId: randomUUID(),
                productId: item.product_id,
                title: 'CAPACITY SYNTHETIC ITEM — NOT A SALE',
                quantity: 1,
                unitPriceMinor: item.price_minor,
                discountMinor: '0',
                taxCode: 'SYNTHETIC',
              },
            ],
          },
        };
      });
    const twice = (items) => items.flatMap((item) => [item, item]),
      repo = new CommerceRepository(pool);
    await measure('issue_quote_with_replays', twice(orders), async (o) => {
      const result = await repo.issueQuote(o.scope, o.quoteKey, o.priced);
      if (o.quote) assert.deepEqual(o.quote, result);
      else o.quote = result;
    });
    await measure('create_order_with_replays', twice(orders), async (o) => {
      const result = await repo.createOrder(o.scope, o.orderKey, {
        quoteId: o.quote.quoteId,
        fiscalAccountId: o.b.fiscal,
      });
      if (o.order) assert.deepEqual(o.order, result);
      else o.order = result;
    });
    for (const o of orders)
      o.admission = {
        eventId: randomUUID(),
        orderId: o.order.orderId,
        reservationId: randomUUID(),
        quoteDigest: o.quote.digest,
      };
    await measure('confirm_admission_with_replays', twice(orders), (o) =>
      repo.confirmAdmission(o.b.edge, o.admission),
    );
    await measure('start_payment_with_replays', twice(orders), async (o) => {
      const result = await repo.startPaymentAttempt(o.scope, o.attemptKey, {
        orderId: o.order.orderId,
        providerAccountId: o.b.payment,
      });
      if (o.attempt) assert.deepEqual(o.attempt, result);
      else o.attempt = result;
    });
    report.commerce = {
      simultaneously_resident_before_observations: (
        await pool.query(
          'SELECT o.state,p.state payment_state,count(*)::integer count FROM commerce_orders o JOIN commerce_payment_intents p ON p.order_id=o.id GROUP BY o.state,p.state',
        )
      ).rows,
    };
    assert.deepEqual(report.commerce.simultaneously_resident_before_observations, [
      { state: 'awaiting_payment', payment_state: 'pending', count: report.parameters.orders },
    ]);
    for (const o of orders) {
      const outcome = o.cohort === 0 ? 'unknown' : o.cohort === 1 ? 'failed' : 'captured';
      o.paymentEvent = {
        eventId: randomUUID(),
        attemptId: o.attempt.attemptId,
        outcome,
        occurredAt: new Date().toISOString(),
        ...(outcome === 'captured'
          ? { operationId: randomUUID(), amountMinor: o.attempt.amountMinor }
          : {}),
      };
    }
    assert.equal(
      orders.filter((o) => o.paymentEvent.outcome === 'captured').length,
      orders.length * 0.8,
    );
    assert.equal(
      orders.filter((o) => o.paymentEvent.outcome === 'unknown').length,
      orders.length * 0.1,
    );
    assert.equal(
      orders.filter((o) => o.paymentEvent.outcome === 'failed').length,
      orders.length * 0.1,
    );
    await measure('observe_payment_with_replays', twice(orders), (o) =>
      repo.observePayment(o.b.provider, o.paymentEvent),
    );
    const captured = orders.filter((o) => o.paymentEvent.outcome === 'captured');
    await measure('same_capture_new_event_id', captured, (o) =>
      repo.observePayment(o.b.provider, { ...o.paymentEvent, eventId: randomUUID() }),
    );
    await measure('read_order_after_payment', orders, async (o) => {
      o.view = await repo.readOrder(o.scope, o.order.orderId);
      assert.equal(o.view.attempts.length, 1);
      assert.equal(
        o.view.money.captured,
        o.paymentEvent.outcome === 'captured' ? o.attempt.amountMinor : '0',
      );
      assert.equal(o.view.kitchenEffectId, null);
    });
    const issued = orders.filter((o) => o.cohort >= 4);
    assert.equal(issued.length, orders.length * 0.6);
    for (const o of issued)
      o.fiscalEvent = {
        eventId: randomUUID(),
        documentId: o.view.fiscalDocuments[0].id,
        outcome: 'issued',
        providerDocumentId: randomUUID(),
        fiscalMark: 'CAPACITY-SYNTHETIC-NOT-A-RECEIPT',
        receiptUrl: 'https://example.invalid/capacity-synthetic',
        amountMinor: o.attempt.amountMinor,
        occurredAt: new Date().toISOString(),
      };
    await measure('observe_fiscal_with_replays', twice(issued), (o) =>
      repo.observeFiscal(o.b.fiscalProvider, o.fiscalEvent),
    );
    await measure('read_final_order', orders, async (o) => {
      const view = await repo.readOrder(o.scope, o.order.orderId);
      assert.equal(view.attempts.length, 1);
      assert.equal(view.captures.length, o.paymentEvent.outcome === 'captured' ? 1 : 0);
      assert.equal(view.attentionRequired, false);
      assert.equal(Boolean(view.kitchenEffectId), o.cohort >= 4);
      assert.equal(view.money.refunded, '0');
      assert.equal(view.money.reserved, '0');
    });
    await measure('cross_branch_reads_rejected', branches, async (b) => {
      const o = orders[b.index - 1],
        wrong = branches[b.index % branches.length];
      await assert.rejects(
        repo.readOrder({ ...o.scope, branchId: wrong.branch }, o.order.orderId),
        { code: 'NOT_FOUND' },
      );
    });
    stage = 'assertions';
    const tables = [
      'commerce_quotes',
      'commerce_orders',
      'commerce_payment_intents',
      'commerce_payment_attempts',
      'commerce_captures',
      'commerce_fiscal_documents',
      'commerce_edge_inbox',
      'commerce_provider_inbox',
      'commerce_commands',
      'commerce_outbox',
      'commerce_reconciliation_issues',
      'identity_sessions',
      'identity_otp_challenges',
    ];
    report.commerce.row_counts = {};
    for (const table of tables)
      report.commerce.row_counts[table] = Number(
        (await pool.query(`SELECT count(*) count FROM ${table}`)).rows[0].count,
      );
    const count = report.commerce.row_counts,
      n = orders.length;
    for (const table of [
      'commerce_quotes',
      'commerce_orders',
      'commerce_payment_intents',
      'commerce_payment_attempts',
      'commerce_edge_inbox',
    ])
      assert.equal(count[table], n);
    assert.equal(count.commerce_captures, captured.length);
    assert.equal(count.commerce_fiscal_documents, captured.length);
    assert.equal(count.commerce_commands, n * 3);
    assert.equal(count.commerce_provider_inbox, n + captured.length + issued.length);
    assert.equal(count.identity_sessions, 0);
    assert.equal(count.identity_otp_challenges, 0);
    assert.equal(count.commerce_reconciliation_issues, 0);
    report.commerce.outbox = (
      await pool.query(
        'SELECT event_type,count(*)::integer count FROM commerce_outbox GROUP BY event_type ORDER BY event_type',
      )
    ).rows;
    const expected = {
      'edge.admission_requested': n,
      'payment.submit_requested': n,
      'fiscal.submit_requested': captured.length,
      'edge.kitchen_admission_requested': issued.length,
      'fiscal.issued': issued.length,
      'payment.capture_recorded': captured.length,
      'payment.reconcile_requested': orders.filter((o) => o.paymentEvent.outcome === 'unknown')
        .length,
    };
    assert.deepEqual(
      Object.fromEntries(report.commerce.outbox.map((r) => [r.event_type, r.count])),
      expected,
    );
    assert.equal(
      count.commerce_outbox,
      Object.values(expected).reduce((sum, v) => sum + v, 0),
    );
    assert.equal(
      Number(
        (
          await pool.query(
            'SELECT count(*) count FROM (SELECT order_id,effect_key FROM commerce_outbox GROUP BY order_id,effect_key HAVING count(*)>1) duplicates',
          )
        ).rows[0].count,
      ),
      0,
    );
    assert.equal(
      Number(
        (
          await pool.query(
            'SELECT count(*) count FROM commerce_outbox WHERE acknowledged_at IS NOT NULL',
          )
        ).rows[0].count,
      ),
      0,
    );
    report.commerce.per_branch = (
      await pool.query(
        'SELECT b.code,o.state,p.state payment_state,count(*)::integer count FROM commerce_orders o JOIN branches b ON b.id=o.branch_id JOIN commerce_payment_intents p ON p.order_id=o.id GROUP BY b.code,o.state,p.state ORDER BY b.code,o.state,p.state',
      )
    ).rows;
    const branchTotals = {};
    for (const r of report.commerce.per_branch)
      branchTotals[r.code] = (branchTotals[r.code] ?? 0) + r.count;
    assert.equal(Object.keys(branchTotals).length, report.parameters.branches);
    assert.ok(Object.values(branchTotals).every((v) => v === n / report.parameters.branches));
    report.commerce.totals = (
      await pool.query(
        'SELECT (SELECT sum(total_minor)::text FROM commerce_orders) intended_minor,(SELECT sum(amount_minor)::text FROM commerce_captures) captured_minor',
      )
    ).rows[0];
    assert.equal(
      report.commerce.totals.intended_minor,
      (BigInt(item.price_minor) * BigInt(n)).toString(),
    );
    assert.equal(
      report.commerce.totals.captured_minor,
      (BigInt(item.price_minor) * BigInt(captured.length)).toString(),
    );
    report.assertions = {
      ...report.assertions,
      unique_orders: n,
      one_intent_attempt_per_order: true,
      duplicate_commands_no_extra_rows: true,
      same_operation_new_event_no_extra_capture: true,
      unique_expected_outbox_effects: true,
      all_outbox_undelivered: true,
      zero_auth_sessions_and_challenges: true,
      zero_external_calls: true,
      exact_minor_totals: true,
      cross_branch_order_reads_rejected: true,
      balanced_branch_residency_verified: true,
    };
    report.commerce.sizes = (
      await pool.query(
        "SELECT relname,pg_table_size(relid)::text table_bytes,pg_indexes_size(relid)::text indexes_bytes,pg_total_relation_size(relid)::text total_bytes FROM pg_stat_user_tables WHERE schemaname=current_schema() AND relname LIKE 'commerce_%' ORDER BY relname",
      )
    ).rows;
    report.postgres.pool_after = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
    assert.equal(pool.waitingCount, 0);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failure = { stage, code: safeCode(error) };
    process.exitCode = 1;
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        report.status = 'failed';
        report.cleanup.pool_close_failed = true;
        process.exitCode = 1;
      }
    }
    if (admin) {
      if (report.cleanup.schema_created) {
        report.cleanup.drop_attempted = true;
        try {
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
          report.cleanup.dropped = true;
          report.cleanup.verified_absent =
            (await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]))
              .rowCount === 0;
          if (!report.cleanup.verified_absent) {
            report.status = 'failed';
            report.cleanup.failure = 'CLEANUP_NOT_VERIFIED';
            process.exitCode = 1;
          }
        } catch {
          report.status = 'failed';
          report.cleanup.failure = 'CLEANUP_FAILED';
          process.exitCode = 1;
        }
      }
      await admin.end();
    }
    process.removeListener('SIGINT', signal);
    process.removeListener('SIGTERM', signal);
    histogram.disable();
    report.finished_at = new Date().toISOString();
    report.total_seconds = round((performance.now() - start) / 1000);
    report.machine.memory_free_bytes_after = freemem();
    report.machine.load_average_after = loadavg();
    report.process = {
      rss_bytes: process.memoryUsage().rss,
      max_rss_kib: process.resourceUsage().maxRSS,
      event_loop_p95_ms: round(histogram.percentile(95) / 1e6),
      event_loop_max_ms: round(histogram.max / 1e6),
    };
    const serialized = JSON.stringify(report, null, 2) + '\n';
    if (options.output) {
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, serialized, { flag: 'wx', mode: 0o600 });
    }
    console.log(serialized);
  }
}
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) await selfTest();
  else await main(options);
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      code: safeCode(error),
      raw_connection_and_driver_error_omitted: true,
    }),
  );
  process.exitCode = 1;
}
