/**
 * Staff positions in the cabinet (lane bo-ui step 6, BACKOFFICE_STAFF_POSITIONS_ENABLED;
 * design-bo-ui.md 5.7). Pure functions over GET branches/:id `staff_positions` and the employee
 * cards: labels, the «Доступы» column, the payload of the card editor and the roster file. Used
 * only while the server reports capabilities.staff_positions; without it nothing here runs.
 */
type Data = Record<string, unknown>;
export type StaffPosition = {
  code: string;
  label: string;
  station: number | null;
  kds: string[];
  pos_access: 'none' | 'cashier' | 'shift_manager';
  active: boolean;
};
export type StaffPositions = {
  version: number;
  editable: boolean;
  positions: StaffPosition[];
  updated_at: string | null;
  updated_by_name: string | null;
};
export const POS_ACCESS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  none: 'Нет',
  cashier: 'Кассир',
  shift_manager: 'Начальник смены',
});
export const MAX_EXTRA_POSITIONS = 3;

/** The list of GET branches/:id, or null (no capability, or a malformed answer). */
export function staffPositions(data: { capabilities?: unknown; staff_positions?: unknown } | null) {
  const caps = (data?.capabilities ?? {}) as Data;
  if (caps['staff_positions'] !== true) return null;
  const v = data?.staff_positions as Data | undefined;
  if (!v || !Array.isArray(v['positions']) || typeof v['version'] !== 'number') return null;
  return v as unknown as StaffPositions;
}
export const positionLabel = (list: StaffPositions, code: unknown) =>
  typeof code === 'string' ? (list.positions.find((p) => p.code === code)?.label ?? code) : '-';
/** Positions a card may take: the active ones and the ones it already has. */
export function selectablePositions(list: StaffPositions, current: readonly unknown[] = []) {
  return list.positions.filter((p) => p.active || current.includes(p.code));
}
export const extraCodes = (payload: Data): string[] =>
  Array.isArray(payload['extra_position_codes'])
    ? (payload['extra_position_codes'] as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      )
    : [];
/** «Доп. станции»: the labels of the extra positions, «-» without. */
export function extraText(list: StaffPositions, payload: Data) {
  const extra = extraCodes(payload);
  return extra.length ? extra.map((c) => positionLabel(list, c)).join(', ') : '-';
}
export function accessLabel(payload: Data) {
  const access = String(payload['pos_access'] ?? '');
  return POS_ACCESS_LABELS[access] ?? 'Не задан';
}
/**
 * «Доступы» (design-backoffice 5): the cash desk with its PIN, the kitchen screens of the
 * stations of the position and the extra stations (one shared kitchen login), or «Нет».
 */
export function accessText(list: StaffPositions, payload: Data) {
  const parts: string[] = [];
  const access = payload['pos_access'];
  if (access === 'cashier') parts.push('Касса (PIN)');
  if (access === 'shift_manager') parts.push('Касса: начальник смены (PIN)');
  const codes = [payload['position_code'], ...extraCodes(payload)].filter(
    (v): v is string => typeof v === 'string',
  );
  const screens = [
    ...new Set(
      codes
        .map((c) => list.positions.find((p) => p.code === c))
        .filter((p): p is StaffPosition => !!p && p.kds.length > 0 && p.station !== null)
        .map((p) => p.station as number),
    ),
  ].sort((a, b) => a - b);
  if (screens.length)
    parts.push(
      `${screens.length === 1 ? 'экран' : 'экраны'} ${screens.join(', ')} общим входом кухни`,
    );
  if (payload['active'] === false || payload['deleted'] === true) return 'Нет: не работает';
  return parts.length ? parts.join(', ') : 'Нет';
}
/** Default cashier access of a position (prefilled when a position is picked). */
export const defaultAccess = (list: StaffPositions, code: string) =>
  list.positions.find((p) => p.code === code)?.pos_access ?? 'none';
/**
 * The position fields of the card editor's payload: what the form holds, validated here so the
 * person sees the problem in words before the server refuses it.
 */
export function positionPayload(
  list: StaffPositions,
  values: { position_code?: string; extra_position_codes?: string; pos_access?: string },
): Data {
  const position = values.position_code ?? '';
  const extra = (values.extra_position_codes ?? '').split(',').filter(Boolean);
  if (extra.length > MAX_EXTRA_POSITIONS)
    throw Error(`Доп. станций можно выбрать не больше ${MAX_EXTRA_POSITIONS}.`);
  if (position && extra.includes(position))
    throw Error('Доп. станция не может повторять основную должность.');
  const access = values.pos_access ?? 'none';
  if (!(access in POS_ACCESS_LABELS)) throw Error('Выберите доступ к кассе.');
  return {
    ...(position ? { position_code: position } : {}),
    extra_position_codes: extra,
    pos_access: access,
  };
}
/** The file name of the roster download, «PickChick-состав-кассы-DD.MM.YYYY.json». */
export function rosterFileName(generatedAt: string) {
  const day = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Almaty',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(generatedAt));
  return `PickChick-состав-кассы-${day}.json`;
}
const plural = (n: number, forms: [string, string, string]) => {
  const a = Math.abs(n) % 100,
    b = a % 10;
  return forms[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2];
};
/** What the roster gives the cash desk, in one line. */
export function rosterSummary(roster: { staff?: unknown }) {
  const staff = Array.isArray(roster.staff) ? (roster.staff as Data[]) : [];
  const cashier = staff.filter((s) => s['role'] === 'cashier').length;
  const managers = staff.filter((s) => s['role'] === 'shift_manager').length;
  return `В выгрузке ${staff.length} ${plural(staff.length, ['карточка', 'карточки', 'карточек'])}: кассиров ${cashier}, начальников смены ${managers}. Остальные без доступа к кассе.`;
}
/** A new position code that is not in the list yet. */
export function newPositionCode(list: readonly StaffPosition[]) {
  let n = 1;
  while (list.some((p) => p.code === `custom_${n}`)) n++;
  return `custom_${n}`;
}
