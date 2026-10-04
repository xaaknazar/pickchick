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
export type AccountDestination = ScreenId | 'pick-blocks' | 'pick-man' | 'pick-farm' | 'magic-sort';

export function requiresAccount(id: ScreenId, preview: boolean): boolean {
  return (
    (!preview && ['M30', 'M26'].includes(id)) ||
    id === 'M27' ||
    id === 'M28' ||
    (!preview && orderScreens.includes(id))
  );
}

export function accountDestination(value: unknown): AccountDestination | null {
  return typeof value === 'string' &&
    (value === 'M30' ||
      value === 'M26' ||
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
