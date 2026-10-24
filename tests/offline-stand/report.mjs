/** Russian markdown summary of an offline stand report (report.json is the full record). */
const STATUS = {
  passed: 'пройден',
  failed: 'НЕ ПРОЙДЕН',
  error: 'ошибка стенда',
  skipped: 'пропущен',
  known_issue: 'известное ограничение',
  running: 'выполняется',
  interrupted: 'прерван',
};
const MODE = {
  ci: 'короткий (CI, минуты)',
  soak: 'длительный (часы без интернета)',
  backlog: 'большой накопленный поток (AC-17)',
};
const cell = (value) =>
  String(value ?? '-')
    .replaceAll('|', '/')
    .replaceAll('\n', ' ');
const json = (value) =>
  value === undefined ? '-' : typeof value === 'string' ? value : JSON.stringify(value);
const minutes = (seconds) =>
  seconds === undefined
    ? '-'
    : seconds < 120
      ? `${seconds} с`
      : `${Math.round(seconds / 6) / 10} мин`;

export function renderMarkdown(report) {
  const lines = [];
  const scenarios = report.scenarios ?? [];
  const failed = scenarios.flatMap((s) =>
    (s.checks ?? []).filter((c) => !c.ok && !c.known).map((c) => ({ scenario: s.id, ...c })),
  );
  lines.push(`# Стенд офлайн-теста: прогон ${report.run_id}`, '');
  lines.push(
    `Итог: **${STATUS[report.status] ?? report.status}**. Режим: ${MODE[report.mode] ?? report.mode}. ` +
      `Длительность: ${minutes(report.duration_seconds)}. Коммит: \`${report.source_commit ?? '-'}\`. Seed: ${report.seed}.`,
    '',
  );
  if (report.error) lines.push(`Ошибка стенда: \`${cell(report.error.message)}\``, '');
  lines.push(
    'Стенд запускает настоящие процессы облачного API, кассового узла (edge) и трёх воркеров кассы ',
    'с паузами как на Windows-кассе. «Интернет» (WAN) и «локальная сеть» (LAN до кухни) - управляемые ',
    'прокси на этой машине. Банк Kaspi и ККМ не вызываются: их ответы синтетические.',
    '',
    '## Сценарии',
    '',
    '| Сценарий | Итог | Время | Сходимость | Главное |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const s of scenarios) {
    const notes = s.notes ?? {};
    const main = [
      notes.outage_seconds !== undefined ? `без связи ${notes.outage_seconds} с` : null,
      notes.events_accumulated !== undefined
        ? `накоплено ${notes.events_accumulated} событий`
        : null,
      notes.offline_minutes !== undefined ? `без интернета ${notes.offline_minutes} мин` : null,
      notes.pos_orders_lost_by_restore !== undefined
        ? `потеряно восстановлением: ${notes.pos_orders_lost_by_restore} заказов кассы, ${notes.channel_orders_lost_by_restore} заказов киоска/приложения`
        : null,
      s.reason ? `причина: ${s.reason}` : null,
      s.error ? `ошибка: ${s.error.message}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    lines.push(
      `| ${cell(s.title)} | ${STATUS[s.status] ?? s.status} | ${minutes(s.duration_seconds)} | ${minutes(
        notes.convergence_seconds ?? s.final_convergence_seconds,
      )} | ${cell(main || '-')} |`,
    );
  }
  lines.push('', '## Не пройденные проверки', '');
  if (!failed.length) lines.push('Нет.');
  for (const c of failed)
    lines.push(
      `- **${cell(c.title)}** (${c.scenario}/${c.id}): ожидалось ${cell(json(c.expected))}, получено ${cell(
        json(c.actual),
      )}${c.details ? `; подробности: \`${cell(json(c.details)).slice(0, 400)}\`` : ''}`,
    );
  if (report.known_issues?.length) {
    lines.push('', '## Известные ограничения, воспроизведённые стендом', '');
    for (const issue of report.known_issues)
      lines.push(
        `- **${cell(issue.title)}** (${issue.scenario}). Описано: ${issue.doc}. Данные: \`${cell(json(issue.evidence))}\`. Затронутые проверки: ${issue.checks.join(', ')}.`,
      );
  }
  if (report.staff_view) {
    const v = report.staff_view;
    lines.push(
      '',
      '## Что видит персонал',
      '',
      '| Ситуация | Касса (верх экрана) | Кухня | Касса знает о связи с облаком |',
      '| --- | --- | --- | --- |',
    );
    for (const [label, view] of [
      ['Всё работает', v.normal],
      ['Нет интернета (WAN)', v.wan_loss],
      ['Нет LAN до кухни', v.lan_loss],
    ])
      lines.push(
        `| ${label} | ${cell(view?.pos)} | ${cell(view?.kitchen)} | ${cell(view?.cloud_link)} |`,
      );
    lines.push(
      '',
      v.verdict.ok
        ? 'Потеря интернета и потеря локальной сети различимы.'
        : 'Потеря интернета и потеря локальной сети **не различимы** для персонала.',
    );
  }
  const last = [...scenarios].reverse().find((s) => s.volumes);
  if (last) {
    const v = last.volumes;
    lines.push(
      '',
      '## Объём (накопительно за прогон)',
      '',
      `- Заказы кассы: ${v.pos_orders} (отменено ${v.pos_cancelled}); заказы киоска и приложения: ${v.channel_orders} (на разборе у менеджера ${v.channel_orders_review}).`,
      `- Выдано гостям: ${v.handed_over}; отметок комбо: ${v.stamps}; команд стопа из кабинета: ${v.remote_stop_commands}.`,
      `- События синхронизации касса <-> облако: ${v.total_sync_events} (заказы кассы ${v.pos_events}, кухня кассы ${v.kitchen_events_pos}, кухня киоска/приложения ${v.kitchen_events_channel}, команды облака ${v.cloud_commands_applied}, отчёты смен ${v.cashier_report_events}).`,
    );
  }
  if (report.wan_faults)
    lines.push(
      '',
      '## Сбои, внесённые в «интернет»',
      '',
      `Запросов ${report.wan_faults.requests}: сброшено соединений ${report.wan_faults.refused + report.wan_faults.reset}, ` +
        `потеряно ответов после записи ${report.wan_faults.dropped_response}, дублей ${report.wan_faults.duplicated}, ` +
        `опоздавших ${report.wan_faults.late}, переставленных ${report.wan_faults.reordered}. ` +
        `Перезапуски процессов: ${json(report.restarts)}.`,
    );
  lines.push(
    '',
    '## Ограничения стенда',
    '',
    '- Одна машина: PostgreSQL кассы и облака в контейнерах, процессы Node. Не Windows, не моноблоки, не реальный роутер.',
    '- Банк и ККМ синтетические: оплата приложения и киоска подтверждается доверенным наблюдением, как в существующих тестах.',
    '- Экран кассы и кухни проверяется по тем же запросам и подписям, что у установленных клиентов, без браузера.',
    '- Реальный 8-часовой тест на точке проводится по runbook docs/operations/offline-8h-test.md.',
    '',
  );
  return lines.join('\n');
}
