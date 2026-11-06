/**
 * Lane bo-ui audit fixes (design-bo-ui §6): one switch for the parts of the cabinet that are
 * drawn by module helpers without access to the server snapshot (table builders, money and date
 * formatters). app.ts sets `ui.fixes` on every render from OperationsModel.fixes (auditFixes of
 * operations-model.ts); while it is false every helper here returns exactly what the cabinet
 * showed before the lane, so a server with every flag off sees the cloud lane's cabinet.
 */
export const ui = { fixes: false };

/**
 * Audit F14: on a phone (CSS, max-width 650 px) the rows of a marked table become labelled
 * cards, so amounts, statuses and buttons stay on screen. Marks nothing while the fixes are off.
 */
export function cards(wrap: HTMLElement, headers: readonly string[]) {
  if (!ui.fixes) return wrap;
  wrap.classList.add('bo-cards');
  for (const row of wrap.querySelectorAll('tbody tr')) {
    const cells = [...row.children] as HTMLElement[];
    if (cells.length === 1 && (cells[0] as HTMLTableCellElement).colSpan > 1) {
      row.classList.add('bo-cards-empty');
      continue;
    }
    cells.forEach((cell, i) => {
      cell.dataset.label = headers[i] ?? '';
    });
  }
  return wrap;
}

/** Audit F19: plain hyphens instead of long dashes in interface texts (AGENTS.md). */
export const dash = (text: string) =>
  ui.fixes ? text.replace(/ ?[—–] ?/g, (m) => (m.length > 1 ? ' - ' : '-')) : text;

/** Audit F19: «2026-11-05» -> «05.11.2026»; anything else unchanged. Off: unchanged. */
export function isoDay(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (!ui.fixes) return text;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : text;
}
/** Audit F19: «2026-11» -> «11.2026». Off: unchanged. */
export function isoMonth(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (!ui.fixes) return text;
  const m = /^(\d{4})-(\d{2})$/.exec(text);
  return m ? `${m[2]}.${m[1]}` : text;
}

/**
 * Audit F19: one money format everywhere, «11 670 ₸» and «11 670,50 ₸» (ordinary spaces, the
 * kopecks only when there are any), as the sales report and the order registry show it.
 */
export function tenge(minor: unknown): string {
  const n = BigInt(String(minor ?? 0)),
    a = n < 0n ? -n : n,
    part = a % 100n;
  return `${n < 0n ? '-' : ''}${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${part ? ',' + part.toString().padStart(2, '0') : ''} ₸`;
}

/** Audit F19: «05.11.2026 22:34» in Almaty time. */
export function almatyDateTime(value: unknown): string {
  if (!value) return '-';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Asia/Almaty',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(String(value)))
      .map((p) => [p.type, p.value]),
  );
  return `${parts['day']}.${parts['month']}.${parts['year']} ${parts['hour']}:${parts['minute']}`;
}

/**
 * Audit F19: the years a manager can pick for the schedule: from the first year of PickChick
 * data (2025) to next year, always including the year that is open now.
 */
export function yearOptions(selected: string, now = new Date()): string[] {
  const current = Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric' }).format(now),
  );
  const years = new Set<string>();
  for (let y = 2025; y <= current + 1; y++) years.add(String(y));
  if (/^\d{4}$/.test(selected)) years.add(selected);
  return [...years].sort();
}
