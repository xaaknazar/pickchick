/** Local demo profile data only; no customer identity or loyalty effects. */
export interface DemoProfileInput {
  nickname: string;
  birthDate: string | null;
  gender: 'female' | 'male' | null;
}

export interface DemoProfile extends DemoProfileInput {
  completedAt: number | null;
}

const almatyCalendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Almaty',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function calendarDate(value: string): { year: number; month: number; day: number } | null {
  if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || year < 1900) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return { year, month, day };
}

/** Date-only value. The future boundary follows the restaurant's Almaty calendar. */
export function isValidBirthDate(value: string, now: number = Date.now()): boolean {
  if (!calendarDate(value) || !Number.isFinite(now)) return false;
  try {
    const parts = almatyCalendar.formatToParts(new Date(now));
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    return !!year && !!month && !!day && value <= `${year}-${month}-${day}`;
  } catch {
    return false;
  }
}

/** A Russian numeric date, without UTC conversion or day/month shifts. */
export function formatBirthDate(value: string | null): string {
  if (!value || !calendarDate(value)) return '';
  return `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}`;
}

/** Trim optional nickname; preserve a date as YYYY-MM-DD, never as a timestamp. */
export function normalizeProfileDetails(
  value: unknown,
  now: number = Date.now(),
): DemoProfileInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'birthDate,gender,nickname') return null;
  if (typeof input.nickname !== 'string') return null;
  const nickname = input.nickname.trim();
  if ([...nickname].length > 32) return null;
  if (
    input.birthDate !== null &&
    (typeof input.birthDate !== 'string' || !isValidBirthDate(input.birthDate, now))
  )
    return null;
  if (input.gender !== null && input.gender !== 'female' && input.gender !== 'male') return null;
  return { nickname, birthDate: input.birthDate, gender: input.gender };
}

export function emptyDemoProfile(): DemoProfile {
  return { nickname: '', birthDate: null, gender: null, completedAt: null };
}
