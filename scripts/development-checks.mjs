import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Advisory only: release CI always runs every suite. Unknown paths fail closed.
export function developmentChecks(paths) {
  if (!paths.length)
    return {
      scope: 'full',
      reason: 'No changed paths supplied',
      commands: ['pnpm check'],
      ci: 'Foundation CI (all jobs)',
    };
  if (paths.every((path) => path.startsWith('docs/') && /\.(md|json)$/.test(path))) {
    return {
      scope: 'docs',
      commands: ['pnpm exec prettier --check docs'],
      ci: 'Foundation CI (all jobs)',
    };
  }
  if (paths.every((path) => path.startsWith('apps/mobile/') || path.startsWith('tests/mobile/'))) {
    return {
      scope: 'mobile',
      commands: [
        'pnpm --filter @pickchick/mobile... build',
        'pnpm --filter @pickchick/mobile typecheck',
        'pnpm test:mobile',
        'pnpm --filter @pickchick/mobile export',
      ],
      ci: 'Foundation mobile bundles and checkout recovery; Foundation simulator browser regressions; Foundation server account and Kaspi fixtures',
      note: 'Run the affected browser scenarios with isolated fixtures. These commands are development feedback; release requires all jobs.',
    };
  }
  return {
    scope: 'full',
    reason: 'Shared, mixed or unknown paths require full validation',
    commands: ['pnpm check'],
    ci: 'Foundation CI (all jobs)',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let paths = args;
  if (args[0] === '--base') {
    if (args.length !== 2)
      throw new Error('Usage: development-checks.mjs --base <git-ref> OR <paths...>');
    paths = execFileSync('git', ['diff', '--name-only', '-z', args[1], '--'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  }
  console.log(JSON.stringify(developmentChecks(paths), null, 2));
}
