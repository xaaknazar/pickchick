import messages from './messages.json' with { type: 'json' };

export type Locale = 'ru' | 'kk' | 'en';
export const locales = ['kk', 'ru', 'en'] as const;
export const localeNames: Record<Locale, string> = { ru: 'Русский', kk: 'Қазақша', en: 'English' };
const dictionary = new Map(messages.map((entry) => [entry.ru, entry]));
let locale: Locale = 'ru';
const listeners = new Set<() => void>();
export function getLocale(): Locale {
  return locale;
}
export function setAppLocale(next: Locale) {
  if (!locales.includes(next) || next === locale) return;
  locale = next;
  for (const listener of listeners) listener();
}
export function subscribeLocale(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** Exact message lookup only. Never rewrites identifiers, URLs, user input or payment data. */
export function translate(
  source: string,
  language: Locale,
  values?: Record<string, string | number>,
): string {
  const translated = dictionary.get(source)?.[language] ?? source;
  return values
    ? translated.replace(/\{(\w+)\}/g, (token, name: string) =>
        Object.hasOwn(values, name) ? String(values[name]) : token,
      )
    : translated;
}
export function t(source: string, values?: Record<string, string | number>): string {
  return translate(source, locale, values);
}
export function dateLocale(language: Locale = locale) {
  return { ru: 'ru-KZ', kk: 'kk-KZ', en: 'en-GB' }[language];
}
/** Presentation adapter for existing server/status copy; unknown text passes through verbatim. */
export function localize<T>(value: T): T {
  return (typeof value === 'string' ? t(value) : value) as T;
}
