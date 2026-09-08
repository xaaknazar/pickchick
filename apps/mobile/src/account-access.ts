import type { ScreenId } from './model';

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
export type AccountDestination = ScreenId | 'pick-blocks';

export function requiresAccount(id: ScreenId, preview: boolean): boolean {
  return id === 'M27' || id === 'M28' || (!preview && orderScreens.includes(id));
}

export function accountDestination(value: unknown): AccountDestination | null {
  return typeof value === 'string' &&
    (value === 'pick-blocks' || value === 'M27' || value === 'M28' || orderScreens.includes(value))
    ? (value as AccountDestination)
    : null;
}

export function accountCanAct(state: { ready: boolean; account: unknown }): boolean {
  return state.ready && Boolean(state.account);
}
