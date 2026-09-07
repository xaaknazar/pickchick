import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import {
  checkedUrl,
  checkedSchema,
  defaults,
  parseArgs,
  scopedUrl,
  boundedMap,
  quantiles,
  safeCode,
} from './fulfillment-capacity-support.mjs';

test('capacity harness accepts only exact local development database endpoints', () => {
  for (const kind of ['cloud', 'edge']) {
    assert.equal(checkedUrl(defaults[kind], kind).hostname, '127.0.0.1');
    for (const bad of [
      defaults[kind].replace('127.0.0.1', 'localhost'),
      defaults[kind].replace('127.0.0.1', '203.0.113.9'),
      defaults[kind].replace(kind === 'cloud' ? '55432' : '55433', '5432'),
      defaults[kind].replace(`pickchick_${kind}`, 'postgres'),
      defaults[kind] + '?options=-c%20search_path=public',
      defaults[kind] + '#private',
      'not a URL',
    ])
      assert.throws(() => checkedUrl(bad, kind), { code: 'UNSAFE_DATABASE_URL' });
  }
});
test('schema ownership and output destinations cannot address existing user data', () => {
  const name = 'ftcap_' + 'a'.repeat(32) + '_edge_9';
  assert.equal(checkedSchema(name), name);
  assert.equal(
    new URL(scopedUrl(defaults.edge, 'edge', name)).searchParams.get('options'),
    `-c search_path=${name}`,
  );
  for (const bad of [
    'public',
    name + ';DROP SCHEMA public',
    name.replace('_9', '_10'),
    'ftcap_any_cloud',
  ])
    assert.throws(() => checkedSchema(bad), { code: 'UNOWNED_SCHEMA' });
  assert.throws(() => parseArgs(['--output', '../../outside.json'], '/repo'));
  assert.throws(() => parseArgs(['--output', '.env'], '/repo'));
  assert.throws(() => parseArgs(['--branches', '100'], '/repo'));
  assert.equal(
    parseArgs(['--quick', '--output', '.local/capacity/quick.json'], '/repo').output,
    '/repo/.local/capacity/quick.json',
  );
});
test('bounded scheduler settles in-flight jobs before propagating a failure', async () => {
  let active = 0,
    peak = 0,
    finished = 0;
  await assert.rejects(
    boundedMap([0, 1, 2, 3, 4, 5], 2, async (item) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        if (item === 0) throw new Error('synthetic');
      } finally {
        active--;
        finished++;
      }
    }),
  );
  assert.equal(active, 0);
  assert.equal(peak, 2);
  assert.equal(finished, 2);
});
test('diagnostic summaries never copy arbitrary exception text or tokens', () => {
  assert.equal(safeCode(new Error('private payload')), 'HARNESS_ERROR');
  assert.equal(safeCode({ code: 'private/token+value' }), 'HARNESS_ERROR');
  assert.deepEqual(quantiles([4, 1, 3, 2]), {
    count: 4,
    p50_ms: 2,
    p95_ms: 4,
    p99_ms: 4,
    max_ms: 4,
  });
});
