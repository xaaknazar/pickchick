// Preserve the instant when formatting local time with a numeric UTC offset.
// Upstream appended +0500 to UTC wall time, moving signed request time by 5 h.
export function bankTimestamp(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const mm = String(Math.abs(offset) % 60).padStart(2, '0');
  return new Date(date.getTime() + offset * 60_000).toISOString().slice(0, -1) + sign + hh + mm;
}
