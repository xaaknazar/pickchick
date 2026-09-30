import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export const statuses = ['done', 'active', 'blocked', 'planned', 'paused'];
export const results = ['pending', 'passed', 'failed'];
const owners = ['development', 'customer', 'joint', 'provider'];
const idPattern = /^[a-z][a-z0-9-]{1,79}$/;
export function validateProject(data, root) {
  const assert = (ok, message) => {
    if (!ok) throw new Error(`Roadmap: ${message}`);
  };
  assert(data.schemaVersion === 1 && data.project?.name, 'invalid project');
  assert(data.project.t0 === null || /^\d{4}-\d{2}-\d{2}$/.test(data.project.t0), 'invalid T0');
  assert(Number.isFinite(Date.parse(data.updatedAt)), 'invalid update date');
  const unique = (items, label) => {
    assert(Array.isArray(items) && items.length > 0, `empty ${label}`);
    const ids = new Set();
    for (const item of items) {
      assert(idPattern.test(item.id) && !ids.has(item.id), `duplicate/invalid ${label} id`);
      assert(typeof item.title === 'string' && item.title.length > 0, `missing ${label} title`);
      ids.add(item.id);
    }
    return ids;
  };
  const streams = unique(data.workstreams, 'workstream');
  const phases = unique(data.phases, 'phase');
  const tasks = unique(data.tasks, 'task');
  const checkPath = (path) => {
    assert(
      typeof path === 'string' && !path.startsWith('/') && !path.includes('..'),
      'unsafe source path',
    );
    const target = resolve(root, path.split('#')[0]);
    assert(target.startsWith(resolve(root) + sep) && existsSync(target), `missing source ${path}`);
  };
  for (const source of data.sources) checkPath(source);
  for (const task of data.tasks) {
    assert(streams.has(task.workstream) && phases.has(task.phase), `unknown parent ${task.id}`);
    assert(
      statuses.includes(task.status) && owners.includes(task.owner),
      `invalid status/owner ${task.id}`,
    );
    assert(
      Array.isArray(task.acceptance) && task.acceptance.length && task.nextAction && task.summary,
      `incomplete ${task.id}`,
    );
    assert(
      ['implemented', 'verified', 'deployed', 'accepted'].every(
        (key) => typeof task.checks?.[key] === 'boolean',
      ),
      `missing facts ${task.id}`,
    );
    assert(Array.isArray(task.evidence) && task.evidence.length, `missing evidence ${task.id}`);
    for (const ref of task.evidence) {
      assert(ref.label && (ref.path || ref.url), `invalid evidence ${task.id}`);
      if (ref.path) checkPath(ref.path);
      if (ref.url) assert(new URL(ref.url).protocol === 'https:', 'unsafe evidence URL');
    }
    assert(
      Array.isArray(task.dependsOn) &&
        task.dependsOn.every((id) => tasks.has(id) && id !== task.id),
      `unknown dependency ${task.id}`,
    );
  }
  const visited = new Set();
  const visiting = new Set();
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  function visit(id) {
    assert(!visiting.has(id), `dependency cycle ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    byId.get(id).dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  tasks.forEach(visit);
  return data;
}

export function validateReview(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (
    Object.keys(body).some(
      (key) => !['expectedVersion', 'status', 'result', 'author', 'note'].includes(key),
    )
  )
    return false;
  return (
    Number.isSafeInteger(body.expectedVersion) &&
    body.expectedVersion >= 0 &&
    statuses.includes(body.status) &&
    results.includes(body.result) &&
    typeof body.author === 'string' &&
    body.author.trim().length >= 2 &&
    body.author.length <= 80 &&
    typeof body.note === 'string' &&
    body.note.length <= 4000 &&
    (body.result === 'pending' || body.note.trim().length >= 5)
  );
}
