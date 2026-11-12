import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  COMPOSE_FLAGS,
  PROVISION_KEYS,
  SUPPLY_COMPOSE,
  composeCandidate,
  composeExpenses,
  composeFlag,
  composeSupply,
} from '../../infra/staging/cutover-cloud-owner.mjs';

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const sha = (text) => createHash('sha256').update(text).digest('hex');
// Synthetic resolved release, never a copy of server credentials.
const installed = () => ({
  name: 'pickchick-staging',
  services: {
    api: {
      image: 'pickchick-api:' + 'a'.repeat(40),
      environment: {
        CLOUD_DATABASE_URL: 'postgresql://pickchick_app:synthetic@cloud-db:5432/pickchick_cloud',
        BACKOFFICE_ENABLED: 'true',
        CLOUD_POS_ORDER_SYNC_ENABLED: 'false',
        CUSTOMER_AUTH_ENABLED: 'true',
      },
      ports: [{ host_ip: '127.0.0.1', target: 3100, published: '13100' }],
      read_only: true,
      networks: { private: null, ingress: null },
    },
    'cloud-db': {
      image: 'postgres:18.3-alpine',
      volumes: [{ source: 'cloud-data', target: '/var/lib/postgresql' }],
    },
    'redis-cache': { image: 'redis:8.2.1-alpine', command: ['redis-server', '/config/redis.conf'] },
  },
  volumes: { 'cloud-data': { name: 'pickchick-staging_cloud-data' } },
  networks: { private: { internal: true }, ingress: { external: true } },
});
const call = (fn, text, ...args) => fn(text, sha(text), ...args);

test('historical YAML still keeps the owner flags, byte-preserving preparation and flag rollback', () => {
  const before =
    'services:\n  api:\n    environment:\n      CLOUD_DATABASE_URL: postgresql://pickchick_app:synthetic@cloud-db/pickchick_cloud\n  provision:\n    environment:\n      CLOUD_DATABASE_URL: postgresql://pickchick_owner:synthetic@cloud-db/pickchick_cloud\n';
  let text = call(composeCandidate, before);
  const lines = (keys) => keys.map((key) => `      ${key}: "false"\n`).join('');
  assert.equal(
    text.replace(lines(Object.values(COMPOSE_FLAGS)), '').replace(lines(PROVISION_KEYS), ''),
    before,
  );
  const candidate = text;
  text = call(composeSupply, text);
  assert.equal(
    text.replace(lines(Object.values(SUPPLY_COMPOSE).map(({ key }) => key)), ''),
    candidate,
  );
  const supply = text;
  text = call(composeExpenses, text);
  assert.equal(text.replace(lines(['BACKOFFICE_EXPENSES_ENABLED']), ''), supply);
  for (const flag of [...Object.keys(COMPOSE_FLAGS), 'expenses']) {
    const enabled = call(composeFlag, text, flag, true);
    assert.equal(call(composeFlag, enabled, flag, false), text);
  }
});
function chain(text = json(installed())) {
  const candidate = call(composeCandidate, text);
  const supply = call(composeSupply, candidate);
  return { candidate, supply, expenses: call(composeExpenses, supply) };
}

test('resolved server compose: ordered preparation preserves every unrelated value; expenses alone can be reverted', () => {
  const before = json(installed());
  const { candidate, supply, expenses } = chain(before);
  const steps = [
    [candidate, before, Object.values(COMPOSE_FLAGS)],
    [supply, candidate, Object.values(SUPPLY_COMPOSE).map(({ key }) => key)],
    [expenses, supply, ['BACKOFFICE_EXPENSES_ENABLED']],
  ];
  for (const [after, original, keys] of steps) {
    const data = JSON.parse(after);
    for (const key of keys) {
      assert.equal(data.services.api.environment[key], 'false');
      delete data.services.api.environment[key];
    }
    assert.equal(json(data), original);
    assert.equal(data.services.provision, undefined);
  }
  const enabled = call(composeFlag, expenses, 'expenses', true);
  const data = JSON.parse(enabled);
  assert.equal(data.services.api.environment.BACKOFFICE_EXPENSES_ENABLED, 'true');
  data.services.api.environment.BACKOFFICE_EXPENSES_ENABLED = 'false';
  assert.equal(json(data), expenses);
  assert.equal(call(composeFlag, enabled, 'expenses', false), expenses);
});

test('resolved compose refuses stale hashes, repeated preparation and out-of-order steps', () => {
  const before = json(installed());
  const { candidate, supply, expenses } = chain(before);
  assert.throws(() => composeCandidate(before, '0'.repeat(64)), /reviewed hash/);
  for (const [fn, input] of [
    [composeCandidate, candidate],
    [composeSupply, supply],
    [composeExpenses, expenses],
  ])
    assert.throws(() => call(fn, input), /already mentions/);
  for (const [fn, input] of [
    [composeSupply, before],
    [composeExpenses, before],
    [composeExpenses, candidate],
  ])
    assert.throws(() => call(fn, input), /Required resolved compose flag missing/);
  assert.throws(() => call(composeFlag, expenses, 'expenses', false), /expected state/);
  assert.throws(() => call(composeFlag, before, 'expenses', true), /expected state/);
  assert.throws(() => call(composeFlag, expenses, 'unrecognized', true), /Invalid flag/);
  assert.throws(() => composeFlag(expenses, '0'.repeat(64), 'expenses', true), /reviewed hash/);
});

test('second-wave dependencies cannot be enabled or disabled out of order in resolved JSON', () => {
  const { expenses } = chain();
  for (const [flag, { requires }] of Object.entries(SUPPLY_COMPOSE)) {
    assert.throws(() => call(composeFlag, expenses, flag, true), /must be enabled first/);
    const parent = call(composeFlag, expenses, requires, true);
    const enabled = call(composeFlag, parent, flag, true);
    assert.throws(() => call(composeFlag, enabled, requires, false), /must be disabled first/);
    const disabled = call(composeFlag, enabled, flag, false);
    assert.equal(call(composeFlag, disabled, requires, false), expenses);
  }
});

test('unrecognized services, privileged database URLs, noncanonical JSON and duplicate keys fail closed', () => {
  for (const mutate of [
    (d) => {
      d.services.provision = {};
    },
    (d) => {
      delete d.services['cloud-db'];
    },
    (d) => {
      d.services.api.environment = [];
    },
    (d) => {
      d.services.api.environment.CLOUD_DATABASE_URL =
        'postgresql://pickchick_owner:x@cloud-db/pickchick_cloud';
    },
    (d) => {
      d.services.api.environment.CLOUD_DATABASE_URL =
        'postgresql://pickchick_app:x@foreign/pickchick_cloud';
    },
    (d) => {
      d.services.api.environment.CLOUD_DATABASE_URL += '?options=bad';
    },
  ]) {
    const data = installed();
    mutate(data);
    assert.throws(() => call(composeCandidate, json(data)));
  }
  const before = json(installed());
  for (const input of [
    before.trim(),
    '{bad',
    before.replace(
      '"BACKOFFICE_ENABLED": "true",',
      '"BACKOFFICE_ENABLED": "false",\n        "BACKOFFICE_ENABLED": "true",',
    ),
  ])
    assert.throws(() => call(composeCandidate, input), /JSON/);
});

test('resolved compose CLI never prints configuration and refuses overwriting files or symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutover-compose-'));
  const input = join(dir, 'installed.json'),
    output = join(dir, 'candidate.json');
  const script = new URL('../../infra/staging/cutover-cloud-owner.mjs', import.meta.url);
  const before = json(installed());
  writeFileSync(input, before, { mode: 0o600 });
  const run = () =>
    spawnSync(
      process.execPath,
      [
        script.pathname,
        'compose-candidate',
        '--compose',
        input,
        '--sha256',
        sha(before),
        '--out',
        output,
      ],
      { encoding: 'utf8' },
    );
  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), {
      composeBefore: sha(before),
      composeAfter: sha(readFileSync(output)),
    });
    assert.doesNotMatch(first.stdout + first.stderr, /synthetic|postgresql/);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const saved = readFileSync(output, 'utf8');
    assert.equal(run().status, 1);
    assert.equal(readFileSync(output, 'utf8'), saved);
    rmSync(output);
    symlinkSync(input, output);
    assert.equal(run().status, 1);
    assert.equal(readFileSync(input, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
