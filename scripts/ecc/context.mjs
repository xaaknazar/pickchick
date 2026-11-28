import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const gates = [
  {
    area: 'mobile',
    matches: /^(apps\/mobile|tests\/mobile)\//,
    checks: ['pnpm test:mobile', 'pnpm --filter @pickchick/mobile typecheck'],
    review:
      'RU/KK/EN, исходный дизайн, accessibility, навигация, повтор оплаты, настоящие iPhone/Android для приёмки.',
  },
  {
    area: 'kiosk',
    matches: /^(apps\/kiosk|tests\/kiosk)\//,
    checks: ['pnpm test:kiosk'],
    review:
      'Привязка устройства, восстановление заказа/оплаты, локальная сеть; нативные изменения проверить на iPad.',
  },
  {
    area: 'money-data-offline',
    matches:
      /^(services|packages|db|tests\/(integration|payments|pos|backoffice|kitchen|offline-stand))\//,
    checks: ['pnpm test', 'pnpm test:integration', 'pnpm test:offline-stand:unit'],
    review:
      'Выбрать затронутые commerce/loyalty/fulfillment/sync тесты; целые деньги, доверенный итог банка, идемпотентность, неизвестный исход, outbox/inbox, cloud/edge ownership и потеря WAN.',
  },
  {
    area: 'migration',
    matches: /^db\//,
    checks: [],
    review:
      'Проба миграции и повторного применения на изолированной копии, права роли API, совместимость старого клиента, план восстановления. Без рабочей БД.',
  },
  {
    area: 'contracts',
    matches: /^packages\/(contracts|api-client)\//,
    checks: ['pnpm contracts:check'],
    review:
      'Производители и потребители, старые клиенты, схемы событий и совместимость cloud/edge.',
  },
  {
    area: 'staff-ui',
    matches:
      /^(apps\/(backoffice|pos|pos-desktop|kitchen|kitchen-desktop|display)|tests\/(pos-desktop|kitchen-desktop))\//,
    checks: [],
    review:
      'Выбрать соответствующие backoffice/POS/Kitchen тесты и браузерные сценарии; Windows, принтер и WAN проверять отдельно на разрешённом стенде.',
  },
  {
    area: 'operations',
    matches: /^(infra|scripts|\.github)\//,
    checks: [],
    review:
      'Безопасный dry-run, блокировки, резервная копия, откат, секреты и права. Запуск скрипта установки не является проверкой без изменений.',
  },
  {
    area: 'agent-workflow',
    matches:
      /^(AGENTS\.md$|CLAUDE\.md$|\.claude\/|\.agents\/|scripts\/ecc\/|tests\/unit\/ecc-|docs\/collaboration\/ecc)/,
    checks: ['node --test tests/unit/ecc-context.test.mjs'],
    review:
      'Приоритет правил PickChick, отсутствие автоматического deploy/merge и секретов в передаче; plugin install и живой hook - разные доказательства.',
  },
];

export function classify(paths) {
  return gates
    .filter((gate) => paths.some((name) => gate.matches.test(name)))
    .map(({ area, checks, review }) => ({ area, checks, review }));
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

export function inspect(cwd, base = 'origin/codex/cutover-1119') {
  if (!base || base.startsWith('-') || /[\r\n\0]/.test(base)) {
    throw new Error('Invalid base ref');
  }
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const baseSha = git(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${base}^{commit}`,
  ]).trim();
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const mergeBase = git(root, ['merge-base', head, baseSha]).trim();
  const list = (args) => git(root, args).split('\0').filter(Boolean);
  const committed = list(['diff', '--name-only', '--no-renames', '-z', mergeBase, head, '--']);
  const staged = list(['diff', '--cached', '--name-only', '--no-renames', '-z', '--']);
  const unstaged = list(['diff', '--name-only', '--no-renames', '-z', '--']);
  const untracked = list(['ls-files', '--others', '--exclude-standard', '-z']);
  const files = [...new Set([...committed, ...staged, ...unstaged, ...untracked])].sort();
  const reviewAreas = classify(files);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    branch: git(root, ['branch', '--show-current']).trim() || '(detached)',
    head,
    base,
    baseSha,
    mergeBase,
    localRefsOnly: true,
    dirty: staged.length + unstaged.length + untracked.length > 0,
    changes: { committed, staged, unstaged, untracked },
    reviewAreas,
    suggestedChecks: [...new Set(reviewAreas.flatMap((area) => area.checks))],
    checksExecuted: false,
    instructions: [
      'Сначала project:check и project:tasks. Этот отчёт не получает свежие refs и не резервирует область.',
      'Список проверок рекомендательный: прочитать полный diff и добавить проверки вызывающего кода и затронутых зависимостей.',
      'DB-тесты только с изолированными fixtures; не использовать production .env. Команды здесь не выполняются.',
      'Отдельно указать код, локальные проверки, CI точного SHA, установку и приёмку на устройстве.',
      'Передача через проверенный коммит/PR и docs/collaboration/ecc-handoffs; без секретов и переписки.',
    ],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--base')) {
      throw new Error('Usage: node scripts/ecc/context.mjs [--base <git-ref>]');
    }
    console.log(JSON.stringify(inspect(process.cwd(), args[1]), null, 2));
  } catch (error) {
    console.error(`ECC context unavailable: ${error.message}`);
    process.exitCode = 1;
  }
}
