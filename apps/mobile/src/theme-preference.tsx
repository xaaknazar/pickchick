import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';
import { THEME_PREFERENCES, applyTheme, resolveTheme, type ThemePreference } from './theme';

/**
 * «Оформление» (owner 23.11.2026): «Как в системе» by default, or «Светлая», «Тёмная», «Синяя».
 * The choice lives on this device only. A build may set EXPO_PUBLIC_THEME (light, dark or blue)
 * as the default instead of the system's mode: the browser checks and screenshots use dark.
 */
export const THEME_STORAGE_KEY = 'pickchick.theme.v1';

function buildDefault(): ThemePreference {
  // Static member access only: Expo inlines exactly `process.env.EXPO_PUBLIC_*`.
  const value = process.env.EXPO_PUBLIC_THEME;
  return value === 'light' || value === 'dark' || value === 'blue' ? value : 'system';
}

let preference: ThemePreference = buildDefault();
const listeners = new Set<() => void>();

function systemScheme(): 'light' | 'dark' | null {
  const scheme = Appearance.getColorScheme();
  return scheme === 'light' || scheme === 'dark' ? scheme : null;
}

function apply() {
  applyTheme(resolveTheme(preference, systemScheme()));
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function setThemePreference(next: ThemePreference): void {
  if (next === preference) return;
  preference = next;
  apply();
  listeners.forEach((listener) => listener());
  void AsyncStorage.setItem(THEME_STORAGE_KEY, next).catch(() => {});
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getThemePreference, getThemePreference);
}

// The system's mode is known synchronously, so the first frame already has the right colours.
apply();

// The saved choice is read from storage after launch. Until it is known the root keeps the
// launch screen up, so no screen is first drawn in one look and then switched to another
// (build 52: dark menu cards on the light page).
let restored = false;
const getRestored = () => restored;

/** False until the saved «Оформление» has been read; the root waits for it before drawing. */
export function useThemeRestored(): boolean {
  return useSyncExternalStore(subscribe, getRestored, getRestored);
}

/** Mounted once at the root: restores the saved choice and follows the system's mode. */
export function ThemeController() {
  useEffect(() => {
    let alive = true;
    void AsyncStorage.getItem(THEME_STORAGE_KEY)
      .then((saved) => {
        if (alive && isThemePreference(saved) && saved !== preference) {
          preference = saved;
          apply();
        }
      })
      .catch(() => {})
      .finally(() => {
        restored = true;
        listeners.forEach((listener) => listener());
      });
    const subscription = Appearance.addChangeListener(() => apply());
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return null;
}
