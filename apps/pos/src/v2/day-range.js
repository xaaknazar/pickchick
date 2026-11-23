/**
 * Days of the «Заказы» screen (23.11 owner): one day, a period from–to or a whole month, never
 * after today. Days are Almaty calendar days as YYYY-MM-DD; a period spans at most 31 days, the
 * longest the cashier server reads at once (GET pos/branch-orders).
 */
export const MAX_RANGE_DAYS = 31;
const MONTHS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];
const MONTHS_OF = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
const WEEK = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Today in Almaty. */
export function almatyToday(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' });
}
/** `day` moved by `n` days. */
export function addDays(day, n) {
  return new Date(Date.parse(day + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
}
/** Days from `from` to `to`, both included. */
export function spanDays(from, to) {
  return Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 864e5) + 1;
}
function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
/** The whole month of `month` (YYYY-MM), cut at today; null for a month after today. */
export function monthRange(month, today) {
  const from = month + '-01';
  if (from > today) return null;
  const end = monthEnd(month);
  return { mode: 'month', from, to: end < today ? end : today };
}
/**
 * A range the screen can show: days in order, none after today, at most MAX_RANGE_DAYS; a
 * one-day period is a day. Anything else is null.
 */
export function normalizeRange(range, today) {
  if (!range || !/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to))
    return null;
  let { from, to } = range;
  if (to < from) [from, to] = [to, from];
  if (from > today) return null;
  if (to > today) to = today;
  if (range.mode === 'month') return monthRange(from.slice(0, 7), today);
  if (spanDays(from, to) > MAX_RANGE_DAYS) return null;
  return { mode: from === to ? 'day' : 'range', from, to };
}
/**
 * «‹» and «›»: the previous or next day, month or period of the same length. Never past today:
 * «›» on a range that reaches today returns null and the screen keeps it.
 */
export function stepRange(range, direction, today) {
  if (range.mode === 'month') {
    const month = shiftMonth(range.from.slice(0, 7), direction);
    return monthRange(month, today);
  }
  const span = spanDays(range.from, range.to);
  const from = addDays(range.from, direction * span);
  if (from > today) return null;
  return normalizeRange({ mode: range.mode, from, to: addDays(range.to, direction * span) }, today);
}
function short(day) {
  return Number(day.slice(8)) + ' ' + MONTHS_OF[Number(day.slice(5, 7)) - 1];
}
/** The date control: «23 ноября 2026», «1 – 23 ноября», «Ноябрь 2026». */
export function rangeLabel(range) {
  const year = range.from.slice(0, 4);
  if (range.mode === 'month') return MONTHS[Number(range.from.slice(5, 7)) - 1] + ' ' + year;
  if (range.from === range.to) return short(range.from) + ' ' + year;
  const sameMonth = range.from.slice(0, 7) === range.to.slice(0, 7);
  const sameYear = year === range.to.slice(0, 4);
  return (
    (sameMonth ? String(Number(range.from.slice(8))) : short(range.from)) +
    (sameYear ? '' : ' ' + year) +
    ' – ' +
    short(range.to) +
    ' ' +
    range.to.slice(0, 4)
  );
}
/** Quick choices of the calendar. */
export function quickRanges(today) {
  const month = today.slice(0, 7);
  return [
    ['Сегодня', { mode: 'day', from: today, to: today }],
    ['Вчера', { mode: 'day', from: addDays(today, -1), to: addDays(today, -1) }],
    ['7 дней', { mode: 'range', from: addDays(today, -6), to: today }],
    ['Этот месяц', monthRange(month, today)],
    ['Прошлый месяц', monthRange(shiftMonth(month, -1), today)],
  ];
}
/** Weeks of `month` from Monday; null cells pad the first and last week. */
export function monthGrid(month) {
  const first = new Date(month + '-01T12:00:00Z');
  const lead = (first.getUTCDay() + 6) % 7;
  const days = Number(monthEnd(month).slice(8));
  const cells = [...Array(lead).fill(null)];
  for (let d = 1; d <= days; d++) cells.push(month + '-' + String(d).padStart(2, '0'));
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/**
 * The calendar dialog: tabs День / Период / Месяц, quick choices, a month grid without days
 * after today. `apply(range)` gets a normalized range; the dialog closes itself.
 */
export function openRangeDialog(current, today, apply) {
  let mode = current.mode === 'range' ? 'range' : current.mode === 'month' ? 'month' : 'day';
  let shown = current.to.slice(0, 7);
  let start = null;
  const dialog = document.createElement('dialog');
  dialog.className = 'order-dialog day-dialog';
  dialog.dataset.testid = 'day-dialog';
  const done = (range) => {
    const r = normalizeRange(range, today);
    if (!r) return;
    dialog.close();
    apply(r);
  };
  const button = (text, onclick, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (cls) b.className = cls;
    b.onclick = onclick;
    return b;
  };
  const body = document.createElement('div');
  function render() {
    body.replaceChildren();
    const tabs = document.createElement('div');
    tabs.className = 'day-tabs';
    for (const [key, label] of [
      ['day', 'День'],
      ['range', 'Период'],
      ['month', 'Месяц'],
    ])
      tabs.append(
        button(
          label,
          () => {
            mode = key;
            start = null;
            render();
          },
          mode === key ? 'selected' : '',
        ),
      );
    const quick = document.createElement('div');
    quick.className = 'day-quick';
    for (const [label, range] of quickRanges(today))
      if (range) quick.append(button(label, () => done(range)));
    body.append(tabs, quick);
    if (mode === 'month') {
      const months = document.createElement('div');
      months.className = 'day-months';
      let month = today.slice(0, 7);
      for (let i = 0; i < 12; i++, month = shiftMonth(month, -1)) {
        const m = month;
        months.append(
          button(
            MONTHS[Number(m.slice(5)) - 1] + ' ' + m.slice(0, 4),
            () => done(monthRange(m, today)),
            current.mode === 'month' && current.from.slice(0, 7) === m ? 'selected' : '',
          ),
        );
      }
      body.append(months);
      return;
    }
    const head = document.createElement('div');
    head.className = 'day-head';
    const title = document.createElement('strong');
    title.textContent = MONTHS[Number(shown.slice(5)) - 1] + ' ' + shown.slice(0, 4);
    const next = shiftMonth(shown, 1);
    const forward = button('›', () => {
      shown = next;
      render();
    });
    forward.disabled = next + '-01' > today;
    head.append(
      button('‹', () => {
        shown = shiftMonth(shown, -1);
        render();
      }),
      title,
      forward,
    );
    const hint = document.createElement('p');
    hint.className = 'day-hint';
    hint.textContent =
      mode === 'day'
        ? 'Выберите день'
        : start
          ? 'Выберите последний день периода (до ' + MAX_RANGE_DAYS + ' дней)'
          : 'Выберите первый день периода';
    const grid = document.createElement('div');
    grid.className = 'day-grid';
    for (const w of WEEK) {
      const cell = document.createElement('span');
      cell.textContent = w;
      grid.append(cell);
    }
    const chosenFrom = start ?? current.from,
      chosenTo = start ?? current.to;
    for (const week of monthGrid(shown))
      for (const day of week) {
        if (!day) {
          grid.append(document.createElement('span'));
          continue;
        }
        const b = button(String(Number(day.slice(8))), () => {
          if (mode === 'day') done({ mode: 'day', from: day, to: day });
          else if (!start) {
            start = day;
            render();
          } else done({ mode: 'range', from: start, to: day });
        });
        b.dataset.day = day;
        b.disabled =
          day > today || Boolean(start && Math.abs(spanDays(start, day) - 1) + 1 > MAX_RANGE_DAYS);
        if (day >= chosenFrom && day <= chosenTo && (start || current.mode !== 'month'))
          b.className = 'selected';
        if (day === today) b.classList.add('today');
        grid.append(b);
      }
    body.append(head, hint, grid);
  }
  render();
  const actions = document.createElement('div');
  actions.className = 'cash-actions';
  actions.append(button('Закрыть', () => dialog.close()));
  dialog.append(body, actions);
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
