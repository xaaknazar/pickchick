import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MENU_ASSETS } from '../menu-assets.mjs';
import ts from 'typescript';

const base = new URL('../', import.meta.url);
const root = new URL('../../', base);
const source = new URL('../pos/src/', base);
const output = new URL('renderer/', base);
const buildResources = new URL('build/', base);
const head = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: fileURLToPath(root),
  encoding: 'utf8',
});
const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
  cwd: fileURLToPath(root),
  encoding: 'utf8',
});
const sourceCommit =
  head.status === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
const dirty = status.status !== 0 || Boolean(status.stdout.trim());
if (process.argv.includes('--release') && (!sourceCommit || dirty)) {
  throw new Error(
    'Release packaging requires a clean committed Git checkout. Commit the reviewed source first.',
  );
}
const inputs = {};
for (const path of [
  ...[
    'app.ts',
    'api.ts',
    'model.ts',
    'types.ts',
    'auth-view.ts',
    'order-view.ts',
    'styles.css',
    'index.html',
  ].map((name) => `apps/pos/src/${name}`),
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
].sort()) {
  const data = await readFile(new URL(path, root));
  inputs[path] = {
    bytes: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}
const configPath = fileURLToPath(new URL('tsconfig.renderer.json', base));
const raw = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, fileURLToPath(base));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = [
  ...(raw.error ? [raw.error] : []),
  ...parsed.errors,
  ...ts.getPreEmitDiagnostics(program),
];
if (diagnostics.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => fileURLToPath(base),
      getCanonicalFileName: (name) => name,
      getNewLine: () => '\n',
    }),
  );
  process.exit(1);
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(buildResources, { recursive: true });
await copyFile(
  new URL('design/prototype/assets/mockup/logo.png', root),
  new URL('icon.png', buildResources),
);
await copyFile(
  new URL('resources/config.example.json', base),
  new URL('config.example.json', buildResources),
);
for (const name of ['app', 'model', 'api', 'types', 'auth-view', 'order-view']) {
  const text = await readFile(new URL(`${name}.ts`, source), 'utf8');
  const compiled = ts.transpileModule(text, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      sourceMap: false,
    },
  });
  await writeFile(new URL(`${name}.js`, output), compiled.outputText);
}
await copyFile(new URL('styles.css', source), new URL('styles.css', output));
const html = await readFile(new URL('index.html', source), 'utf8');
if (!html.includes('<head>')) throw new Error('Missing renderer head');
await writeFile(
  new URL('index.html', output),
  html.replace('<head>', '<head>\n<meta name="pickchick-pos-storage" content="native-v1" />'),
);
await copyFile(
  new URL('design/prototype/assets/mockup/logo.png', root),
  new URL('logo.png', output),
);
await mkdir(new URL('assets/menu/', output), { recursive: true });
for (const name of MENU_ASSETS) {
  await copyFile(
    new URL(`design/prototype/assets/mockup/${name}`, root),
    new URL(`assets/menu/${name}`, output),
  );
}
const files = {};
for (const name of [
  'api.js',
  'app.js',
  'auth-view.js',
  'order-view.js',
  'index.html',
  'logo.png',
  'model.js',
  'styles.css',
  'types.js',
  ...MENU_ASSETS.map((name) => `assets/menu/${name}`),
].sort()) {
  const data = await readFile(new URL(name, output));
  files[name] = { bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') };
}
await writeFile(
  new URL('asset-manifest.json', output),
  JSON.stringify(
    { schemaVersion: 1, source: 'apps/pos/src', sourceCommit, sourceDirty: dirty, inputs, files },
    null,
    2,
  ) + '\n',
);
console.log(
  `Built packaged POS renderer: ${Object.keys(files).length} local assets; no server or database bundled.`,
);
