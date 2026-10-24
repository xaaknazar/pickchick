/**
 * Offline stand runner (docs/operations/offline-stand.md).
 *
 *   node --env-file=.env tests/offline-stand/run.mjs                      # CI profile, minutes
 *   node --env-file=.env tests/offline-stand/run.mjs --mode soak --duration 8h
 *   node --env-file=.env tests/offline-stand/run.mjs --mode backlog --events 10000
 *
 * Options: --scenarios a,b  --seed N  --output DIR (default .local/offline-stand/<run>)
 *          --keep (keep the run schemas)  --no-docker (skip the restore drill)
 *          --cleanup (drop every offstand_* schema left by a killed run; no stand may run)
 *          soak only: --sample-every 10m  --shift-every 4h  --relogin-every 1h
 * Databases: CLOUD_DATABASE_URL / EDGE_DATABASE_URL (local only); the restore drill restores the
 * edge copy into OFFLINE_STAND_RESTORE_DATABASE_URL (default: pickchick_edge on the cloud server).
 * Writes report.json and report.md (Russian); exit code 1 when any check failed.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { cpus, totalmem } from 'node:os';
import { Stand, root, checkedAdminUrl, SCHEMA_PATTERN } from './stand.mjs';
import { Restaurant } from './restaurant.mjs';
import { Traffic } from './traffic.mjs';
import { Context, SCENARIOS, SCENARIO_ORDER } from './scenarios.mjs';
import { pendingWork, backlogMark } from './checks.mjs';
import { distinguishable } from './staff-view.mjs';
import { seededRandom } from './fault-proxy.mjs';
import { renderMarkdown } from './report.mjs';

const MINUTE = 60000,
  HOUR = 60 * MINUTE;
const CHAOS = {
  dropResponse: 0.15,
  duplicate: 0.15,
  late: 0.08,
  lateMs: 6500,
  reorder: 0.1,
  reorderMs: 1200,
  reset: 0.05,
  delayMs: [0, 300],
};
/** A weak but working uplink after reconnect (backlog delivery): occasional loss and repeats. */
const FLAKY = {
  dropResponse: 0.03,
  duplicate: 0.05,
  late: 0.01,
  lateMs: 6500,
  reorder: 0.05,
  reorderMs: 800,
  reset: 0.01,
  delayMs: [20, 150],
};
export const PROFILES = {
  ci: {
    baselineMs: 20000,
    wanFault: 'down',
    wanOutageMs: 75000,
    chaosMs: 45000,
    lanOutageMs: 25000,
    edgeKills: 2,
    edgeKillEveryMs: 10000,
    cloudDownMs: 10000,
    restoreLostMs: 15000,
    restoreAfterMs: 15000,
    backlogEvents: 300,
    backlogTimeoutMs: 4 * MINUTE,
    convergeTimeoutMs: 4 * MINUTE,
    convergeLimitS: 150,
    chaos: CHAOS,
    reconnectChaos: FLAKY,
    rates: { posPerMinute: 20, channelPerMinute: 6 },
  },
  soak: {
    baselineMs: 5 * MINUTE,
    wanFault: 'down',
    durationMs: 8 * HOUR,
    checkEveryMs: 10 * MINUTE,
    shiftEveryMs: 4 * HOUR,
    staffEveryMs: HOUR,
    edgeRestartAtShare: 0.5,
    convergeTimeoutMs: 45 * MINUTE,
    convergeLimitS: 30 * 60,
    chaos: CHAOS,
    reconnectChaos: FLAKY,
    rates: { posPerMinute: 3, channelPerMinute: 2, kitchenEveryMs: 5000 },
  },
  backlog: {
    baselineMs: 10000,
    backlogEvents: 10000,
    backlogTimeoutMs: 3 * HOUR,
    convergeTimeoutMs: 90 * MINUTE,
    convergeLimitS: 60 * 60,
    chaos: CHAOS,
    reconnectChaos: FLAKY,
    // Normal restaurant pace; the accumulation phase itself sells and cooks as fast as it can.
    rates: { posPerMinute: 3, channelPerMinute: 0, kitchenEveryMs: 2000 },
  },
};

export function parseDuration(text) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text ?? '');
  if (!match) throw new Error('Duration like 90s, 30m or 8h expected');
  return Math.round(Number(match[1]) * { ms: 1, s: 1000, m: MINUTE, h: HOUR }[match[2]]);
}
export function parseArgs(argv) {
  const options = { mode: 'ci', seed: 20261024, keep: false, noDocker: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i],
      value = () => {
        if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
        return argv[++i];
      };
    if (arg === '--') continue;
    else if (arg === '--cleanup') options.cleanup = true;
    else if (arg === '--mode') options.mode = value();
    else if (arg === '--duration') options.durationMs = parseDuration(value());
    else if (arg === '--sample-every') options.checkEveryMs = parseDuration(value());
    else if (arg === '--shift-every') options.shiftEveryMs = parseDuration(value());
    else if (arg === '--relogin-every') options.staffEveryMs = parseDuration(value());
    else if (arg === '--events') options.events = Number(value());
    else if (arg === '--scenarios') options.scenarios = value().split(',');
    else if (arg === '--seed') options.seed = Number(value());
    else if (arg === '--output') options.output = value();
    else if (arg === '--rate') options.rate = Number(value());
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--no-docker') options.noDocker = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!PROFILES[options.mode]) throw new Error('--mode ci|soak|backlog');
  if (options.events !== undefined && !(Number.isInteger(options.events) && options.events > 0))
    throw new Error('--events must be a positive integer');
  if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer');
  if (options.rate !== undefined && !(options.rate > 0 && options.rate <= 600))
    throw new Error('--rate is POS orders per minute (0-600]');
  for (const id of options.scenarios ?? [])
    if (!SCENARIOS[id] && id !== 'backlog' && id !== 'soak')
      throw new Error(`Unknown scenario ${id}`);
  return options;
}
export function profileFor(options) {
  const base = PROFILES[options.mode];
  return {
    ...base,
    ...(options.durationMs ? { durationMs: options.durationMs } : {}),
    ...(options.checkEveryMs ? { checkEveryMs: options.checkEveryMs } : {}),
    ...(options.shiftEveryMs ? { shiftEveryMs: options.shiftEveryMs } : {}),
    ...(options.staffEveryMs ? { staffEveryMs: options.staffEveryMs } : {}),
    ...(options.events ? { backlogEvents: options.events } : {}),
    rates: { ...base.rates, ...(options.rate ? { posPerMinute: options.rate } : {}) },
    noDocker: options.noDocker,
  };
}
function defaultRestoreUrl() {
  if (process.env.OFFLINE_STAND_RESTORE_DATABASE_URL)
    return process.env.OFFLINE_STAND_RESTORE_DATABASE_URL;
  const url = new URL(process.env.CLOUD_DATABASE_URL);
  url.pathname = '/pickchick_edge';
  return url.toString();
}
async function gitHead() {
  try {
    return (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  } catch {
    return null;
  }
}

/** Long runs: hours without WAN with a realistic restaurant, then reconnect under chaos. */
async function soak(ctx, report) {
  const { stand, r, traffic, profile } = ctx;
  const notes = { samples: [] };
  stand.wan.set(profile.wanFault);
  const started = Date.now();
  let nextShift = started + profile.shiftEveryMs,
    nextStaff = started + profile.staffEveryMs,
    restarted = false;
  while (Date.now() - started < profile.durationMs && !profile.signal?.aborted) {
    await ctx.hold(Math.min(profile.checkEveryMs, profile.durationMs - (Date.now() - started)));
    if (Date.now() >= nextStaff) {
      await stand.refreshStaff();
      nextStaff += profile.staffEveryMs;
    }
    if (Date.now() >= nextShift) {
      await r.closeAndReopenShift().catch((error) => traffic.record('shift', error));
      nextShift += profile.shiftEveryMs;
    }
    if (!restarted && Date.now() - started >= profile.durationMs * profile.edgeRestartAtShare) {
      // A Windows reboot in the middle of the offline day.
      for (const name of ['menu', 'pos', 'fulfillment', 'edge']) await stand.stop(name, 'SIGKILL');
      await sleep(5000);
      for (const name of ['edge', 'fulfillment', 'pos', 'menu']) await stand.start(name);
      restarted = true;
    }
    const view = await ctx.observe('wan_loss');
    const pending = await pendingWork(stand);
    notes.samples.push({
      minute: Math.round((Date.now() - started) / MINUTE),
      pos_sales: r.counters.pos_sales,
      kitchen_actions: r.counters.kitchen_actions,
      pending_pos_events: pending.pos_events,
      pending_kitchen_events: pending.kitchen_events,
      pos: view.pos,
      kitchen: view.kitchen,
      cloud_link: view.cloud_link,
    });
    report.progress = notes.samples.at(-1);
  }
  notes.offline_minutes = Math.round((Date.now() - started) / MINUTE);
  notes.backlog_at_reconnect = await pendingWork(stand);
  // Reconnect through a weak link: occasional lost answers, duplicates, late and reordered requests.
  const mark = await backlogMark(stand);
  stand.wan.set('chaos', profile.reconnectChaos);
  const reconnect = Date.now();
  const converge = await ctx.cleared(mark);
  stand.wan.set('up');
  converge.seconds = Math.round((Date.now() - reconnect) / 100) / 10;
  notes.convergence_seconds = converge.seconds;
  const kept = notes.samples.every(
    (s, i) => i === 0 || s.pos_sales >= notes.samples[i - 1].pos_sales,
  );
  return {
    notes,
    checks: [
      {
        id: 'soak_kept_working',
        title: 'Касса и кухня работали всё время без интернета',
        ok: kept && r.counters.pos_sales > 0 && r.counters.kitchen_actions > 0,
        expected: 'продажи и кухня в каждом интервале',
        actual: { pos_sales: r.counters.pos_sales, kitchen_actions: r.counters.kitchen_actions },
      },
      {
        id: 'soak_converged',
        title: `После ${notes.offline_minutes} мин без интернета всё сошлось за ${profile.convergeLimitS} с`,
        ok: converge.converged && converge.seconds <= profile.convergeLimitS,
        expected: `<= ${profile.convergeLimitS} с`,
        actual: `${converge.seconds} с`,
      },
    ],
  };
}

/** AC-17: N edge->cloud events accumulated offline, delivered with duplicates and lost answers. */
async function backlog(ctx) {
  const { stand, traffic, profile } = ctx;
  const saved = { ...traffic.rates };
  Object.assign(traffic.rates, { posPerMinute: 600, kitchenEveryMs: 500, kitchenShare: 1 });
  stand.wan.set('down');
  const started = Date.now();
  let pending = await pendingWork(stand);
  const size = (p) => p.pos_events + p.kitchen_events + p.cashier_reports;
  while (
    size(pending) < profile.backlogEvents &&
    Date.now() - started < profile.backlogTimeoutMs &&
    !profile.signal?.aborted
  ) {
    await ctx.hold(5000);
    pending = await pendingWork(stand);
  }
  Object.assign(traffic.rates, saved);
  const accumulated = size(pending);
  const mark = await backlogMark(stand);
  const reconnect = Date.now();
  stand.wan.set('chaos', profile.reconnectChaos);
  const before = stand.wan.stats();
  // The whole backlog is delivered through a weak link (duplicates, lost answers, late requests).
  const converge = await ctx.cleared(mark);
  const after = stand.wan.stats();
  stand.wan.set('up');
  const seconds = Math.round((Date.now() - reconnect) / 100) / 10;
  return {
    notes: {
      events_accumulated: accumulated,
      offline_seconds: Math.round((reconnect - started) / 1000),
      delivery_seconds: seconds,
      events_per_second: Math.round((accumulated / Math.max(seconds, 1)) * 10) / 10,
      injected: Object.fromEntries(
        ['dropped_response', 'duplicated', 'late', 'reordered', 'reset'].map((k) => [
          k,
          after[k] - before[k],
        ]),
      ),
    },
    checks: [
      {
        id: 'backlog_accumulated',
        title: `Без связи накоплено не меньше ${profile.backlogEvents} событий`,
        ok: accumulated >= profile.backlogEvents,
        expected: `>= ${profile.backlogEvents}`,
        actual: accumulated,
      },
      {
        id: 'backlog_converged',
        title: `Накопленные события доставлены с повторами и потерями ответов за ${profile.convergeLimitS} с`,
        ok: converge.converged && seconds <= profile.convergeLimitS,
        expected: `<= ${profile.convergeLimitS} с`,
        actual: `${seconds} с`,
      },
    ],
  };
}

/** After a hard kill (SIGKILL) the schemas of that run stay behind; Ctrl-C cleans up itself. */
async function cleanup() {
  const { createPool } = await import('@pickchick/database');
  const dropped = [];
  for (const [kind, raw] of [
    ['cloud', process.env.CLOUD_DATABASE_URL],
    ['edge', process.env.EDGE_DATABASE_URL],
    ['restore', defaultRestoreUrl()],
  ]) {
    const pool = createPool(checkedAdminUrl(raw, kind).toString(), 1);
    try {
      const names = (
        await pool.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'offstand\\_%'")
      ).rows.map((r) => r.nspname);
      for (const name of names.filter((n) => SCHEMA_PATTERN.test(n))) {
        await pool.query(`DROP SCHEMA ${name} CASCADE`);
        dropped.push(`${kind}:${name}`);
      }
    } catch (error) {
      if (error.code !== '3D000') throw error; // the restore database was never created
    } finally {
      await pool.end();
    }
  }
  console.log(JSON.stringify({ cleanup: dropped }));
  return { status: 'passed', dropped };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.cleanup) return cleanup();
  const profile = profileFor(options);
  const abort = new AbortController();
  profile.signal = abort.signal;
  // Stay installed until cleanup ends: a second Ctrl-C must not kill the run before it stops its
  // processes and drops its schemas (SIGKILL remains the hard stop; then use --cleanup).
  const onSignal = () => {
    if (abort.signal.aborted) console.error(JSON.stringify({ event: 'stopping_cleanup_running' }));
    abort.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
  const out = resolve(root, options.output ?? `.local/offline-stand/${runId}`);
  if (relative(root, out).startsWith('..'))
    throw new Error('--output must stay inside the repository');
  await mkdir(out, { recursive: true, mode: 0o700 });
  const order =
    options.scenarios ??
    (options.mode === 'ci'
      ? [...SCENARIO_ORDER.slice(0, 1), 'backlog', ...SCENARIO_ORDER.slice(1)]
      : options.mode === 'soak'
        ? ['baseline', 'soak']
        : ['baseline', 'backlog']);
  const report = {
    schema_version: 1,
    run_id: runId,
    mode: options.mode,
    seed: options.seed,
    status: 'running',
    started_at: new Date().toISOString(),
    source_commit: await gitHead(),
    machine: { cpus: cpus().length, memory_bytes: totalmem(), node: process.version },
    profile: { ...profile, signal: undefined },
    scenarios: [],
    known_issues: [],
  };
  const log = (entry) => console.error(JSON.stringify({ at: new Date().toISOString(), ...entry }));
  const stand = new Stand({
    runDir: out,
    cloudUrl: process.env.CLOUD_DATABASE_URL,
    edgeUrl: process.env.EDGE_DATABASE_URL,
    restoreUrl: options.noDocker ? null : defaultRestoreUrl(),
    seed: options.seed,
    log,
  });
  let traffic;
  const save = async () => {
    await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
    await writeFile(resolve(out, 'report.md'), renderMarkdown(report), { mode: 0o600 });
  };
  try {
    log({ event: 'stand_starting', out });
    const created = Date.now();
    await stand.create();
    report.stand = {
      schema: stand.schema,
      seconds_to_ready: Math.round((Date.now() - created) / 1000),
    };
    const restaurant = new Restaurant(stand, { random: seededRandom(options.seed) });
    traffic = new Traffic(restaurant, profile.rates);
    const ctx = new Context({ stand, restaurant, traffic, profile, log });
    traffic.start();
    for (const id of order) {
      if (abort.signal.aborted) break;
      const scenario =
        id === 'soak'
          ? { title: 'Длительная работа без интернета', run: (c) => soak(c, report) }
          : id === 'backlog'
            ? { title: 'AC-17: большой накопленный поток событий', run: backlog }
            : SCENARIOS[id];
      const started = Date.now();
      log({ event: 'scenario_started', id });
      const entry = { id, title: scenario.title, started_at: new Date().toISOString() };
      report.scenarios.push(entry);
      try {
        if (!traffic.running) traffic.start();
        const result = (await scenario.run(ctx)) ?? {};
        if (result.skipped) {
          Object.assign(entry, { status: 'skipped', reason: result.skipped });
          continue;
        }
        // Compare the ledgers only when nothing moves: traffic stopped, queues drained.
        await traffic.stop();
        const converge = await ctx.converge();
        const verified = await ctx.verify(result.context);
        Object.assign(entry, {
          notes: result.notes ?? {},
          checks: [...(result.checks ?? []), ...verified.checks],
          volumes: verified.volumes,
          final_convergence_seconds: converge.seconds,
        });
        if (!converge.converged)
          entry.checks.push({
            id: 'final_drain',
            title:
              'После сценария все очереди опустели, облако видит свежий heartbeat и тот же стоп-лист',
            ok: false,
            expected: 'всё доставлено',
            actual: { pending: converge.pending, fresh: converge.fresh, stops: converge.stops },
          });
        // A limitation the project already documents is reported, not hidden; only the checks
        // it explains are exempt, any other failure still fails the scenario.
        for (const issue of result.knownIssues ?? []) {
          report.known_issues.push({ scenario: id, ...issue });
          for (const c of entry.checks) {
            if (c.ok || !issue.checks.includes(c.id)) continue;
            const pending = c.details?.pending ?? c.actual?.pending;
            const explained =
              !pending ||
              Object.entries(pending).every(([k, v]) => v === 0 || issue.pendingKeys?.includes(k));
            if (explained) c.known = issue.id;
          }
        }
        entry.status = entry.checks.every((c) => c.ok || c.known)
          ? entry.checks.some((c) => c.known)
            ? 'known_issue'
            : 'passed'
          : 'failed';
      } catch (error) {
        Object.assign(entry, {
          status: 'error',
          error: { code: error.code ?? error.name, message: String(error.message).slice(0, 500) },
        });
        log({
          event: 'scenario_error',
          id,
          message: error.message,
          stack: String(error.stack).slice(0, 800),
        });
        await traffic.stop().catch(() => {});
        await ctx.converge().catch(() => {});
      } finally {
        entry.duration_seconds = Math.round((Date.now() - started) / 1000);
        entry.traffic_errors = traffic.errors.splice(0);
        if (entry.traffic_errors.length && entry.status === 'passed') entry.status = 'failed';
        log({
          event: 'scenario_finished',
          id,
          status: entry.status,
          seconds: entry.duration_seconds,
        });
        await save();
      }
    }
    // Staff must be able to tell "no internet" from "no local network" (launch-offline AC).
    const o = ctx.observations;
    if (o.normal && o.wan_loss && o.lan_loss) {
      const verdict = distinguishable({
        normal: o.normal.at(-1),
        wanLoss: o.wan_loss.at(-1),
        lanLoss: o.lan_loss.at(-1),
      });
      report.staff_view = {
        normal: o.normal.at(-1),
        wan_loss: o.wan_loss.at(-1),
        lan_loss: o.lan_loss.at(-1),
        verdict,
      };
      report.scenarios.push({
        id: 'staff_wan_vs_lan',
        title: 'Персонал различает потерю интернета и потерю локальной сети',
        status: verdict.ok ? 'passed' : 'failed',
        checks: [
          {
            id: 'staff_sees_wan_loss',
            title: 'Потеря интернета видна на кассе',
            ok: verdict.wanVisible,
            expected: true,
            actual: verdict.wanVisible,
          },
          {
            id: 'staff_sees_lan_loss',
            title: 'Потеря LAN видна на кухне',
            ok: verdict.lanVisible,
            expected: true,
            actual: verdict.lanVisible,
          },
          {
            id: 'staff_tells_apart',
            title: 'Экран при потере интернета отличается от экрана при потере LAN',
            ok: verdict.different,
            expected: true,
            actual: verdict.different,
          },
        ],
      });
    }
    report.restarts = stand.restarts;
    report.wan_faults = stand.wan.stats();
    report.lan_faults = stand.lan.stats();
    report.actors = {
      counters: restaurant.counters,
      traffic: traffic.stats,
      duplicate_payment_replays: restaurant.ledger.duplicatePaymentReplays,
    };
    report.status = abort.signal.aborted
      ? 'interrupted'
      : report.scenarios.every((s) => ['passed', 'skipped', 'known_issue'].includes(s.status))
        ? 'passed'
        : 'failed';
  } catch (error) {
    report.status = 'error';
    report.error = { code: error.code ?? error.name, message: String(error.message).slice(0, 500) };
  } finally {
    await traffic?.stop().catch(() => {});
    report.cleanup = await stand
      .close({ keep: options.keep })
      .catch((error) => ({ error: error.message }));
    report.finished_at = new Date().toISOString();
    report.duration_seconds = Math.round(
      (Date.parse(report.finished_at) - Date.parse(report.started_at)) / 1000,
    );
    await save();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  console.log(
    JSON.stringify({ status: report.status, report: relative(root, resolve(out, 'report.md')) }),
  );
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().then(
    (report) => {
      process.exitCode = report.status === 'passed' ? 0 : 1;
    },
    (error) => {
      console.error(JSON.stringify({ status: 'error', message: error.message }));
      process.exitCode = 2;
    },
  );
}
