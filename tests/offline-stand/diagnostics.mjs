/** Read-only, independent DB probes for long runs. No SQL text, URLs or row data in output. */
import { appendFile, readFile } from 'node:fs/promises';
import { freemem, loadavg } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setInterval, clearInterval } from 'node:timers';
import { resolve } from 'node:path';
import { createPool } from '@pickchick/database';

export const DIAGNOSTIC_SQL = `SELECT json_build_object(
  'sessions', (SELECT coalesce(json_agg(s),'[]'::json) FROM (
    SELECT pid, backend_type, state, wait_event_type, wait_event,
      extract(epoch FROM clock_timestamp()-xact_start)::float8 AS transaction_seconds,
      extract(epoch FROM clock_timestamp()-query_start)::float8 AS query_seconds,
      md5(query) AS query_hash, pg_blocking_pids(pid) AS blocked_by
    FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
    ORDER BY query_start NULLS LAST LIMIT 64) s),
  'database', (SELECT row_to_json(d) FROM (
    SELECT numbackends,xact_commit,xact_rollback,blks_read,blks_hit,temp_files,temp_bytes,
      deadlocks,blk_read_time,blk_write_time,sessions_abandoned,sessions_fatal,sessions_killed
    FROM pg_stat_database WHERE datname=current_database()) d),
  'locks', (SELECT count(*) FROM pg_locks WHERE NOT granted
    AND database=(SELECT oid FROM pg_database WHERE datname=current_database()))
) AS diagnostic`;

export const poolState = (pool) => ({
  total: pool.totalCount,
  idle: pool.idleCount,
  waiting: pool.waitingCount,
});
export const diagnosticError = (error) => ({
  // Driver error messages/detail can contain SQL or credentials. Keep SQLSTATE only.
  code: /^[0-9A-Z]{5}$/.test(error?.code ?? '') ? error.code : 'PROBE_ERROR',
});

export async function probeDatabase(pool) {
  const start = performance.now();
  try {
    const result = await pool.query(DIAGNOSTIC_SQL);
    return { ok: true, elapsed_ms: performance.now() - start, ...result.rows[0].diagnostic };
  } catch (error) {
    return { ok: false, elapsed_ms: performance.now() - start, ...diagnosticError(error) };
  }
}

async function cgroupCounters() {
  const result = {};
  for (const name of ['cpu.stat', 'memory.current', 'memory.max', 'memory.events']) {
    try {
      const value = await readFile('/sys/fs/cgroup/' + name, 'utf8');
      // Only numeric kernel counters. Never copy arbitrary file text into the report.
      if (/^(?:[a-z_]+ )?(?:\d+|max)(?:\n(?:[a-z_]+ )?\d+)*\n?$/.test(value))
        result[name] = value.trim();
    } catch {
      // Native macOS has no cgroup filesystem.
    }
  }
  return result;
}

export class Diagnostics {
  constructor(stand, { intervalMs = 30000, poolFactory = createPool, write = appendFile } = {}) {
    this.stand = stand;
    this.intervalMs = intervalMs;
    // Separate connections: an exhausted application pool must not prevent observation.
    this.pools = { cloud: poolFactory(stand.cloudUrl, 1), edge: poolFactory(stand.edgeUrl, 1) };
    this.write = write;
    this.delay = monitorEventLoopDelay({ resolution: 20 });
    this.started = performance.now();
    this.previous = this.started;
    this.samples = 0;
    this.writeErrors = 0;
    this.inFlight = null;
  }

  start() {
    this.delay.enable();
    this.timer = setInterval(() => void this.sample('interval'), this.intervalMs);
    this.timer.unref();
    return this.sample('start');
  }

  sample(reason) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.capture(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async capture(reason) {
    const now = performance.now();
    const entry = {
      observed_at: new Date().toISOString(),
      reason,
      elapsed_ms: now - this.started,
      interval_ms: now - this.previous,
      process_memory: process.memoryUsage(),
      process_cpu: process.cpuUsage(),
      host_free_memory_bytes: freemem(),
      host_load: loadavg(),
      loop_delay_max_ms: Number(this.delay.max) / 1e6,
      loop_delay_p99_ms: Number(this.delay.percentile(99)) / 1e6,
      pools: { cloud: poolState(this.stand.cloud), edge: poolState(this.stand.edge) },
    };
    this.previous = now;
    this.delay.reset();
    const [cloud, edge, cgroup] = await Promise.all([
      probeDatabase(this.pools.cloud),
      probeDatabase(this.pools.edge),
      cgroupCounters(),
    ]);
    Object.assign(entry, { cloud, edge, cgroup });
    try {
      await this.write(
        resolve(this.stand.runDir, 'diagnostics.jsonl'),
        JSON.stringify(entry) + '\n',
        { mode: 0o600 },
      );
      this.samples++;
    } catch {
      this.writeErrors++;
    }
    return entry;
  }

  async stop() {
    clearInterval(this.timer);
    await this.inFlight;
    await this.sample('stop');
    this.delay.disable();
    await Promise.allSettled(Object.values(this.pools).map((pool) => pool.end()));
    return { samples: this.samples, write_errors: this.writeErrors, file: 'diagnostics.jsonl' };
  }
}
