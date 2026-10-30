import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const mobileRequire = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const routerRequire = createRequire(mobileRequire.resolve('expo-router/package.json'));
const queryPath = routerRequire.resolve('query-string');
const query = routerRequire('query-string');
const decodePath = createRequire(queryPath).resolve('decode-uri-component');

test('Expo Router query parser keeps its CommonJS API with the patched URI decoder', () => {
  const name = 'С собой';
  const result = query.parseUrl(
    'pickchick://cart?mode=dine_in&tag=x&tag=y&name=' + encodeURIComponent(name),
  );
  assert.equal(result.url, 'pickchick://cart');
  assert.deepEqual({ ...result.query }, { mode: 'dine_in', name, tag: ['x', 'y'] });
  assert.equal(query.parse('broken=%zz').broken, '%zz');
  assert.deepEqual({ ...query.parse(query.stringify(result.query)) }, { ...result.query });
});

test('malformed distinct percent runs do not block the URI decoder (GHSA-qr28-fpjm-wq7f)', () => {
  const script = `
    const { default: decode } = await import(process.argv[1]);
    let input = '';
    for (let i = 0; i < 32000; i++) {
      input += '%' + Math.floor(i / 256).toString(16).padStart(2, '0')
        + '%' + (i % 256).toString(16).padStart(2, '0') + 'x';
    }
    input += '%zz';
    const output = decode(input);
    if (typeof output !== 'string' || !output.endsWith('%zz')) process.exit(2);
    process.stdout.write('decoded');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, decodePath], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, 'decoder exceeded its bounded regression timeout');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'decoded');
});
