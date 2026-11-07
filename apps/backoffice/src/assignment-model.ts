import { almatyDateTime } from './ui-fixes.js';

/**
 * «Расстановка» in the cabinet (А9; lane bo-ui2 step 5, BACKOFFICE_STAFF_ASSIGNMENT_ENABLED;
 * design-bo-ui.md §9.4). Pure functions over GET .../ops/staff-assignments: the shape check, the
 * grid by station, the texts and the commands. The server decides every rule (stations of the
 * positions, one open interval, no overlap, the business day); the cabinet only says it first.
 */
type Data = Record<string, unknown>;
export const ASSIGNMENT_SECTION = [
  'assignment',
  'Расстановка',
  'Кто на какой станции сейчас и за день, перестановки',
] as const;
export type Station = {
  code: string;
  label: string;
  number: number;
  kds: string | null;
  positions: string[];
  active: boolean;
};
export type Assignment = {
  id: string;
  employee_id: string;
  employee_name: string | null;
  station_code: string;
  station_label: string;
  business_date: string;
  started_at: string;
  ended_at: string | null;
  set_by_name: string | null;
  set_at: string;
  ended_by_name: string | null;
  revision: number;
  override_reason: string | null;
};
export type AssignmentEmployee = {
  employee_id: string;
  name: string;
  position_code: string | null;
  extra_position_codes: string[];
  stations: string[];
};
export type AssignmentDay = {
  date: string;
  today: string;
  night_end: string;
  manager_shift: { id: string; business_date: string; opened_at: string } | null;
  stations: Station[];
  employees: AssignmentEmployee[];
  intervals: Assignment[];
  earlier_open: Assignment[];
  counts: { intervals: number; open: number; employees: number };
  truncated: { intervals: boolean };
};
export type RangeInterval = {
  id: string;
  employee_id: string;
  station_code: string;
  business_date: string;
  started_at: string;
  ended_at: string | null;
};
export type AssignmentRange = {
  start_date: string;
  end_date: string;
  stations: Station[];
  employees: { employee_id: string; name: string | null }[];
  intervals: RangeInterval[];
  truncated: { intervals: boolean };
};

const isObject = (v: unknown): v is Data => !!v && typeof v === 'object' && !Array.isArray(v);
function head(value: unknown, branch: string, mode: 'day' | 'range'): Data {
  if (
    !isObject(value) ||
    value['branch_id'] !== branch ||
    value['view'] !== 'staff-assignments' ||
    value['mode'] !== mode ||
    !Array.isArray(value['stations']) ||
    !Array.isArray(value['employees']) ||
    !Array.isArray(value['intervals']) ||
    typeof value['today'] !== 'string'
  )
    throw new Error('INVALID_RESPONSE');
  return value;
}
/** GET .../ops/staff-assignments?date: checked enough to draw the grid; throws otherwise. */
export function assignmentDayView(value: unknown, branch: string): AssignmentDay {
  const v = head(value, branch, 'day');
  if (typeof v['date'] !== 'string' || !Array.isArray(v['earlier_open']) || !isObject(v['counts']))
    throw new Error('INVALID_RESPONSE');
  return v as unknown as AssignmentDay;
}
/** GET .../ops/staff-assignments?start_date&end_date: the compact intervals of a window. */
export function assignmentRangeView(value: unknown, branch: string): AssignmentRange {
  const v = head(value, branch, 'range');
  if (typeof v['start_date'] !== 'string' || typeof v['end_date'] !== 'string')
    throw new Error('INVALID_RESPONSE');
  return v as unknown as AssignmentRange;
}

const clockFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Almaty',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
/** «13:30»: the Almaty clock time of an instant. */
export const clock = (iso: string) => clockFormat.format(new Date(iso));
/** The Almaty clock time now, to the minute («Переставить с ...» starts there). */
export const nowClock = (now = new Date()) => clockFormat.format(now);
/** «18.11.2026» */
export const dmy = (day: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : day;
};
/** The night after the business day: a clock time before 06:00. */
export const nightTime = (time: string, nightEnd = '06:00') => time < nightEnd;
/** «10:00-13:30», «с 13:30» for an open one; a start after midnight says «ночь». */
export function intervalText(a: {
  business_date: string;
  started_at: string;
  ended_at: string | null;
}) {
  const night = (iso: string) =>
    almatyDateTime(iso).slice(0, 10) !== dmy(a.business_date) ? ' (ночь)' : '';
  const start = clock(a.started_at) + night(a.started_at);
  return a.ended_at
    ? `${start} - ${clock(a.ended_at)}${night(a.ended_at) && !night(a.started_at) ? ' (ночь)' : ''}`
    : `с ${start}`;
}

export type StationRow = {
  station: Station;
  /** Open intervals of the shown day on this station (who stands there now). */
  current: Assignment[];
  /** Closed intervals of the shown day on this station. */
  past: Assignment[];
};
/**
 * The grid of a business day: every active station, and an inactive one only while it has
 * intervals that day; in the order of the server (number, then the kitchen's order).
 */
export function stationGrid(day: AssignmentDay): StationRow[] {
  return day.stations
    .map((station) => ({
      station,
      current: day.intervals.filter((i) => i.station_code === station.code && !i.ended_at),
      past: day.intervals.filter((i) => i.station_code === station.code && i.ended_at),
    }))
    .filter((row) => row.station.active || row.current.length || row.past.length);
}
/** The employee's open interval: of the shown day or left open on an earlier one. */
export const openOf = (day: AssignmentDay, employee: string) =>
  day.intervals.find((i) => i.employee_id === employee && !i.ended_at) ??
  day.earlier_open.find((i) => i.employee_id === employee) ??
  null;
/** Working employees without an open interval (nobody has put them on a station). */
export const unassigned = (day: AssignmentDay) =>
  day.employees.filter((e) => openOf(day, e.employee_id) === null);
/** The stations of an employee: his positions first, then the rest (only with an override). */
export function stationChoices(day: AssignmentDay, employee: AssignmentEmployee | undefined) {
  const active = day.stations.filter((s) => s.active);
  const mine = new Set(employee?.stations ?? []);
  return {
    allowed: active.filter((s) => mine.has(s.code)),
    other: active.filter((s) => !mine.has(s.code)),
  };
}
export const allowedFor = (employee: AssignmentEmployee | undefined, station: string) =>
  !!employee && employee.stations.includes(station);

export function assignCommand(
  employee: string,
  station: string,
  businessDate: string,
  time: string,
  revision: number,
  override: string | null,
): Data {
  const reason = (override ?? '').trim();
  return {
    type: 'staff_assign',
    employee_id: employee,
    station_code: station,
    business_date: businessDate,
    time,
    expected_revision: revision,
    ...(reason ? { override_reason: reason } : {}),
  };
}
export const unassignCommand = (employee: string, time: string, revision: number): Data => ({
  type: 'staff_unassign',
  employee_id: employee,
  time,
  expected_revision: revision,
});
export const validTime = (v: string) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v);

/** The server reasons of the staff assignment, in words (also in api.ts reasons). */
export const ASSIGNMENT_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  STATION_UNKNOWN:
    'Такой станции нет в списке должностей точки или она выключена. Обновите страницу.',
  STATION_NOT_ALLOWED:
    'Эта станция не входит в должность сотрудника. Поставить не по должности может управляющий, указав причину.',
  EMPLOYEE_NOT_WORKING: 'Сотрудник не работает или удалён. Обновите страницу.',
  ASSIGNMENT_TIME:
    'Время не подходит: оно позже текущего больше чем на 5 минут или раньше начала интервала. Время с 00:00 до 05:59 - ночь после дня смены.',
  ASSIGNMENT_OVERLAP:
    'В это время сотрудник уже стоял на станции: интервалы не пересекаются. Укажите время позже начала текущего интервала.',
  ASSIGNMENT_PREVIOUS_DAY:
    'У сотрудника не закрыт интервал прошлого дня смены. Сначала нажмите «Закончить» у этого интервала.',
  CONFLICT: 'Расстановку изменили в другом окне. Страница обновлена: проверьте и повторите.',
});

/**
 * The stations of one employee on one business day for the time sheet («Табель»):
 * «Сборка - зал (стол 1) 10:00 - 13:30; Выдача (2) с 13:30», or '' without intervals.
 */
export function stationStrip(range: AssignmentRange, employee: string, day: string): string {
  const label = (code: string) => range.stations.find((s) => s.code === code)?.label ?? code;
  return range.intervals
    .filter((i) => i.employee_id === employee && i.business_date === day)
    .map((i) => `${label(i.station_code)} ${intervalText(i)}`)
    .join('; ');
}
/** Employees placed on a day of the window (by the business day), for the time sheet note. */
export const placedOn = (range: AssignmentRange, day: string) =>
  new Set(range.intervals.filter((i) => i.business_date === day).map((i) => i.employee_id));
/** The first and the last day of a month 'YYYY-MM-01'. */
export function monthWindow(month: string) {
  const y = Number(month.slice(0, 4)),
    m = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    start: `${month.slice(0, 7)}-01`,
    end: `${month.slice(0, 7)}-${String(last).padStart(2, '0')}`,
  };
}
