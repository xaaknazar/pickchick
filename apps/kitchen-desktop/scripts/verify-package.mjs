import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalize } from 'node:path';
import { extractFile, listPackage } from '@electron/asar';
import { getCurrentFuseWire, FuseV1Options, FuseState } from '@electron/fuses';
import { ASSETS, APP_URL } from '../security.mjs';
import { inputPaths } from './inputs.mjs';

const base = new URL('../', import.meta.url);
const root = new URL('../../', base);
const asar = fileURLToPath(new URL('release/win-unpacked/resources/app.asar', base));
// ASAR 3 traverses directories using the host path separator. Manifest names stay POSIX.
const readEntry = (name) => extractFile(asar, normalize(name));
const hash = (data) => createHash('sha256').update(data).digest('hex');
const git = (args) => {
  const result = spawnSync('git', args, { cwd: fileURLToPath(root), encoding: 'utf8' });
  assert.equal(result.status, 0, 'Git verification failed');
  return result.stdout.trim();
};
const manifest = JSON.parse(readEntry('renderer/asset-manifest.json').toString('utf8'));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.source, 'apps/kitchen/src');
assert.equal(manifest.sourceDirty, false, 'Only a clean-source package can be released');
assert.equal(
  manifest.sourceCommit,
  git(['rev-parse', 'HEAD']),
  'Package must match this exact checkout',
);
assert.equal(
  git(['status', '--porcelain', '--untracked-files=normal']),
  '',
  'Checkout must remain clean',
);
assert.deepEqual(Object.keys(manifest.files).sort(), [...ASSETS].sort());
assert.deepEqual(Object.keys(manifest.inputs).sort(), inputPaths);
for (const path of inputPaths) {
  const data = await readFile(new URL(path, root));
  assert.equal(hash(data), manifest.inputs[path].sha256, `Source hash differs: ${path}`);
  assert.equal(data.byteLength, manifest.inputs[path].bytes);
}
const asarFiles = listPackage(asar)
  .map((path) => path.replaceAll('\\', '/'))
  .sort();
assert.deepEqual(
  asarFiles,
  [
    '/main.mjs',
    '/security.mjs',
    '/gateway.mjs',
    '/package.json',
    '/renderer',
    '/renderer/fonts',
    '/renderer/asset-manifest.json',
    ...ASSETS.map((name) => '/renderer/' + name),
  ].sort(),
  'Unexpected packaged file',
);
for (const name of ASSETS) {
  const data = readEntry(`renderer/${name}`);
  assert.equal(hash(data), manifest.files[name].sha256, `Renderer hash differs: ${name}`);
  assert.equal(data.byteLength, manifest.files[name].bytes);
}
for (const name of ['main.mjs', 'security.mjs']) {
  assert.equal(hash(readEntry(name)), manifest.inputs[`apps/kitchen-desktop/${name}`].sha256);
}
assert.equal(hash(readEntry('gateway.mjs')), manifest.inputs['apps/kitchen/server.mjs'].sha256);
for (const name of ['index.html', 'styles.css']) {
  assert.equal(
    hash(readEntry(`renderer/${name}`)),
    manifest.inputs[`apps/kitchen/src/${name}`].sha256,
  );
}
const pkg = JSON.parse(await readFile(new URL('package.json', base), 'utf8'));
const packed = JSON.parse(readEntry('package.json').toString('utf8'));
assert.equal(packed.version, pkg.version);
assert.equal(packed.name, '@pickchick/kitchen-desktop');
assert.equal(packed.main, 'main.mjs');
const config = await readFile(new URL('release/win-unpacked/resources/config.example.json', base));
assert.equal(
  hash(config),
  manifest.inputs['apps/kitchen-desktop/resources/config.example.json'].sha256,
);
const artifacts = {};
for (const path of [
  `release/PickChick-Kitchen-Setup-${pkg.version}-x64.exe`,
  `release/PickChick-Kitchen-Portable-${pkg.version}-x64.exe`,
  'release/win-unpacked/PickChickKitchen.exe',
  'release/win-unpacked/resources/app.asar',
]) {
  const data = await readFile(new URL(path, base));
  const entry = { bytes: data.byteLength, sha256: hash(data) };
  if (path.endsWith('.exe')) {
    assert.equal(data.toString('ascii', 0, 2), 'MZ');
    const pe = data.readUInt32LE(0x3c);
    assert.equal(data.readUInt32LE(pe), 0x4550);
    entry.peMachine = data.readUInt16LE(pe + 4);
    const optional = pe + 24;
    const magic = data.readUInt16LE(optional);
    assert.ok([0x10b, 0x20b].includes(magic));
    entry.certificateTableBytes = data.readUInt32LE(
      optional + (magic === 0x20b ? 112 : 96) + 4 * 8 + 4,
    );
    if (path.includes('win-unpacked/')) {
      assert.equal(entry.peMachine, 0x8664, 'Windows payload must be AMD64');
      assert.equal(magic, 0x20b, 'Windows payload must be PE32+');
    }
  }
  artifacts[path] = entry;
}
const fuses = await getCurrentFuseWire(
  fileURLToPath(new URL('release/win-unpacked/PickChickKitchen.exe', base)),
);
for (const name of [
  'RunAsNode',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'GrantFileProtocolExtraPrivileges',
])
  assert.equal(fuses[FuseV1Options[name]], FuseState.DISABLE, `Unsafe fuse ${name}`);
for (const name of ['EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar'])
  assert.equal(fuses[FuseV1Options[name]], FuseState.ENABLE, `Missing fuse ${name}`);
const result = {
  sourceCommit: manifest.sourceCommit,
  sourceDirty: false,
  inputCount: inputPaths.length,
  entryHashesMatch: true,
  origin: APP_URL,
  profile: 'PickChickKitchen',
  partition: 'persist:kitchen-v1',
  artifacts,
  asarFiles,
  fuses,
  windowsExecutionTested: false,
  authenticodeVerified: false,
  physicalPowerLossTested: false,
};
await writeFile(new URL('release/verification.json', base), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
