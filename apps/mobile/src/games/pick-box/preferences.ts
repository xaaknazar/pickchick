export const PREFERENCES_KEY = 'pickchick.pick-box.preferences.v1';
export type Preferences = { sound: boolean; haptics: boolean; tutorialDone: boolean };
export const DEFAULT_PREFERENCES: Preferences = { sound: true, haptics: true, tutorialDone: false };
export function parsePreferences(raw: string | null): Preferences {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object') return { ...DEFAULT_PREFERENCES };
    return Object.fromEntries(
      Object.entries(DEFAULT_PREFERENCES).map(([key, fallback]) => [
        key,
        typeof (value as Record<string, unknown>)[key] === 'boolean'
          ? (value as Record<string, unknown>)[key]
          : fallback,
      ]),
    ) as Preferences;
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}
