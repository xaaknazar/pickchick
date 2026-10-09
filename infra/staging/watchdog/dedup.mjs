// De-duplication: first alert after N consecutive failing runs, reminders every renotify
// interval, one escalation when severity rises, one recovery message. Pure functions.
import { localDay } from './format.mjs';

export const STATE_VERSION = 1;
const SEVERITY_RANK = { warning: 1, critical: 2 };
const SOURCES = ['api', 'docker', 'logs', 'host', 'db', 'self'];
const KEY = /^[a-z][a-z0-9._/-]{0,160}$/;

export function emptyState(delivery) {
  return { version: STATE_VERSION, delivery, checks: {}, lastSummaryDay: null };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

/**
 * Accepts only a well-formed previous state of the same delivery mode. Switching from the
 * print (shadow) mode to Telegram starts clean, so every open problem is announced once.
 */
export function normalizeState(raw, delivery) {
  if (
    !isObject(raw) ||
    raw.version !== STATE_VERSION ||
    raw.delivery !== delivery ||
    !isObject(raw.checks)
  )
    return emptyState(delivery);
  const checks = {};
  for (const [key, entry] of Object.entries(raw.checks)) {
    if (!KEY.test(key) || !isObject(entry)) continue;
    const since = time(entry.since);
    if (
      since === null ||
      !SOURCES.includes(entry.source) ||
      !(entry.severity in SEVERITY_RANK) ||
      !Number.isSafeInteger(entry.consecutive) ||
      entry.consecutive < 1 ||
      typeof entry.title !== 'string' ||
      typeof entry.detail !== 'string'
    )
      continue;
    const notifiedAt = time(entry.notifiedAt);
    checks[key] = {
      source: entry.source,
      title: entry.title.slice(0, 200),
      detail: entry.detail.slice(0, 600),
      severity: entry.severity,
      since,
      consecutive: entry.consecutive,
      notifiedAt,
      lastNotifiedAt: notifiedAt === null ? null : (time(entry.lastNotifiedAt) ?? notifiedAt),
      notifiedSeverity:
        notifiedAt === null
          ? null
          : entry.notifiedSeverity in SEVERITY_RANK
            ? entry.notifiedSeverity
            : entry.severity,
    };
  }
  return {
    version: STATE_VERSION,
    delivery,
    checks,
    lastSummaryDay:
      typeof raw.lastSummaryDay === 'string' &&
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(raw.lastSummaryDay)
        ? raw.lastSummaryDay
        : null,
  };
}

/**
 * @returns {{events: Array<{kind: 'alert'|'escalation'|'reminder'|'recovery'|'resolved',
 *   key: string, title: string, detail: string, severity: string, since: number}>, state: object}}
 */
export function planNotifications(previous, evaluation, nowMs, { renotifyMinutes }) {
  const renotifyMs = renotifyMinutes * 60_000;
  const checks = {};
  const events = [];
  const seen = new Set();
  for (const finding of evaluation.findings) {
    seen.add(finding.key);
    const prior = previous.checks[finding.key];
    if (finding.status === 'skip') {
      if (prior) checks[finding.key] = prior;
      continue;
    }
    if (finding.status === 'ok') {
      if (prior?.notifiedAt)
        events.push({
          kind: 'recovery',
          key: finding.key,
          title: finding.title,
          detail: finding.detail,
          severity: prior.severity,
          since: prior.since,
        });
      continue;
    }
    const entry = {
      source: finding.source,
      title: finding.title,
      detail: finding.detail,
      severity: finding.severity,
      since: prior?.since ?? nowMs,
      consecutive: (prior?.consecutive ?? 0) + 1,
      notifiedAt: prior?.notifiedAt ?? null,
      lastNotifiedAt: prior?.lastNotifiedAt ?? null,
      notifiedSeverity: prior?.notifiedSeverity ?? null,
    };
    let kind = null;
    if (entry.notifiedAt === null) {
      if (entry.consecutive >= finding.confirmRuns) kind = 'alert';
    } else if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[entry.notifiedSeverity]) {
      kind = 'escalation';
    } else if (nowMs - entry.lastNotifiedAt >= renotifyMs) {
      kind = 'reminder';
    }
    if (kind) {
      events.push({
        kind,
        key: finding.key,
        title: finding.title,
        detail: finding.detail,
        severity: finding.severity,
        since: entry.since,
      });
      entry.notifiedAt ??= nowMs;
      entry.lastNotifiedAt = nowMs;
      if (kind !== 'reminder') entry.notifiedSeverity = finding.severity;
    }
    checks[finding.key] = entry;
  }
  for (const [key, prior] of Object.entries(previous.checks)) {
    if (seen.has(key)) continue;
    // The input that produced it is unreadable now: neither recovered nor re-alerted.
    if (evaluation.unavailable.has(prior.source)) {
      checks[key] = prior;
      continue;
    }
    if (prior.notifiedAt)
      events.push({
        kind: 'resolved',
        key,
        title: prior.title,
        detail: 'больше не наблюдается (устройство или проверка сняты с контроля)',
        severity: prior.severity,
        since: prior.since,
      });
  }
  const order = { alert: 0, escalation: 0, reminder: 1, recovery: 2, resolved: 2 };
  events.sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.key.localeCompare(b.key),
  );
  return { events, state: { ...previous, checks } };
}

/** Once per local day at or after the configured hour (or when forced). */
export function summaryDue(state, nowMs, config, forced = false) {
  const { day, hour } = localDay(nowMs, config.timeZone);
  if (forced) return day;
  if (!config.dailySummary.enabled || hour < config.dailySummary.hour) return null;
  return state.lastSummaryDay === day ? null : day;
}
