// Stage 2 integration (PM addendum 6): where the POS cloud-link grant can be lost or given on
// the Windows cashier. The three installers that re-apply runtime grants are historical, bound to
// archives whose grant script predates --cloud-link, and pinned byte for byte by later releases;
// the runtime 1021 release never resets runtime grants; the live cashier gets the grant from the
// additive cloud-link-grant.mjs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const windows = new URL('../../infra/windows/', import.meta.url);
const read = (name) => readFile(new URL(name, windows), 'utf8');
const sha = async (name) =>
  createHash('sha256')
    .update(await readFile(new URL(name, windows)))
    .digest('hex');

test('the installers that reset runtime grants accept only pre-cloud-link archives', async () => {
  const gates = {
    'install-native-services.ps1': "$sourceCommit = '0186902b30b995ba49ab69346a2bcc1088bb3fa6'",
    'update-native-preview.ps1': 'Expected schema001-010 archive.',
    'update-native-service.ps1': 'Expected schema001-014 archive.',
  };
  for (const [name, gate] of Object.entries(gates)) {
    const text = await read(name);
    assert.ok(text.includes(gate), name);
    // The packaged grant script of those archives accepts only --fulfillment: passing
    // --cloud-link there would fail their runtime-grants step.
    assert.match(text, /edge-runtime-grants\.mjs'\),\s*'pickchick_edge_runtime'\)/, name);
  }
});

test('update-native-service.ps1 and install-native-services.ps1 stay byte-identical for their pinned users', async () => {
  const service = await sha('update-native-service.ps1');
  const users = [];
  for (const name of (await readdir(windows)).filter((n) => n.endsWith('.ps1')))
    if ((await read(name)).includes(service)) users.push(name);
  for (const name of [
    'update-runtime-1021.ps1',
    'update-native-unified-menu.ps1',
    'update-native-device-access.ps1',
  ])
    assert.ok(users.includes(name), name);
  assert.ok(
    (await read('backup-native-edge.ps1')).includes(await sha('install-native-services.ps1')),
  );
});

test('the runtime 1021 release adds grants only; the stage 2 grant tool is additive and exact', async () => {
  const runtime1021 = await read('runtime-schema-1021.mjs');
  assert.doesNotMatch(runtime1021, /REVOKE/);
  assert.doesNotMatch(runtime1021, /edge-runtime-grants|applyEdgeRuntimeGrants/);
  const tool = await read('cloud-link-grant.mjs');
  assert.match(tool, /GRANT SELECT\(\$\{list\}\) ON/);
  assert.doesNotMatch(tool, /REVOKE ALL/);
  // The tool refuses anything but the local edge owner before loading a driver.
  const script = fileURLToPath(new URL('cloud-link-grant.mjs', windows));
  for (const env of [
    { EDGE_DATABASE_URL: 'postgresql://pickchick_edge_runtime:x@127.0.0.1:55433/pickchick_edge' },
    { EDGE_DATABASE_URL: 'postgresql://pickchick_edge_owner:x@10.0.0.5:55433/pickchick_edge' },
    {},
  ])
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [script, 'apply', fileURLToPath(windows), '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'],
        { env: { PATH: process.env.PATH, ...env } },
      ),
      (error) => error.code === 1 && error.stderr.includes('cloud_link_grant_failed'),
    );
});
