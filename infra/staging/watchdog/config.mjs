// Watchdog settings from the private 0600 env file. Errors name the variable, never its value.

export class WatchdogConfigError extends Error {
  constructor(variable) {
    super('WATCHDOG_CONFIG_INVALID');
    this.variable = variable;
  }
}

const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;

function text(env, name, fallback) {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
}

function flag(env, name, fallback) {
  const value = text(env, name, fallback ? 'true' : 'false');
  if (value !== 'true' && value !== 'false') throw new WatchdogConfigError(name);
  return value === 'true';
}

function integer(env, name, fallback, min, max) {
  const value = text(env, name, String(fallback));
  if (!/^[0-9]{1,6}$/.test(value)) throw new WatchdogConfigError(name);
  const number = Number(value);
  if (number < min || number > max) throw new WatchdogConfigError(name);
  return number;
}

function pattern(env, name, fallback, regex) {
  const value = text(env, name, fallback);
  if (typeof value !== 'string' || !regex.test(value)) throw new WatchdogConfigError(name);
  return value;
}

function timeZone(env, name, fallback) {
  const value = text(env, name, fallback);
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
  } catch {
    throw new WatchdogConfigError(name);
  }
  return value;
}

/** "23:30-08:30" in the configured time zone; empty disables quiet hours. */
export function parseQuietHours(value, name = 'WATCHDOG_HEARTBEAT_QUIET_HOURS') {
  if (value === undefined || value === '') return null;
  const [start, end, extra] = value.split('-');
  if (extra !== undefined || !TIME.test(start ?? '') || !TIME.test(end ?? '') || start === end)
    throw new WatchdogConfigError(name);
  return { start, end };
}

function readyUrl(env) {
  const name = 'WATCHDOG_API_READY_URL';
  const value = text(env, name, 'http://api:3100/health/ready');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WatchdogConfigError(name);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new WatchdogConfigError(name);
  return url.href;
}

/** Pure parser; secrets stay inside the returned object and are never logged by callers. */
export function loadWatchdogConfig(env) {
  const telegramEnabled = flag(env, 'WATCHDOG_TELEGRAM_ENABLED', false);
  const telegram = { enabled: telegramEnabled, token: null, chatId: null };
  if (telegramEnabled) {
    telegram.token = pattern(
      env,
      'WATCHDOG_TELEGRAM_BOT_TOKEN',
      '',
      /^[0-9]{5,16}:[A-Za-z0-9_-]{30,64}$/,
    );
    telegram.chatId = pattern(env, 'WATCHDOG_TELEGRAM_CHAT_ID', '', /^-?[0-9]{1,20}$/);
  }
  const warnPercent = integer(env, 'WATCHDOG_DISK_WARN_PERCENT', 85, 50, 99);
  const criticalPercent = integer(env, 'WATCHDOG_DISK_CRITICAL_PERCENT', 95, 51, 100);
  if (criticalPercent <= warnPercent)
    throw new WatchdogConfigError('WATCHDOG_DISK_CRITICAL_PERCENT');
  return {
    label: pattern(env, 'WATCHDOG_LABEL', 'PickChick staging', /^[\p{L}\p{N} ._-]{1,40}$/u),
    timeZone: timeZone(env, 'WATCHDOG_TIMEZONE', 'Asia/Almaty'),
    telegram,
    apiReadyUrl: readyUrl(env),
    db: {
      host: pattern(env, 'WATCHDOG_DB_HOST', 'cloud-db', /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/),
      port: integer(env, 'WATCHDOG_DB_PORT', 5432, 1, 65535),
      database: pattern(env, 'WATCHDOG_DB_NAME', 'pickchick_cloud', /^[a-z][a-z0-9_]{0,62}$/),
      user: pattern(env, 'WATCHDOG_DB_USER', 'pickchick_watchdog', /^[a-z][a-z0-9_]{0,62}$/),
      password: pattern(env, 'WATCHDOG_DB_PASSWORD', '', /^[a-f0-9]{64}$/),
    },
    renotifyMinutes: integer(env, 'WATCHDOG_RENOTIFY_MINUTES', 120, 15, 10080),
    confirmRuns: {
      api: integer(env, 'WATCHDOG_API_CONFIRM_RUNS', 2, 1, 12),
      container: integer(env, 'WATCHDOG_CONTAINER_CONFIRM_RUNS', 2, 1, 12),
      workerErrors: integer(env, 'WATCHDOG_WORKER_ERROR_CONFIRM_RUNS', 2, 1, 12),
    },
    heartbeat: {
      staleMinutes: integer(env, 'WATCHDOG_HEARTBEAT_STALE_MINUTES', 10, 1, 1440),
      quietHours: parseQuietHours(env.WATCHDOG_HEARTBEAT_QUIET_HOURS),
    },
    identityWarnDays: integer(env, 'WATCHDOG_IDENTITY_WARN_DAYS', 7, 1, 60),
    backupMaxAgeHours: integer(env, 'WATCHDOG_BACKUP_MAX_AGE_HOURS', 26, 1, 720),
    disk: { warnPercent, criticalPercent },
    paymentBacklogMinutes: integer(env, 'WATCHDOG_PAYMENT_BACKLOG_MINUTES', 3, 1, 59),
    factsMaxAgeMinutes: integer(env, 'WATCHDOG_FACTS_MAX_AGE_MINUTES', 15, 1, 1440),
    expect: {
      'kaspi-bridge': flag(env, 'WATCHDOG_EXPECT_KASPI_BRIDGE', true),
      'kaspi-remote-worker': flag(env, 'WATCHDOG_EXPECT_KASPI_REMOTE_WORKER', true),
      'kiosk-qr-worker': flag(env, 'WATCHDOG_EXPECT_KIOSK_QR_WORKER', true),
    },
    dailySummary: {
      enabled: flag(env, 'WATCHDOG_DAILY_SUMMARY', false),
      hour: integer(env, 'WATCHDOG_DAILY_SUMMARY_HOUR', 9, 0, 23),
    },
  };
}
