import { mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateProject } from './model.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = new URL('dist/', import.meta.url);
const raw = await readFile(new URL('../../docs/roadmap/project.json', import.meta.url), 'utf8');
const project = validateProject(JSON.parse(raw), root);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const name of ['index.html', 'app.js', 'styles.css']) {
  await copyFile(new URL(`public/${name}`, import.meta.url), new URL(name, dist));
}
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const sourceBranch = execFileSync('git', ['branch', '--show-current'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const previews = JSON.parse(await readFile(new URL('previews.json', import.meta.url), 'utf8'));
await writeFile(
  new URL('project.json', dist),
  JSON.stringify(
    {
      ...project,
      meta: {
        sourceSha,
        sourceBranch,
        publishedAt: new Date().toISOString(),
        dataHash: createHash('sha256').update(raw).digest('hex'),
      },
      previews,
    },
    null,
    2,
  ),
);
console.log(
  `Roadmap: ${project.workstreams.length} workstreams, ${project.tasks.length} tasks; source ${sourceSha.slice(0, 7)}`,
);
