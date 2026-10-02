import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentChecks } from '../../scripts/development-checks.mjs';

test('mobile-only changes select mobile feedback and browser suites', () => {
  const plan = developmentChecks(['apps/mobile/src/model.ts', 'tests/mobile/browser_checkout.py']);
  assert.equal(plan.scope, 'mobile');
  assert.ok(plan.commands.includes('pnpm test:mobile'));
  assert.match(plan.ci, /Kaspi fixtures/);
});
test('shared dependencies, mixed scopes, unrecognized paths and empty changes require full CI', () => {
  for (const paths of [
    [],
    ['package.json'],
    ['packages/contracts/src/index.ts'],
    ['.github/workflows/ci.yml'],
    ['apps/mobile/src/model.ts', 'services/api/src/main.ts'],
    ['docs/helper.py'],
  ]) {
    const plan = developmentChecks(paths);
    assert.equal(plan.scope, 'full');
    assert.equal(plan.ci, 'Foundation CI (all jobs)');
  }
});
test('documentation feedback keeps full release validation', () => {
  const plan = developmentChecks(['docs/project-status.md']);
  assert.equal(plan.scope, 'docs');
  assert.equal(plan.ci, 'Foundation CI (all jobs)');
});
