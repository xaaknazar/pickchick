export type BirthDatePickerProps = {
  value: string | null;
  onConfirm(date: string): void;
  onCancel(): void;
};

export const MINIMUM_BIRTH_DATE = '1900-01-01';

// The upper bound follows the restaurant's calendar, including on devices abroad.
export function almatyToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Almaty',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === name)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}

export function allowedBirthDate(value: string, maximum: string): boolean {
  return validDateOnly(value) && value >= MINIMUM_BIRTH_DATE && value <= maximum;
}

export function initialBirthDate(value: string | null, maximum: string): string {
  return value && allowedBirthDate(value, maximum) ? value : '2000-01-01';
}

// Do not parse a date-only string with new Date(value): that would use UTC midnight.
// The native picker uses the device calendar, so both directions use local fields.
export function birthDateAtLocalNoon(value: string): Date {
  return new Date(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)) - 1,
    Number(value.slice(8, 10)),
    12,
    0,
    0,
    0,
  );
}

export function birthDateFromNative(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}
