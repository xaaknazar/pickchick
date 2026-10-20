// Plain-text Telegram messages (no parse_mode: nothing to escape, nothing interpreted).
import { clock, duration } from './format.mjs';

const SEVERITY = { critical: 'критично', warning: 'внимание' };
const KIND = {
  alert: 'ТРЕВОГА',
  escalation: 'УХУДШЕНИЕ',
  reminder: 'НАПОМИНАНИЕ',
  recovery: 'НОРМА',
  resolved: 'СНЯТО',
};
export const TELEGRAM_LIMIT = 3800;

export function renderEvents(events, config, nowMs) {
  const lines = [`[${config.label}] мониторинг, ${clock(nowMs, config.timeZone)}`];
  for (const event of events) {
    const head =
      event.kind === 'recovery' || event.kind === 'resolved'
        ? `${KIND[event.kind]}: ${event.title}`
        : `${KIND[event.kind]} (${SEVERITY[event.severity]}): ${event.title}`;
    const tail =
      event.kind === 'recovery' || event.kind === 'resolved'
        ? `Проблема длилась ${duration(nowMs - event.since)}.`
        : `С ${clock(event.since, config.timeZone)} (${duration(nowMs - event.since)}).`;
    const detail = /[.!?]$/.test(event.detail) ? event.detail : `${event.detail}.`;
    lines.push('', head, `${detail} ${tail}`);
  }
  return lines.join('\n');
}

export function renderSummary(evaluation, config, nowMs) {
  const failing = evaluation.findings
    .filter((finding) => finding.status === 'fail')
    .sort((a, b) =>
      a.severity === b.severity ? a.key.localeCompare(b.key) : a.severity === 'critical' ? -1 : 1,
    );
  const healthy = evaluation.findings.filter((finding) => finding.status === 'ok');
  const skipped = evaluation.findings.filter((finding) => finding.status === 'skip');
  const lines = [`[${config.label}] ежедневная сводка, ${clock(nowMs, config.timeZone)}`, ''];
  lines.push(failing.length ? `Проблем: ${failing.length}` : 'Проблем нет.');
  for (const finding of failing)
    lines.push(`- (${SEVERITY[finding.severity]}) ${finding.title}: ${finding.detail}`);
  if (healthy.length) lines.push('', 'В норме:');
  for (const finding of healthy) lines.push(`- ${finding.title}: ${finding.detail}`);
  if (skipped.length) lines.push('', 'Не проверялось сейчас:');
  for (const finding of skipped) lines.push(`- ${finding.title}: ${finding.detail}`);
  const sources = [...evaluation.unavailable].sort();
  if (sources.length) lines.push('', `Недоступные источники: ${sources.join(', ')}.`);
  lines.push('', 'Сводка подтверждает, что мониторинг работает.');
  return lines.join('\n');
}

/** Splits on line boundaries below Telegram's 4096-character limit. */
export function chunk(text, limit = TELEGRAM_LIMIT) {
  const parts = [];
  let current = '';
  for (const raw of text.split('\n')) {
    const line = raw.length > limit ? raw.slice(0, limit - 1) + '…' : raw;
    if (current && current.length + line.length + 1 > limit) {
      parts.push(current);
      current = line;
    } else current = current ? `${current}\n${line}` : line;
  }
  if (current) parts.push(current);
  return parts;
}
