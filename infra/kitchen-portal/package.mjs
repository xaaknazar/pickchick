import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const root = '.local/kitchen-link/package-' + sha;
await mkdir(root, { recursive: true });
const paths = [
  'infra/kitchen-portal/server.mjs',
  'infra/kitchen-portal/link.mjs',
  'infra/kitchen-portal/agent.mjs',
  'infra/kitchen-portal/compose.yaml',
  'infra/kitchen-portal/remote-deploy.py',
  'infra/roadmap/remote-deploy.py',
  'apps/kitchen/server.mjs',
];
async function walk(path) {
  for (const name of await readdir(path, { withFileTypes: true })) {
    const file = join(path, name.name);
    if (name.isDirectory()) await walk(file);
    else if (!name.isSymbolicLink()) paths.push(file);
  }
}
await walk('apps/kitchen/dist');
const files = {};
for (const path of paths) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await copyFile(path, join(root, path));
  files[path] = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
await writeFile(
  join(root, 'kitchen-package.json'),
  JSON.stringify({ source_sha: sha, files }, null, 2),
);
const agentFiles = Object.fromEntries(
  [
    'infra/kitchen-portal/agent.mjs',
    'infra/kitchen-portal/link.mjs',
    'apps/kitchen/server.mjs',
  ].map((path) => [path, files[path]]),
);
await writeFile(
  join(root, 'agent-package.json'),
  JSON.stringify({ source_sha: sha, files: agentFiles }, null, 2),
);
console.log(JSON.stringify({ package: root, source_sha: sha }));
