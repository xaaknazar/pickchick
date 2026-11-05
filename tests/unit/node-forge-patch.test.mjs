import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  verifyNodeForgePatch,
  resolveForgeConsumers,
  forgeAdvisory,
  verifyForgeLock,
} from '../../scripts/node-forge-security.mjs';
import { blockingAdvisories } from '../../scripts/dependency-audit.mjs';

test('all installed Expo signing consumers reject malformed signatures and accept valid RSA', () => {
  assert.equal(verifyNodeForgePatch().length, 4);
});
test('signature regression detects vulnerable unpatched node-forge behavior', () => {
  const consumer = resolveForgeConsumers()[0];
  const source = readFileSync(consumer.rsaPath, 'utf8').replace(
    /d\.substring\(0, withParameters\.length\) !== withParameters &&\s*d\.substring\(0, withoutParameters\.length\) !== withoutParameters/,
    'false',
  );
  assert.notEqual(source, readFileSync(consumer.rsaPath, 'utf8'));
  const code = `const {createRequire,Module}=require('node:module');
    const path=${JSON.stringify(consumer.rsaPath)};
    const request=createRequire(path); const forge=request('./index.js');
    const replacement=new Module(path);replacement.filename=path;replacement.paths=Module._nodeModulePaths(require('node:path').dirname(path));
    replacement._compile(${JSON.stringify(source)},path);
    import(${JSON.stringify(new URL('../../scripts/node-forge-security.mjs', import.meta.url).href)})
      .then(({signatureChecks})=>signatureChecks(forge));`;
  const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing expected exception/);
});
test('forge has no advisory exemptions; all high/critical and malformed audits fail', () => {
  const finding = {
    module_name: 'node-forge',
    github_advisory_id: forgeAdvisory,
    severity: 'high',
    findings: [{ version: '1.4.0' }],
  };
  const report = (items) => ({
    advisories: Object.fromEntries(items.map((x, i) => [i, x])),
    metadata: {
      vulnerabilities: {
        high: items.filter((x) => x.severity === 'high').length,
        critical: items.filter((x) => x.severity === 'critical').length,
      },
    },
  });
  assert.equal(blockingAdvisories(report([finding])).length, 1);
  for (const changed of [
    { ...finding, github_advisory_id: 'OTHER' },
    { ...finding, module_name: 'other' },
    { ...finding, findings: [{ version: '1.4.1' }] },
    { ...finding, severity: 'critical', github_advisory_id: 'OTHER' },
  ])
    assert.equal(blockingAdvisories(report([finding, changed])).length, 2);
  assert.throws(() => blockingAdvisories({}));
  assert.throws(() =>
    blockingAdvisories({ advisories: {}, metadata: { vulnerabilities: { high: 1, critical: 0 } } }),
  );
});

test('an extra unpatched node-forge snapshot or dependency reference fails the audit guard', () => {
  const lock = readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8');
  verifyForgeLock(lock);
  assert.throws(() => verifyForgeLock(lock + '\n  node-forge@1.4.0: {}\n'));
  assert.throws(() => verifyForgeLock(lock + '\n      node-forge: 1.4.0\n'));
});
