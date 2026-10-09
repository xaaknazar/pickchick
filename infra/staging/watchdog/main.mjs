// PickChick read-only watchdog, one run per invocation (systemd timer -> run-watchdog.py ->
//   docker compose run watchdog). Reads: API readiness, host facts file, pickchick_watchdog
// SELECTs. Writes: only its own state file. Sends: Telegram, or prints in dry-run/shadow mode.
//   node infra/staging/watchdog/main.mjs --facts /abs/host-facts.json --state /abs/state.json
//     [--dry-run] [--summary]
import { randomUUID } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { probeApi } from './api-probe.mjs';
import { evaluate } from './checks.mjs';
import { loadWatchdogConfig } from './config.mjs';
import { normalizeState, planNotifications, summaryDue } from './dedup.mjs';
import { parseHostFacts } from './host-facts.mjs';
import { chunk, renderEvents, renderSummary } from './messages.mjs';
import { databaseErrorCode, readDatabaseFacts } from './queries.mjs';
import { sendTelegram } from './telegram.mjs';

export function parseArgs(argv) {
  const args = { facts: null, state: null, dryRun: false, summary: false };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--dry-run') args.dryRun = true;
    else if (value === '--summary') args.summary = true;
    else if (
      (value === '--facts' || value === '--state') &&
      /^\/[^\0]{1,400}$/.test(argv[i + 1] ?? '')
    )
      args[value.slice(2)] = argv[++i];
    else throw new Error('WATCHDOG_USAGE');
  }
  if (!args.facts || !args.state) throw new Error('WATCHDOG_USAGE');
  return args;
}

async function connectDatabase(db) {
  const { createPool } = await import('@pickchick/database');
  const url = new URL(`postgresql://${db.host}:${db.port}/${db.database}`);
  url.username = db.user;
  url.password = db.password;
  return createPool(url.href, 1);
}

async function readDatabase(config, connect) {
  let pool;
  try {
    pool = await connect(config.db);
    const facts = await readDatabaseFacts(pool, {
      paymentBacklogMinutes: config.paymentBacklogMinutes,
    });
    return { ok: true, facts };
  } catch (error) {
    return { ok: false, code: databaseErrorCode(error) };
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

/** Atomic private replace: a crash leaves either the old or the new complete state. */
export async function writePrivateFile(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

const readOptional = (read, path) => read(path, 'utf8').catch(() => '');
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Returns the process exit code: 0 ok, 1 delivery/state failure, 64 usage, 78 config. */
export async function runWatchdog({
  argv,
  env,
  now = Date.now,
  fetcher = fetch,
  readText = readFile,
  writeText = writePrivateFile,
  connect = connectDatabase,
  print = (record) => console.log(JSON.stringify(record)),
}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch {
    print({ event: 'watchdog_usage_invalid' });
    return 64;
  }
  let config;
  try {
    config = loadWatchdogConfig(env);
  } catch (error) {
    print({ event: 'watchdog_config_invalid', variable: error?.variable ?? null });
    return 78;
  }
  const nowMs = now();
  const delivery = args.dryRun || !config.telegram.enabled ? 'print' : 'telegram';
  const [api, hostText, db, stateText] = await Promise.all([
    probeApi(config.apiReadyUrl, fetcher),
    readOptional(readText, args.facts),
    readDatabase(config, connect),
    readOptional(readText, args.state),
  ]);
  const host = parseHostFacts(hostText, nowMs, config.factsMaxAgeMinutes * 60_000);
  const evaluation = evaluate({ api, host, db, config, nowMs });
  const stored = parseJson(stateText);
  // A manual dry run previews against the live state without changing it.
  const previous = normalizeState(stored, args.dryRun ? (stored?.delivery ?? delivery) : delivery);
  const { events, state } = planNotifications(previous, evaluation, nowMs, config);
  const messages = events.length ? [renderEvents(events, config, nowMs)] : [];
  const summaryDay = summaryDue(previous, nowMs, config, args.summary);
  if (summaryDay) {
    messages.push(renderSummary(evaluation, config, nowMs));
    state.lastSummaryDay = summaryDay;
  }
  if (args.dryRun)
    for (const finding of evaluation.findings)
      print({
        event: 'watchdog_finding',
        key: finding.key,
        status: finding.status,
        severity: finding.severity,
        detail: finding.detail,
      });
  if (delivery === 'telegram') {
    try {
      for (const message of messages)
        for (const part of chunk(message)) await sendTelegram(config.telegram, part, fetcher);
    } catch (error) {
      // State is not advanced: the same notifications are retried on the next run.
      print({ event: 'watchdog_delivery_failed', code: error?.code ?? 'TELEGRAM_FAILED' });
      return 1;
    }
  } else for (const text of messages) print({ event: 'watchdog_message', text });
  if (!args.dryRun) {
    try {
      await writeText(args.state, JSON.stringify(state) + '\n');
    } catch {
      print({ event: 'watchdog_state_write_failed' });
      return 1;
    }
  }
  print({
    event: 'watchdog_run',
    delivery,
    dryRun: args.dryRun,
    checks: evaluation.findings.length,
    failing: evaluation.findings.filter((finding) => finding.status === 'fail').length,
    notifications: events.length,
    summary: Boolean(summaryDay),
    unavailable: [...evaluation.unavailable].sort(),
  });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runWatchdog({ argv: process.argv.slice(2), env: process.env });
  } catch {
    console.log(JSON.stringify({ event: 'watchdog_failed' }));
    process.exitCode = 1;
  }
}
