// Re-validates the JSON written by run-watchdog.py. Only whitelisted fields of known types
// survive; anything else (including unexpected log content) is dropped, never echoed.

export const CONTAINER_ROLES = Object.freeze([
  'kaspi-bridge',
  'kaspi-remote-worker',
  'kiosk-qr-worker',
]);
export const WORKER_EVENTS = Object.freeze({
  'kaspi-remote-worker': Object.freeze([
    'kaspi_remote',
    'kaspi_remote_attention',
    'kaspi_remote_failed',
  ]),
  'kiosk-qr-worker': Object.freeze([
    'kiosk_kaspi_qr',
    'kiosk_kaspi_qr_attention',
    'kiosk_kaspi_qr_failed',
  ]),
});
/**
 * Kitchen admission health (PM interface ful -> ops, 19.10). Read only when the fulfillment
 * worker runs in a container on this host (WATCHDOG_FULFILLMENT_CONTAINER); the Windows cashier
 * worker is covered by the database check of unacknowledged kitchen events instead.
 */
export const FULFILLMENT_EVENTS = Object.freeze(['fulfillment_transport_attention']);
/** Reason codes of kaspi_remote_attention (pay lane, KaspiAttention). Anything else is dropped. */
export const KASPI_REASONS = Object.freeze([
  'session_inactive',
  'session_missing',
  'session_rejected',
  'bridge_unreachable',
  'unknown_overdue',
  'invoice_not_sent',
  'worker_errors',
]);
const BACKUP_STAGES = [
  'config',
  'counts',
  'dump',
  'encrypt',
  'manifest',
  'offsite',
  'base_backup',
  'retention',
  'wal_ship',
  'unknown',
];
const CONTAINER_STATES = [
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
];
const HEALTH = ['starting', 'healthy', 'unhealthy'];
const WORKER_STATES = ['disabled', 'no_cashier_session'];
const PROBE_REASONS = [
  'verified',
  'not_verified',
  'unavailable',
  'missing_session',
  'probe_failed',
];
const COLLECTOR_ERRORS = ['docker_unavailable', 'logs_unavailable', 'probe_unavailable'];
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/;
const PATH = /^\/[A-Za-z0-9._/-]{0,200}$/;
const BACKUP = /^cloud-[0-9]{8}T[0-9]{6}Z\.dump\.age$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = (value) =>
  typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));
const count = (value, max = 1_000_000) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
const finite = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;

function container(raw) {
  if (!isObject(raw) || raw.present !== true) return { present: false };
  const status = CONTAINER_STATES.includes(raw.status) ? raw.status : null;
  return {
    present: true,
    status,
    running: raw.running === true && status === 'running',
    health: HEALTH.includes(raw.health) ? raw.health : null,
    restarts: count(raw.restarts) ?? 0,
    startedAt: iso(raw.startedAt) ? raw.startedAt : null,
  };
}

/** One worker log event; the JSON printed by kaspi-remote-worker.ts / kiosk-kaspi-qr-worker.ts. */
export function workerEvent(role, raw) {
  if (!isObject(raw) || !iso(raw.at) || !WORKER_EVENTS[role]?.includes(raw.event)) return null;
  const event = { at: raw.at, event: raw.event };
  for (const key of [
    'errors',
    'unknownOverdue',
    'submitted',
    'checked',
    'pendingUnsent',
    'oldestUnsentSeconds',
  ]) {
    const value = count(raw[key]);
    if (value !== null) event[key] = value;
  }
  // An explicit false (a tick that reached the bank, or the recovery line) clears the problem.
  if (raw.sessionProblem === true || raw.sessionRejected === true) event.sessionProblem = true;
  else if (raw.sessionProblem === false || raw.sessionRejected === false)
    event.sessionProblem = false;
  if (raw.recovered === true) event.recovered = true;
  if (KASPI_REASONS.includes(raw.reason)) event.reason = raw.reason;
  if (WORKER_STATES.includes(raw.state)) event.state = raw.state;
  return event;
}

const REASON_CODE = /^[A-Z][A-Z0-9_]{0,40}$/;

/** One `fulfillment_transport_attention` line: counts and reason codes only. */
export function fulfillmentEvent(raw) {
  if (!isObject(raw) || !iso(raw.at) || !FULFILLMENT_EVENTS.includes(raw.event)) return null;
  const event = { at: raw.at, event: raw.event };
  if (raw.recovered === true) {
    event.recovered = true;
    return event;
  }
  for (const key of ['deferred', 'parked', 'unresolvedFailures']) {
    const value = count(raw[key]);
    if (value !== null) event[key] = value;
  }
  if (isObject(raw.reasons)) {
    const reasons = {};
    for (const [code, value] of Object.entries(raw.reasons).slice(0, 8))
      if (REASON_CODE.test(code) && count(value) !== null) reasons[code] = value;
    if (Object.keys(reasons).length) event.reasons = reasons;
  }
  return event;
}

function disk(raw) {
  if (!isObject(raw) || typeof raw.path !== 'string' || !PATH.test(raw.path)) return null;
  const usedPercent = finite(raw.usedPercent, 0, 100);
  if (usedPercent === null) return { path: raw.path, error: 'unavailable' };
  return {
    path: raw.path,
    usedPercent,
    sizeBytes: count(raw.sizeBytes, Number.MAX_SAFE_INTEGER),
    availBytes: count(raw.availBytes, Number.MAX_SAFE_INTEGER),
  };
}

function backups(raw) {
  if (!isObject(raw) || raw.error !== undefined || !Array.isArray(raw.files))
    return { error: 'unavailable', files: [], status: null, offsite: null, wal: null };
  const files = raw.files
    .filter(
      (file) =>
        isObject(file) &&
        typeof file.name === 'string' &&
        BACKUP.test(file.name) &&
        iso(file.mtime) &&
        count(file.sizeBytes, Number.MAX_SAFE_INTEGER) !== null,
    )
    .map((file) => ({
      name: file.name,
      mtime: file.mtime,
      sizeBytes: file.sizeBytes,
      checksum: file.checksum === true,
    }));
  return {
    files,
    status: backupStatus(raw.status),
    offsite: offsiteStatus(raw.offsite),
    wal: walStatus(raw.wal),
  };
}

const time = (value) => (iso(value) ? value : null);

/** backup-status.json written by backup.sh: last attempt, last success, failed stage. */
function backupStatus(raw) {
  if (!isObject(raw) || !iso(raw.lastAttemptAt)) return null;
  return {
    lastAttemptAt: raw.lastAttemptAt,
    lastSuccessAt: time(raw.lastSuccessAt),
    ok: raw.ok === true,
    stage: raw.ok === true ? null : BACKUP_STAGES.includes(raw.stage) ? raw.stage : 'unknown',
  };
}

/** offsite-status.json written by backup-offsite.py after each upload attempt. */
function offsiteStatus(raw) {
  if (!isObject(raw) || !iso(raw.lastAttemptAt)) return null;
  return {
    enabled: raw.enabled === true,
    lastAttemptAt: raw.lastAttemptAt,
    lastSuccessAt: time(raw.lastSuccessAt),
    ok: raw.ok === true,
    sizeBytes: count(raw.sizeBytes, Number.MAX_SAFE_INTEGER),
  };
}

/** wal-status.json written by `backup-offsite.py ship-wal` on every run (PITR option). */
function walStatus(raw) {
  if (!isObject(raw) || !iso(raw.checkedAt)) return null;
  return {
    checkedAt: raw.checkedAt,
    ok: raw.ok === true,
    pending: count(raw.pending) ?? 0,
    oldestPendingAt: time(raw.oldestPendingAt),
    lastShippedAt: time(raw.lastShippedAt),
    lastBaseBackupAt: time(raw.lastBaseBackupAt),
  };
}

function probe(raw) {
  if (!isObject(raw) || !iso(raw.checkedAt)) return null;
  return {
    checkedAt: raw.checkedAt,
    active: typeof raw.active === 'boolean' ? raw.active : null,
    reason: PROBE_REASONS.includes(raw.reason) ? raw.reason : 'probe_failed',
  };
}

/** {ok:true,facts} or {ok:false,reason:'missing'|'invalid'|'stale'}; never throws. */
export function parseHostFacts(text, nowMs, maxAgeMs) {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, reason: 'missing' };
  if (text.length > 2_000_000) return { ok: false, reason: 'invalid' };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isObject(raw) || raw.version !== 1 || !iso(raw.collectedAt))
    return { ok: false, reason: 'invalid' };
  const age = nowMs - Date.parse(raw.collectedAt);
  if (age > maxAgeMs || age < -5 * 60_000) return { ok: false, reason: 'stale' };
  const containers = {};
  const workerEvents = {};
  for (const role of CONTAINER_ROLES) containers[role] = container(raw.containers?.[role]);
  for (const role of Object.keys(WORKER_EVENTS)) {
    const list = Array.isArray(raw.workerEvents?.[role]) ? raw.workerEvents[role] : [];
    workerEvents[role] = list
      .slice(-500)
      .map((item) => workerEvent(role, item))
      .filter(Boolean);
  }
  return {
    ok: true,
    facts: {
      collectedAt: raw.collectedAt,
      logWindowSeconds: count(raw.logWindowSeconds, 86_400) ?? 600,
      collectorErrors: Array.isArray(raw.collectorErrors)
        ? [...new Set(raw.collectorErrors.filter((code) => COLLECTOR_ERRORS.includes(code)))]
        : [],
      containers,
      workerEvents,
      fulfillmentEvents: (Array.isArray(raw.fulfillmentEvents) ? raw.fulfillmentEvents : [])
        .slice(-200)
        .map(fulfillmentEvent)
        .filter(Boolean),
      fulfillmentCollected: raw.fulfillmentCollected === true,
      disks: (Array.isArray(raw.disks) ? raw.disks.slice(0, 16) : []).map(disk).filter(Boolean),
      backups: backups(raw.backups),
      kaspiSessionProbe: probe(raw.kaspiSessionProbe),
    },
  };
}
