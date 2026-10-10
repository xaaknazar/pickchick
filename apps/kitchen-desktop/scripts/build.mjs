import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { modules, inputPaths } from './inputs.mjs';

const base = new URL('../', import.meta.url);
const root = new URL('../../', base);
const source = new URL('../kitchen/src/', base);
const output = new URL('renderer/', base);
const buildResources = new URL('build/', base);
const git = (args) => spawnSync('git', args, { cwd: fileURLToPath(root), encoding: 'utf8' });
const head = git(['rev-parse', 'HEAD']);
const status = git(['status', '--porcelain', '--untracked-files=normal']);
const sourceCommit =
  head.status === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
const dirty = status.status !== 0 || Boolean(status.stdout.trim());
if (process.argv.includes('--release') && (!sourceCommit || dirty)) {
  throw new Error(
    'Release packaging requires a clean committed Git checkout. Commit the reviewed source first.',
  );
}
const hash = (data) => createHash('sha256').update(data).digest('hex');
const inputs = {};
for (const path of inputPaths) {
  const data = await readFile(new URL(path, root));
  inputs[path] = { bytes: data.byteLength, sha256: hash(data) };
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
// The gateway is copied byte-for-byte from the existing LAN client, including
// its path/header/body/CSP limits. There is no second implementation to drift.
await copyFile(new URL('apps/kitchen/server.mjs', root), new URL('gateway.mjs', base));
await copyFile(
  new URL('apps/kitchen/terminal-cookie.mjs', root),
  new URL('terminal-cookie.mjs', base),
);
const { ASSETS } = await import('../security.mjs');
await rm(output, { recursive: true, force: true });
await mkdir(new URL('fonts/', output), { recursive: true });
await mkdir(new URL('components/', output), { recursive: true });
await mkdir(buildResources, { recursive: true });
await copyFile(
  new URL('design/prototype/assets/mockup/logo.png', root),
  new URL('icon.png', buildResources),
);
await copyFile(
  new URL('resources/config.example.json', base),
  new URL('config.example.json', buildResources),
);
for (const name of modules) {
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
for (const name of ASSETS.filter((name) => !name.endsWith('.js'))) {
  const from = ['index.html', 'styles.css', 'components/PasswordReset.css'].includes(name)
    ? new URL(name, source)
    : new URL('design/prototype/assets/mockup/' + name, root);
  await copyFile(from, new URL(name, output));
}
const files = {};
for (const name of [...ASSETS].sort()) {
  const data = await readFile(new URL(name, output));
  files[name] = { bytes: data.byteLength, sha256: hash(data) };
}
await writeFile(
  new URL('asset-manifest.json', output),
  JSON.stringify(
    {
      schemaVersion: 1,
      source: 'apps/kitchen/src',
      sourceCommit,
      sourceDirty: dirty,
      inputs,
      files,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Built kitchen renderer: ${ASSETS.length} local assets, existing gateway; no database or credentials bundled.`,
);
