import { useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale } from './core';
import { subscribeTheme, themeVersion } from '../theme';
export * from './core';
/**
 * The current language. Also re-renders the caller when the guest switches «Оформление»
 * (owner 23.11.2026): every screen already calls this hook, and its styles read the palette.
 */
export function useLocale() {
  useSyncExternalStore(subscribeTheme, themeVersion, themeVersion);
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
