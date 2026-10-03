import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { forgeAdvisory, verifyNodeForgePatch } from './node-forge-security.mjs';

import { bracesAdvisory, verifyBracesPatch } from './braces-security.mjs';

/** Exception applies only after all installed Expo consumers pass executable validation. */
export function blockingAdvisories(report) {
  assert.ok(
    report && typeof report.advisories === 'object' && report.metadata?.vulnerabilities,
    'Unexpected audit response; refusing to skip the security gate',
  );
  const advisories = Object.values(report.advisories);
  const counts = report.metadata.vulnerabilities;
  for (const severity of ['high', 'critical'])
    assert.equal(
      advisories.filter((item) => item.severity === severity).length,
      counts[severity],
      'Unaccounted audit findings; refusing the exception',
    );
  return advisories.filter((item) => {
    if (
      item.github_advisory_id === forgeAdvisory &&
      item.module_name === 'node-forge' &&
      item.findings?.length &&
      item.findings.every((finding) => finding.version === '1.4.0')
    )
      return false;
    if (
      item.github_advisory_id === bracesAdvisory &&
      item.module_name === 'braces' &&
      item.findings?.length &&
      item.findings.every((finding) => finding.version === '3.0.3')
    )
      return false;
    return ['high', 'critical'].includes(item.severity);
  });
}
export function auditedRelease() {
  verifyNodeForgePatch();
  verifyBracesPatch();
  const result = spawnSync('pnpm', ['audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.signal || ![0, 1].includes(result.status))
    throw new Error('Dependency audit failed to execute; no findings ignored');
  const report = JSON.parse(result.stdout);
  const blocked = blockingAdvisories(report);
  if (blocked.length)
    throw new Error(
      `Dependency audit blocked: ${blocked.map((item) => `${item.module_name} ${item.github_advisory_id}`).join(', ')}`,
    );
  console.log(
    `Dependency audit passed high/critical gate; ${forgeAdvisory} and ${bracesAdvisory} validated by installed patches and executable regressions. Lower findings: ${report.metadata.vulnerabilities.moderate} moderate.`,
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) auditedRelease();
