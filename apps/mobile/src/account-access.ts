import type { ScreenId } from './model';
import { STORE_BUILD } from './store-build.ts';

const orderScreens: readonly string[] = [
  'M12',
  'M13',
  'M14',
  'M15',
  'M16',
  'M17',
  'M18',
  'M19',
  'M20',
  'M21',
  'M22',
];
export type AccountDestination = ScreenId | 'pick-blocks' | 'pick-man' | 'pick-farm' | 'magic-sort';

/**
 * Review 29.10.2026 (App Review 5.1.1, sign-in for features that need no account): the mini-games
 * keep only a personal best on this device. In the App Store build a guest opens «События» and
 * plays Pick Blocks, Pick Man and Magic Sort without signing in; ordering, the profile and Pick
 * Farm (server progress, off in that build) still need the account. Other builds keep the wall.
 */
export function guestCanOpen(destination: AccountDestination, store = STORE_BUILD): boolean {
  return store && ['M26', 'pick-blocks', 'pick-man', 'magic-sort'].includes(destination as string);
}

export function requiresAccount(id: ScreenId, preview: boolean, store = STORE_BUILD): boolean {
  return (
    (!preview && (id === 'M30' || (id === 'M26' && !guestCanOpen(id, store)))) ||
    id === 'M27' ||
    id === 'M28' ||
    (!preview && orderScreens.includes(id))
  );
}

export function accountDestination(value: unknown): AccountDestination | null {
  return typeof value === 'string' &&
    (value === 'M30' ||
      value === 'M26' ||
      // The Kaspi cart pays (27.10.2026); browsing the cart itself never requires an account.
      value === 'M09' ||
      value === 'pick-man' ||
      value === 'pick-farm' ||
      value === 'magic-sort' ||
      value === 'pick-blocks' ||
      value === 'M27' ||
      value === 'M28' ||
      value === 'M31' ||
      value === 'M35' ||
      orderScreens.includes(value))
    ? (value as AccountDestination)
    : null;
}

export function accountCanAct(state: { ready: boolean; account: unknown }): boolean {
  return state.ready && Boolean(state.account);
}
