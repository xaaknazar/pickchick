import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MENU_ASSETS } from '../menu-assets.mjs';
import { extractFile, listPackage } from '@electron/asar';
import { getCurrentFuseWire, FuseV1Options, FuseState } from '@electron/fuses';

const base = new URL('../', import.meta.url);
const root = new URL('../../', base);
const asar = fileURLToPath(new URL('release/win-unpacked/resources/app.asar', base));
const hash = (data) => createHash('sha256').update(data).digest('hex');
const git = (args) => {
  const result = spawnSync('git', args, { cwd: fileURLToPath(root), encoding: 'utf8' });
  assert.equal(result.status, 0, 'Git verification failed');
  return result.stdout.trim();
};
const manifest = JSON.parse(extractFile(asar, 'renderer/asset-manifest.json').toString('utf8'));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.source, 'apps/pos/src');
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
const renderer = [
  'api.js',
  'app.js',
  'index.html',
  'logo.png',
  'model.js',
  'styles.css',
  'types.js',
  ...MENU_ASSETS.map((name) => `assets/menu/${name}`),
].sort();
assert.deepEqual(Object.keys(manifest.files).sort(), renderer);
const expectedInputs = [
  ...['app.ts', 'api.ts', 'model.ts', 'types.ts', 'styles.css', 'index.html'].map(
    (name) => `apps/pos/src/${name}`,
  ),
  ...[
    'main.mjs',
    'protocol.mjs',
    'menu-assets.mjs',
    'journal.mjs',
    'preload.cjs',
    'package.json',
    'package-lock.json',
    'electron-builder.yml',
    'tsconfig.renderer.json',
    'scripts/build.mjs',
    'scripts/verify-package.mjs',
    'resources/config.example.json',
  ].map((name) => `apps/pos-desktop/${name}`),
  'apps/pos/tsconfig.json',
  'tsconfig.base.json',
  'packages/contracts/src/index.ts',
  'design/prototype/assets/mockup/logo.png',
  ...MENU_ASSETS.map((name) => `design/prototype/assets/mockup/${name}`),
].sort();
assert.deepEqual(Object.keys(manifest.inputs).sort(), expectedInputs);
for (const path of expectedInputs) {
  const input = await readFile(new URL(path, root));
  assert.equal(hash(input), manifest.inputs[path].sha256, `Source hash differs: ${path}`);
  assert.equal(input.byteLength, manifest.inputs[path].bytes);
}
const asarFiles = listPackage(asar)
  .map((path) => path.replaceAll('\\', '/'))
  .sort();
assert.deepEqual(
  asarFiles,
  [
    '/main.mjs',
    '/protocol.mjs',
    '/menu-assets.mjs',
    '/journal.mjs',
    '/preload.cjs',
    '/package.json',
    '/renderer',
    '/renderer/asset-manifest.json',
    '/renderer/assets',
    '/renderer/assets/menu',
    ...renderer.map((name) => `/renderer/${name}`),
  ].sort(),
  'Unexpected packaged file',
);
for (const name of renderer) {
  const asset = extractFile(asar, `renderer/${name}`);
  assert.equal(hash(asset), manifest.files[name].sha256, `Renderer hash differs: ${name}`);
  assert.equal(asset.byteLength, manifest.files[name].bytes);
}
for (const name of ['main.mjs', 'protocol.mjs', 'menu-assets.mjs', 'journal.mjs', 'preload.cjs'])
  assert.equal(
    hash(extractFile(asar, name)),
    manifest.inputs[`apps/pos-desktop/${name}`].sha256,
    `Main hash differs: ${name}`,
  );
assert.match(
  extractFile(asar, 'renderer/index.html').toString(),
  /name="pickchick-pos-storage" content="native-v1"/,
);
const pkg = JSON.parse(await readFile(new URL('package.json', base), 'utf8'));
assert.equal(JSON.parse(extractFile(asar, 'package.json').toString()).version, pkg.version);
const config = await readFile(new URL('release/win-unpacked/resources/config.example.json', base));
assert.equal(
  hash(config),
  manifest.inputs['apps/pos-desktop/resources/config.example.json'].sha256,
);
const artifacts = {};
for (const path of [
  `release/PickChick-POS-Setup-${pkg.version}-x64.exe`,
  `release/PickChick-POS-Portable-${pkg.version}-x64.exe`,
  'release/win-unpacked/PickChickPOS.exe',
  'release/win-unpacked/resources/app.asar',
]) {
  const data = await readFile(new URL(path, base));
  const record = { bytes: data.byteLength, sha256: hash(data) };
  if (path.endsWith('.exe')) {
    assert.equal(data.toString('ascii', 0, 2), 'MZ');
    const pe = data.readUInt32LE(0x3c);
    assert.equal(data.readUInt32LE(pe), 0x4550);
    record.peMachine = data.readUInt16LE(pe + 4);
    const optional = pe + 24,
      magic = data.readUInt16LE(optional);
    assert.ok([0x10b, 0x20b].includes(magic));
    record.certificateTableBytes = data.readUInt32LE(
      optional + (magic === 0x20b ? 112 : 96) + 4 * 8 + 4,
    );
    if (path.includes('win-unpacked/')) {
      assert.equal(record.peMachine, 0x8664, 'Windows payload must be AMD64');
      assert.equal(magic, 0x20b, 'Windows payload must be PE32+');
    }
  }
  artifacts[path] = record;
}
const fuses = await getCurrentFuseWire(
  fileURLToPath(new URL('release/win-unpacked/PickChickPOS.exe', base)),
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
  inputCount: expectedInputs.length,
  entryHashesMatch: true,
  artifacts,
  asarFiles,
  fuses,
  windowsExecutionTested: false,
  authenticodeVerified: false,
  physicalPowerLossTested: false,
};
await writeFile(new URL('release/verification.json', base), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
