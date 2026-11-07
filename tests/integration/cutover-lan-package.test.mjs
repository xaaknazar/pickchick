import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// CR client-3 section 1, CR client-4 section 4 (integration): the KitchenLAN operator package of
// RC-client. The manifest in the master runbook must name exactly the eight files and their
// bytes in this commit, so a changed file without a new manifest row fails here.

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PACKAGE = [
  'kitchen-lan-gateway.mjs',
  'lan-route-profiles.mjs',
  'kitchen-lan-check.mjs',
  'install-native-foundation.ps1',
  'install-kitchen-lan.ps1',
  'update-kitchen-lan-clients.ps1',
  'install-kitchen-client.ps1',
  'install-pos-client.ps1',
];

async function manifest() {
  const text = (await read('docs/operations/cutover-2026-11-19.md')).toString('utf8');
  const begin = text.indexOf('<!-- cutover:kitchen-lan-manifest begin -->');
  const end = text.indexOf('<!-- cutover:kitchen-lan-manifest end -->');
  assert.ok(begin > 0 && end > begin, 'manifest markers');
  const rows = [
    ...text.slice(begin, end).matchAll(/^\| `([^`]+)` +\|[^|]+\| `([a-f0-9]{64})` \|$/gm),
  ];
  return rows.map(([, file, hash]) => [file, hash]);
}

test('master runbook manifest: exactly the eight package files with their SHA-256 here', async () => {
  const rows = await manifest();
  assert.deepEqual(
    rows.map(([file]) => file),
    PACKAGE,
  );
  for (const [file, hash] of rows)
    assert.equal(
      sha256(await read(`infra/windows/${file}`)),
      hash,
      `${file} changed: new manifest row`,
    );
});

test('the package is self-contained: gateway profiles beside the gateway, hashes demanded', async () => {
  const gateway = (await read('infra/windows/kitchen-lan-gateway.mjs')).toString('utf8');
  // Only Node built-ins and the profiles file next to it.
  const imports = [...gateway.matchAll(/^import [^;]+? from '([^']+)';$/gms)].map(
    ([, from]) => from,
  );
  assert.ok(imports.includes('./lan-route-profiles.mjs'));
  for (const from of imports)
    assert.ok(from.startsWith('node:') || from === './lan-route-profiles.mjs', from);
  const profiles = (await read('infra/windows/lan-route-profiles.mjs')).toString('utf8');
  for (const from of [...profiles.matchAll(/^import [^;]+? from '([^']+)';$/gms)].map(
    ([, value]) => value,
  ))
    assert.ok(from.startsWith('node:'), from);
  const install = (await read('infra/windows/install-kitchen-lan.ps1')).toString('utf8');
  assert.match(
    install,
    /\[Parameter\(Mandatory=\$true\)\]\[ValidatePattern\('\^\[a-f0-9\]\{64\}\$'\)\]\[string\]\$ProfilesSha256/,
  );
  assert.match(install, /Open-VerifiedFile \$ProfilesScript \$ProfilesSha256/);
  const update = (await read('infra/windows/update-kitchen-lan-clients.ps1')).toString('utf8');
  assert.match(update, /-not \$GatewaySha256 -or -not \$ProfilesSha256 -or -not \$CheckSha256/);
  assert.match(update, /Open-VerifiedFile \$ProfilesScript \$ProfilesSha256/);
});
