// Russian plain-text formatting for Telegram. Uses an ordinary hyphen, never long dashes.

export function duration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return 'меньше минуты';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} ч ${minutes % 60} мин` : `${hours} ч`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} дн ${hours % 24} ч` : `${days} дн`;
}

function parts(ms, timeZone) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return values;
}

/** "09.10 14:05" in the configured zone. */
export function clock(ms, timeZone) {
  const p = parts(ms, timeZone);
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}

/** Local calendar day "2026-10-09" and hour 0-23. */
export function localDay(ms, timeZone) {
  const p = parts(ms, timeZone);
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

export function bytes(value) {
  if (!Number.isFinite(value)) return '?';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let index = 0;
  let amount = value;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index++;
  }
  return `${amount >= 10 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}

/** Inside "HH:MM-HH:MM" (start inclusive, end exclusive; may cross midnight). */
export function withinQuietHours(quietHours, ms, timeZone) {
  if (!quietHours) return false;
  const { hour, minute } = localDay(ms, timeZone);
  const now = hour * 60 + minute;
  const toMinutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = toMinutes(quietHours.start);
  const end = toMinutes(quietHours.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}
