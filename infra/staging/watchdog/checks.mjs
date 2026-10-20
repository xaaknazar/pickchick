// Pure evaluation: facts + thresholds + time -> findings. No I/O, no secrets.
import { bytes, clock, duration, withinQuietHours } from './format.mjs';
import { CONTAINER_ROLES, WORKER_EVENTS } from './host-facts.mjs';

const SESSION_REASONS = Object.freeze({
  session_inactive: 'сессия кассира неактивна',
  session_missing: 'сессии кассира нет',
  session_rejected: 'банк отклонил сессию кассира',
  bridge_unreachable: 'мост Kaspi не отвечает',
});

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

/**
 * Folds the attention/failed/tick lines the workers already print (no extra bank calls). Events
 * arrive in time order; the latest explicit session state wins, so the worker's recovery line
 * (or any tick that reached the bank) closes the problem without waiting for the log window.
 */
export function aggregateWorkerEvents(events) {
  const summary = {
    sessionProblemAt: null,
    sessionReason: null,
    errorEvents: 0,
    unknownOverdue: 0,
    disabled: false,
    events: 0,
  };
  for (const event of events) {
    summary.events++;
    if (event.sessionProblem === true || event.state === 'no_cashier_session') {
      summary.sessionProblemAt = event.at;
      summary.sessionReason =
        event.reason in SESSION_REASONS
          ? event.reason
          : event.state === 'no_cashier_session'
            ? 'session_missing'
            : null;
    } else if (event.sessionProblem === false || event.recovered === true) {
      summary.sessionProblemAt = null;
      summary.sessionReason = null;
    }
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
  let bridge = false;
  for (const [role, summary] of Object.entries(workers))
    if (summary.sessionProblemAt) {
      const why = summary.sessionReason ? ` (${SESSION_REASONS[summary.sessionReason]})` : '';
      bridge ||= summary.sessionReason === 'bridge_unreachable';
      reasons.push(
        `${WORKER_TITLES[role]} сообщил о проблеме сессии${why} ${clock(Date.parse(summary.sessionProblemAt), config.timeZone)}`,
      );
    }
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
      `${reasons.join('; ')}. ${
        bridge
          ? 'Проверить контейнер pickchick-kaspi-bridge, затем сессию.'
          : 'Нужен повторный вход кассира (kaspi-login.mjs, ECDH в памяти) и перезапуск worker.'
      } Счета в приложении и QR в киоске сейчас не выставляются. Runbook: docs/operations/kaspi-remote.md.`,
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
  // A customer is waiting for an invoice/QR that was never sent; money has not been taken.
  if (value > 0)
    return result(
      key,
      'db',
      title,
      'fail',
      'critical',
      `заказов ждут счёта дольше ${minutes} мин: ${value}. Возможные причины: сессия кассира, пульс кассы, стоп-лист, остановленный worker.`,
    );
  return ok(key, 'db', title, 'очереди нет');
}

/** Paid orders whose kitchen admission event the cashier edge has not taken (any worker host). */
function kitchenFinding(backlog, minutes) {
  const key = 'kitchen.backlog';
  const title = 'Передача заказов на кухню (касса)';
  if (backlog.kitchen > 0 || backlog.admission > 0) {
    const parts = [];
    if (backlog.kitchen > 0)
      parts.push(
        `оплаченных заказов не передано на кухню дольше ${minutes} мин: ${backlog.kitchen}`,
      );
    if (backlog.admission > 0)
      parts.push(`заказов ждут резерва кассы дольше ${minutes} мин: ${backlog.admission}`);
    const oldest = backlog.oldestSeconds
      ? `, самый старый ${duration(backlog.oldestSeconds * 1000)}`
      : '';
    return result(
      key,
      'db',
      title,
      'fail',
      backlog.kitchen > 0 ? 'critical' : 'warning',
      `${parts.join('; ')}${oldest}. Проверить пульс кассы, службу PickChickFulfillmentWorker и стоп-лист.`,
    );
  }
  return ok(key, 'db', title, 'очереди нет');
}

/** `fulfillment_transport_attention` lines of a fulfillment worker container on this host. */
export function fulfillmentFinding(events, config) {
  const key = 'kitchen.transport';
  const title = 'Kitchen admission: отложенные заказы';
  let open = null;
  for (const event of events) open = event.recovered ? null : event;
  if (!open) return ok(key, 'logs', title, events.length ? 'восстановлено' : 'событий нет');
  const reasons = open.reasons
    ? ` (${Object.entries(open.reasons)
        .map(([code, value]) => `${code}: ${value}`)
        .join(', ')})`
    : '';
  const parked = (open.parked ?? 0) > 0 || (open.unresolvedFailures ?? 0) > 0;
  return result(
    key,
    'logs',
    title,
    'fail',
    parked ? 'critical' : 'warning',
    `${clock(Date.parse(open.at), config.timeZone)}: отложено ${open.deferred ?? 0}, остановлено ${open.parked ?? 0}${
      open.unresolvedFailures ? `, нерешённых сбоев ${open.unresolvedFailures}` : ''
    }${reasons}. Заказы не попадают на кухню.`,
  );
}

/**
 * Orders sent to a manager's review (commerce reconciliation issues): a refused or overdue
 * kitchen admission, money after a cancellation, capture/refund mismatches. They carry
 * attention_required, so the backlog checks above stop counting them; without this check a
 * paid order that moved to review would look like a recovery.
 */
function reviewFinding(reviews, hours) {
  const key = 'orders.review';
  const title = 'Заказы на разборе (сигналы сверки)';
  if (!reviews.total) return ok(key, 'db', title, `новых за ${hours} ч нет`);
  const codes = Object.entries(reviews.codes)
    .map(([code, count]) => `${code}: ${count}`)
    .join(', ');
  const newest =
    reviews.newestSeconds === null
      ? ''
      : `, последний ${duration(reviews.newestSeconds * 1000)} назад`;
  // Every issue is a separate order for a manager: a new one while the alert is open is announced
  // at once ("НОВЫЙ СЛУЧАЙ"), not only with the next reminder.
  const mark = reviews.newestAt ? Date.parse(reviews.newestAt) : NaN;
  return {
    ...result(
      key,
      'db',
      title,
      'fail',
      'critical',
      `новых сигналов сверки за ${hours} ч: ${reviews.total} (${codes})${newest}. Деньги могли быть приняты без передачи на кухню или нужен возврат: разобрать в кабинете (сигналы сверки).`,
    ),
    ...(Number.isSafeInteger(mark) && mark > 0 ? { mark } : {}),
  };
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

/** backup-status.json: the last backup.sh run failed (OnFailure also starts this check). */
function backupRunFinding(status, config) {
  const key = 'backup.run';
  const title = 'Резервная копия: последний запуск';
  if (!status) return skip(key, 'host', title, 'нет файла статуса (backup.sh старой версии)');
  if (!status.ok)
    return result(
      key,
      'host',
      title,
      'fail',
      'critical',
      `запуск ${clock(Date.parse(status.lastAttemptAt), config.timeZone)} завершился ошибкой на этапе ${status.stage}. Проверить journalctl -u pickchick-backup.service.`,
    );
  return ok(
    key,
    'host',
    title,
    `успешно ${clock(Date.parse(status.lastAttemptAt), config.timeZone)}`,
  );
}

/** offsite-status.json: encrypted copy in independent S3-compatible storage. */
function offsiteFinding(offsite, config, nowMs) {
  const key = 'backup.offsite';
  const title = 'Резервная копия: внешнее хранилище';
  const limit = config.backup.offsiteMaxAgeHours;
  if (!offsite || !offsite.enabled)
    return result(
      key,
      'host',
      title,
      'fail',
      'critical',
      'внешняя копия ожидается (WATCHDOG_EXPECT_BACKUP_OFFSITE=true), но выгрузка не включена или не запускалась',
    );
  if (!offsite.lastSuccessAt)
    return result(key, 'host', title, 'fail', 'critical', 'ни одной успешной выгрузки');
  const age = nowMs - Date.parse(offsite.lastSuccessAt);
  if (!offsite.ok || age > limit * 3_600_000)
    return result(
      key,
      'host',
      title,
      'fail',
      'critical',
      `последняя успешная выгрузка ${duration(age)} назад (${clock(Date.parse(offsite.lastSuccessAt), config.timeZone)}), лимит ${limit} ч${
        offsite.ok ? '' : '; последняя попытка не удалась'
      }. Проверить journalctl -u pickchick-backup.service.`,
    );
  return ok(key, 'host', title, `выгружена ${duration(age)} назад`);
}

/** wal-status.json: PITR WAL shipping (optional). */
function walFinding(wal, config, nowMs) {
  const key = 'backup.wal';
  const title = 'PITR: отправка WAL во внешнее хранилище';
  const limit = config.backup.walMaxDelayMinutes * 60_000;
  if (!wal)
    return result(key, 'host', title, 'fail', 'critical', 'отправка WAL ни разу не запускалась');
  const checked = nowMs - Date.parse(wal.checkedAt);
  if (checked > limit)
    return result(
      key,
      'host',
      title,
      'fail',
      'critical',
      `отправка WAL не запускалась ${duration(checked)}; проверить pickchick-wal-ship.timer`,
    );
  const oldest = wal.oldestPendingAt ? nowMs - Date.parse(wal.oldestPendingAt) : 0;
  if (!wal.ok || oldest > limit)
    return result(
      key,
      'host',
      title,
      'fail',
      'critical',
      `не отправлено сегментов: ${wal.pending}${oldest ? `, самый старый ${duration(oldest)}` : ''}${
        wal.ok ? '' : '; последняя отправка с ошибкой'
      }. Точка восстановления отстаёт.`,
    );
  return ok(key, 'host', title, `в очереди ${wal.pending}`);
}

/** pg_stat_archiver: archive_command keeps failing (PITR option only). */
function archiverFinding(archiver, config) {
  const key = 'backup.archiver';
  const title = 'PITR: архивирование WAL в PostgreSQL';
  if (archiver.mode !== 'on' && archiver.mode !== 'always')
    return result(key, 'db', title, 'fail', 'critical', `archive_mode=${archiver.mode}`);
  const failed = archiver.lastFailedAt ? Date.parse(archiver.lastFailedAt) : 0;
  const archived = archiver.lastArchivedAt ? Date.parse(archiver.lastArchivedAt) : 0;
  if (failed > archived)
    return result(
      key,
      'db',
      title,
      'fail',
      'critical',
      `archive_command падает с ${clock(failed, config.timeZone)} (ошибок всего ${archiver.failedCount}); WAL копится в pg_wal`,
    );
  return ok(key, 'db', title, `архивировано ${archiver.archivedCount}`);
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
  if (facts && !unavailable.has('logs') && facts.fulfillmentCollected)
    findings.push(fulfillmentFinding(facts.fulfillmentEvents, config));
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
    findings.push(kitchenFinding(db.facts.kitchenBacklog, config.kitchenBacklogMinutes));
    if (db.facts.reviews) findings.push(reviewFinding(db.facts.reviews, config.reviewWindowHours));
    for (const row of db.facts.heartbeats) findings.push(heartbeatFinding(row, config, nowMs));
    for (const row of db.facts.identities) findings.push(identityFinding(row, config));
    if (config.backup.expectPitr) findings.push(archiverFinding(db.facts.archiver, config));
  }
  if (facts) {
    const backups = facts.backups;
    findings.push(backupFinding(backups, config, nowMs));
    if (!backups.error) {
      findings.push(backupRunFinding(backups.status, config));
      if (config.backup.expectOffsite || backups.offsite?.enabled)
        findings.push(offsiteFinding(backups.offsite, config, nowMs));
      if (config.backup.expectPitr || backups.wal?.enabled)
        findings.push(walFinding(backups.wal, config, nowMs));
    }
    for (const disk of facts.disks) findings.push(diskFinding(disk, config));
  }
  return { findings, unavailable };
}
