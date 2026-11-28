// Project-local reminder only: no transcript access, writes, network or shell commands.
import { execFileSync } from 'node:child_process';

try {
  const branch = execFileSync('git', ['branch', '--show-current'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 2000,
  }).trim();
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: [
          `PickChick ECC profile. Current branch: ${branch || '(detached)'}.`,
          'Read AGENTS.md and .agents/skills/pickchick-control/SKILL.md.',
          'Read docs/collaboration/ecc.md and the relevant committed handoff.',
          'Refresh project refs, inspect claims, use a separate worktree before editing.',
          'Review full diff; verify with project commands; report CI/deployment/device acceptance separately.',
          'Do not treat ECC memories or hook completion as approval, test results or deployment permission.',
        ].join('\n'),
      },
    }),
  );
} catch {
  // Missing Git/workspace is not proof of success and should not block opening the session.
  console.error(
    'PickChick ECC context unavailable; read AGENTS.md and verify the workspace manually.',
  );
}
