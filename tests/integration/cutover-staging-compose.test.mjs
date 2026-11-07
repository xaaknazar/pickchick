// Cutover 19.11.2026, integration (CR bo-ui-1 section 2, CR bo-ui-5 section 1): the staging compose
// and .env.example carry the five back-office P1 flags of lane bo-ui, all off by default, in the
// api and provision services. The stock consumption worker is NOT in compose.yaml: it is the
// explicit opt-in overlay compose.stock-consumption.yaml (precedent compose.customer-auth.yaml),
// so the ordinary deploy never starts it and compose.yaml keeps exactly one API database line,
// which the guarded compose steps (cutover-cloud-owner.mjs, release-*.py) anchor on. Text checks
// only, no Docker.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const compose = read('infra/staging/compose.yaml');
const overlay = read('infra/staging/compose.stock-consumption.yaml');
const example = read('.env.example');
const P1_FLAGS = [
  'BACKOFFICE_POS_DAY_ENABLED',
  'BACKOFFICE_STOCK_AUTOCONSUME_ENABLED',
  'BACKOFFICE_MANAGER_SHIFTS_ENABLED',
  'BACKOFFICE_STAFF_POSITIONS_ENABLED',
  'BACKOFFICE_DISCOUNTS_ENABLED',
];
/** The text of one service (two-space key) of `text` up to the next service or top-level key. */
function service(text, name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, name);
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}
const defaultOff = (key) => `      ${key}: \${${key}:-false}\n`;
const lines = (text, prefix) => text.split(`\n${prefix}`).length - 1;

test('the five P1 flags default off in api and provision of compose.yaml and in .env.example', async () => {
  const { BACKOFFICE_P1_FLAGS } = await import('../../packages/platform/dist/config.js');
  assert.deepEqual([...BACKOFFICE_P1_FLAGS], P1_FLAGS);
  for (const key of P1_FLAGS) {
    for (const name of ['api', 'provision'])
      assert.ok(service(compose, name).includes(defaultOff(key)), `${name} ${key}`);
    assert.equal(lines(compose, `      ${key}: `), 2, key);
    assert.equal(example.split(`\n${key}=false\n`).length - 1, 1, key);
    assert.ok(!example.includes(`${key}=true`), key);
  }
  // One API and one owner database line: the anchors of the guarded compose steps.
  assert.equal(lines(compose, '      CLOUD_DATABASE_URL: postgresql://pickchick_app:'), 1);
  assert.equal(lines(compose, '      CLOUD_DATABASE_URL: postgresql://pickchick_owner:'), 1);
  assert.ok(!compose.includes('stock-consumption'));
});

test('the stock consumption worker overlay: one profiled service of the API image, API role, private network, no port', () => {
  assert.deepEqual(
    [...overlay.matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)].map((m) => m[1]),
    ['stock-consumption-worker'],
  );
  const worker = service(overlay, 'stock-consumption-worker');
  const api = service(compose, 'api');
  assert.match(
    compose,
    /\n {2}image: pickchick-api:\$\{RELEASE_SHA:\?Set verified release SHA\}\n/,
  );
  assert.match(worker, /\n {4}image: pickchick-api:\$\{RELEASE_SHA:\?Set verified release SHA\}\n/);
  assert.match(worker, /\n {4}profiles: \[stock-consumption\]\n/);
  assert.match(worker, /\n {4}networks: \[private\]\n/);
  assert.match(
    worker,
    /\n {4}command: \['node', 'services\/api\/dist\/stock-consumption-worker\.js'\]\n/,
  );
  for (const hardening of [
    'read_only: true',
    'cap_drop: [ALL]',
    "security_opt: ['no-new-privileges:true']",
    'init: true',
  ])
    assert.ok(worker.includes(`\n    ${hardening}\n`), hardening);
  assert.doesNotMatch(worker, /ports:|ingress|env_file|pickchick_owner|DB_ADMIN_PASSWORD/);
  // The same API database and Redis lines as the api service: the API role, never the owner.
  for (const prefix of ['CLOUD_DATABASE_URL: ', 'REDIS_URL: ']) {
    const line = (text) => text.split('\n').find((l) => l.trim().startsWith(prefix));
    assert.equal(line(worker), line(api), prefix);
  }
  // Including the overlay is the switch: the worker's own flags are on, nothing else is.
  for (const key of [
    'CATALOG_ADMIN_ENABLED',
    'BACKOFFICE_ENABLED',
    'BACKOFFICE_STOCK_V2_ENABLED',
    'BACKOFFICE_STOCK_AUTOCONSUME_ENABLED',
  ])
    assert.ok(worker.includes(`\n      ${key}: 'true'\n`), key);
  assert.equal((worker.match(/: 'true'\n/g) ?? []).length, 4);
});
