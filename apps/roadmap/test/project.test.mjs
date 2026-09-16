import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateProject } from '../model.mjs';

test('all roadmap dependencies and source evidence resolve in the repository', async () => {
  const project = JSON.parse(
    await readFile(new URL('../../../docs/roadmap/project.json', import.meta.url), 'utf8'),
  );
  assert.equal(
    validateProject(project, fileURLToPath(new URL('../../../', import.meta.url))),
    project,
  );
});
