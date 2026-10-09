// Pure evaluation: facts + thresholds + time -> findings. No I/O, no secrets.
import { bytes, clock, duration, withinQuietHours } from './format.mjs';
import { CONTAINER_ROLES, WORKER_EVENTS } from './host-facts.mjs';

export const CONTAINER_TITLES = Object.freeze({
  'kaspi-bridge': 'Kaspi мост (pickchick-kaspi-bridge)',
  'kaspi-remote-worker': 'Kaspi worker счетов (pickchick-kaspi-worker)',
  'kiosk-qr-worker': 'Kaspi QR worker киоска (pickchick-kiosk-kaspi-qr-worker)',
});
export const WORKER_TITLES = Object.freeze({
  'kaspi-remote-worker': 'Kaspi worker счетов',
  'kiosk-qr-worker': 'Kaspi QR worker киоска',
});

/**
 * status: ok | fail | skip (skip = cannot judge now; keep any open alert unchanged).
 * source: which input produced it; an unavailable source keeps its previous alerts open.
 */
function result(key, source, title, status, severity, detail, confirmRuns = 1) {
  return { key, source, title, status, severity, detail, confirmRuns };
}
const ok = (key, source, title, detail) => result(key, source, title, 'ok', 'warning', detail);
const skip = (key, source, title, detail) => result(key, source, title, 'skip', 'warning', detail);

function apiFinding(api, config) {
  const title = 'API /health/ready';
  if (api.ok) return ok('api.ready', 'api', title, 'готов');
  const reason =
    api.error === 'timeout'
      ? 'нет ответа за 5 с'
      : api.error
        ? 'недоступен по сети'
        : `HTTP ${api.status}`;
  const deps = api.dependencies
    ? ` (${Object.entries(api.dependencies)
        .map(([name, state]) => `${name}=${state}`)
        .join(', ')})`
    : '';
  return result(
    'api.ready',
    'api',
    title,
    'fail',
    'critical',
    reason + deps,
    config.confirmRuns.api,
  );
}

function containerFinding(role, info, config) {
  const key = `container.${role}`;
  const title = CONTAINER_TITLES[role];
  const runs = config.confirmRuns.container;
  if (!info.present)
    return result(key, 'docker', title, 'fail', 'critical', 'контейнер не найден', runs);
  if (!info.running)
    return result(
      key,
      'docker',
      title,
      'fail',
      'critical',
      `состояние ${info.status ?? 'неизвестно'}, перезапусков ${info.restarts}`,
      runs,
    );
  if (info.health === 'unhealthy')
    return result(key, 'docker', title, 'fail', 'critical', 'healthcheck unhealthy', runs);
  const since = info.startedAt ? ` с ${clock(Date.parse(info.startedAt), config.timeZone)}` : '';
  return ok(key, 'docker', title, `работает${since}, перезапусков ${info.restarts}`);
}

/** Folds the attention/failed/tick lines the workers already print (no extra bank calls). */
export function aggregateWorkerEvents(events) {
  const summary = {
    sessionProblemAt: null,
    errorEvents: 0,
    unknownOverdue: 0,
    disabled: false,
    events: 0,
  };
  for (const event of events) {
    summary.events++;
    if (event.sessionProblem || event.state === 'no_cashier_session')
      summary.sessionProblemAt = event.at;
    if (event.event.endsWith('_failed') || (event.errors ?? 0) > 0) summary.errorEvents++;
    summary.unknownOverdue = Math.max(summary.unknownOverdue, event.unknownOverdue ?? 0);
    if (event.state === 'disabled') summary.disabled = true;
  }
  return summary;
}

function sessionFinding(workers, probe, config, nowMs) {
  const key = 'kaspi.session';
  const title = 'Сессия кассира Kaspi';
  const reasons = [];
  for (const [role, summary] of Object.entries(workers))
    if (summary.sessionProblemAt)
      reasons.push(
        `${WORKER_TITLES[role]} сообщил о проблеме сессии ${clock(Date.parse(summary.sessionProblemAt), config.timeZone)}`,
      );
  if (probe?.active === false)
    reasons.push(
      `проверка session-check.mjs ${clock(Date.parse(probe.checkedAt), config.timeZone)}: ${probe.reason}`,
    );
  if (reasons.length)
    return result(
      key,
      'logs',
      title,
      'fail',
      'critical',
      `${reasons.join('; ')}. Нужен повторный вход кассира (kaspi-login.mjs) и перезапуск worker.`,
    );
  const quiet = Object.values(workers).every((summary) => summary.events === 0);
  if (probe?.active === true)
    return ok(
      key,
      'logs',
      title,
      `активна по session-check.mjs ${duration(nowMs - Date.parse(probe.checkedAt))} назад`,
    );
  return ok(
    key,
    'logs',
    title,
    quiet ? 'нет событий worker за окно (не проверялась)' : 'worker не сообщал о проблемах',
  );
}

function workerErrorFinding(role, summary, config, windowSeconds) {
  const key = `worker.${role}.errors`;
  const title = `${WORKER_TITLES[role]}: ошибки`;
  if (summary.disabled)
    return result(
      key,
      'logs',
      title,
      'fail',
      'warning',
      'worker запущен с выключенной конфигурацией (disabled)',
      config.confirmRuns.workerErrors,
    );
  if (summary.errorEvents > 0)
    return result(
      key,
      'logs',
      title,
      'fail',
      'warning',
      `событий с ошибками за ${Math.round(windowSeconds / 60)} мин: ${summary.errorEvents}`,
      config.confirmRuns.workerErrors,
    );
  return ok(key, 'logs', title, 'ошибок нет');
}

function unknownFinding(role, dbCount, logCount) {
  const key = `worker.${role}.unknown`;
  const title = `${WORKER_TITLES[role]}: счета без ответа банка`;
  if (dbCount === null && logCount === 0) return skip(key, 'db', title, 'нет данных');
  const value = Math.max(dbCount ?? 0, logCount);
  if (value > 0)
    return result(
      key,
      'db',
      title,
      'fail',
      'critical',
      `счетов в статусе issuing/unknown дольше 5 мин: ${value}. Проверить в Kaspi Pay вручную, повторный счёт не создавать.`,
    );
  return ok(key, 'db', title, 'нет');
}

function backlogFinding(role, value, minutes) {
  const key = `worker.${role}.backlog`;
  const title = `${WORKER_TITLES[role]}: оплаты ждут отправки в банк`;
  if (value > 0)
    return result(
      key,
      'db',
      title,
      'fail',
      'warning',
      `заказов ждут счёта дольше ${minutes} мин: ${value}. Возможные причины: сессия кассира, пульс кассы, стоп-лист, остановленный worker.`,
    );
  return ok(key, 'db', title, 'очереди нет');
}

function heartbeatFinding(row, config, nowMs) {
  const key = `edge.heartbeat.${row.deviceId}`;
  const title = `Пульс кассы "${row.name}"`;
  const limit = config.heartbeat.staleMinutes * 60;
  if (withinQuietHours(config.heartbeat.quietHours, nowMs, config.timeZone))
    return skip(key, 'db', title, 'ночное окно');
  if (row.ageSeconds === null)
    return result(key, 'db', title, 'fail', 'critical', 'касса ещё не передавала пульс в облако');
  if (row.ageSeconds > limit)
    return result(
      key,
      'db',
      title,
      'fail',
      'critical',
      `последний пульс ${duration(row.ageSeconds * 1000)} назад (${clock(Date.parse(row.observedAt), config.timeZone)}), лимит ${config.heartbeat.staleMinutes} мин. Оплата в приложении и киоске блокируется.`,
    );
  return ok(key, 'db', title, `пульс ${row.ageSeconds} с назад`);
}

function identityFinding(row, config) {
  const key = `device.identity.${row.deviceId}`;
  const title = `Ключ устройства "${row.name}" (${row.kind})`;
  const at = clock(Date.parse(row.expiresAt), config.timeZone);
  if (row.remainingSeconds <= 0)
    return result(
      key,
      'db',
      title,
      'fail',
      'critical',
      `срок истёк ${at}; нужна ротация ключа устройства`,
    );
  if (row.remainingSeconds < config.identityWarnDays * 86_400)
    return result(
      key,
      'db',
      title,
      'fail',
      'warning',
      `истекает ${at} (через ${duration(row.remainingSeconds * 1000)}); запланировать ротацию`,
    );
  return ok(key, 'db', title, `действует до ${at}`);
}

function backupFinding(backups, config, nowMs) {
  const key = 'backup.age';
  const title = 'Резервная копия БД';
  if (backups.error)
    return result(key, 'host', title, 'fail', 'critical', 'каталог копий недоступен мониторингу');
  const completed = backups.files
    .filter((file) => file.checksum && file.sizeBytes > 0)
    .sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
  if (!completed.length)
    return result(
      key,
      'host',
      title,
      'fail',
      'critical',
      'нет ни одной завершённой копии (.dump.age и .sha256)',
    );
  const newest = completed[0];
  const age = nowMs - Date.parse(newest.mtime);
  if (age > config.backupMaxAgeHours * 3_600_000)
    return result(
      key,
      'host',
      title,
      'fail',
      'critical',
      `последняя копия ${duration(age)} назад (${clock(Date.parse(newest.mtime), config.timeZone)}), лимит ${config.backupMaxAgeHours} ч. Проверить journalctl -u pickchick-backup.service.`,
    );
  return ok(
    key,
    'host',
    title,
    `последняя копия ${duration(age)} назад, ${bytes(newest.sizeBytes)}`,
  );
}

function diskFinding(disk, config) {
  const key = `disk.${disk.path}`;
  const title = `Диск ${disk.path}`;
  if (disk.error)
    return result(key, 'host', title, 'fail', 'warning', 'не удалось прочитать заполненность');
  const detail = `занято ${disk.usedPercent.toFixed(1)}%, свободно ${bytes(disk.availBytes)}`;
  if (disk.usedPercent > config.disk.criticalPercent)
    return result(
      key,
      'host',
      title,
      'fail',
      'critical',
      `${detail} (лимит ${config.disk.criticalPercent}%)`,
    );
  if (disk.usedPercent > config.disk.warnPercent)
    return result(
      key,
      'host',
      title,
      'fail',
      'warning',
      `${detail} (лимит ${config.disk.warnPercent}%)`,
    );
  return ok(key, 'host', title, detail);
}

const HOST_REASONS = { missing: 'отсутствуют', invalid: 'повреждены', stale: 'устарели' };

/**
 * @param {{api: object, host: {ok: boolean, facts?: object, reason?: string},
 *   db: {ok: boolean, facts?: object, code?: string}, config: object, nowMs: number}} input
 */
export function evaluate({ api, host, db, config, nowMs }) {
  const findings = [apiFinding(api, config)];
  const unavailable = new Set();
  const collectorErrors = host.ok ? host.facts.collectorErrors : [];
  if (!host.ok) for (const source of ['host', 'docker', 'logs']) unavailable.add(source);
  if (collectorErrors.includes('docker_unavailable')) unavailable.add('docker').add('logs');
  if (collectorErrors.includes('logs_unavailable')) unavailable.add('logs');
  if (!db.ok) unavailable.add('db');

  findings.push(
    host.ok && !collectorErrors.length
      ? ok('watchdog.host', 'self', 'Мониторинг: данные хоста', 'собраны')
      : result(
          'watchdog.host',
          'self',
          'Мониторинг: данные хоста',
          'fail',
          'warning',
          host.ok
            ? `сбой сборщика: ${collectorErrors.join(', ')}`
            : `данные хоста ${HOST_REASONS[host.reason] ?? host.reason}`,
        ),
  );
  findings.push(
    db.ok
      ? ok('watchdog.database', 'self', 'Мониторинг: чтение БД', 'роль pickchick_watchdog работает')
      : result(
          'watchdog.database',
          'self',
          'Мониторинг: чтение БД',
          'fail',
          'warning',
          `ошибка ${db.code}`,
        ),
  );

  const facts = host.ok ? host.facts : null;
  if (facts && !unavailable.has('docker'))
    for (const role of CONTAINER_ROLES)
      if (config.expect[role] || facts.containers[role].present)
        findings.push(containerFinding(role, facts.containers[role], config));

  const workers = {};
  for (const role of Object.keys(WORKER_EVENTS))
    workers[role] = aggregateWorkerEvents(
      facts && !unavailable.has('logs') ? facts.workerEvents[role] : [],
    );
  if (facts && !unavailable.has('logs')) {
    findings.push(sessionFinding(workers, facts.kaspiSessionProbe, config, nowMs));
    for (const role of Object.keys(WORKER_EVENTS))
      if (config.expect[role] || workers[role].events)
        findings.push(workerErrorFinding(role, workers[role], config, facts.logWindowSeconds));
  }
  for (const role of Object.keys(WORKER_EVENTS)) {
    findings.push(
      unknownFinding(
        role,
        db.ok ? db.facts.unknownOverdue[role] : null,
        workers[role].unknownOverdue,
      ),
    );
    if (db.ok)
      findings.push(
        backlogFinding(role, db.facts.paymentBacklog[role], config.paymentBacklogMinutes),
      );
  }
  if (db.ok) {
    for (const row of db.facts.heartbeats) findings.push(heartbeatFinding(row, config, nowMs));
    for (const row of db.facts.identities) findings.push(identityFinding(row, config));
  }
  if (facts) {
    findings.push(backupFinding(facts.backups, config, nowMs));
    for (const disk of facts.disks) findings.push(diskFinding(disk, config));
  }
  return { findings, unavailable };
}
