import type { ComboProgressState } from './loyalty/combo-progress';

/**
 * What the App Store build shows (owner 29.10.2026, «устрани это все»).
 *
 * App Review Guideline 2.1 (App Completeness) rejects placeholder and «coming soon» content and
 * features that do not work; Apple asks to remove every mention of Apple Pay when the app does
 * not use it. The App Store build is the Kaspi customer build (`EXPO_PUBLIC_KASPI_CHECKOUT=1`, the
 * `storefront` / `production` release profiles). In it:
 *
 * - payment: only Kaspi.kz. Apple Pay / Google Pay / bank card are not listed, not named and have
 *   no mark. `EXPO_PUBLIC_UPCOMING_PAYMENTS=1` (default off) lists them again as disabled «скоро»
 *   rows in «Способ оплаты», as before 29.10.2026 (payment-method.ts);
 * - a feature that does not work yet has no entry point at all (no card, row, section or screen)
 *   instead of announcing itself: the Chiki programme and its peaks, missions and promo codes, the
 *   «скоро» sections of «События», the 6 + 1 card while the server does not run the programme, the
 *   push settings while the server's push service is not connected;
 * - real temporary states stay (closed, offline, item on stop, server refused, payment pending).
 *
 * Simulator, test-order and design builds (no Kaspi checkout) and the design preview (`preview`)
 * keep showing everything. Kept free of Expo imports for Node tests; Expo inlines both
 * `process.env.EXPO_PUBLIC_*` reads at bundle time (static member access only).
 */
export const STORE_BUILD = process.env.EXPO_PUBLIC_KASPI_CHECKOUT === '1';
/** Lists Apple Pay / Google Pay / bank card as disabled «скоро» methods. Default off. */
export const UPCOMING_PAYMENTS = process.env.EXPO_PUBLIC_UPCOMING_PAYMENTS === '1';

/**
 * Screens that only preview what does not work yet, opened by an old link or a deep link
 * (/screen/M23): the Chiki wallet, its history and missions (M23-M25), the refund placeholder
 * (M22) and the rating placeholder (M35; the Kaspi build rates a completed order in place).
 */
export const STORE_HIDDEN_SCREENS: readonly string[] = ['M22', 'M23', 'M24', 'M25', 'M35'];

/** The App Store build opens the menu instead of a preview-only screen. */
export function storeHidesScreen(id: string, store = STORE_BUILD, preview = false): boolean {
  return store && !preview && STORE_HIDDEN_SCREENS.includes(id);
}

/**
 * Entry points of features that are not live: the menu's «Чики за любимый вкус» card, the
 * profile's «Мои Чики и уровни» and «Программа Чиков» (missions, promo codes), the «Миссии» and
 * «Скоро» sections of «События». Shown outside the App Store build and in the design preview.
 */
export function upcomingFeaturesShown(store = STORE_BUILD, preview = false): boolean {
  return preview || !store;
}

/**
 * The «Купи 6 комбо, 7-е в подарок» card. The server is the authority: in the App Store build the
 * card appears only while the server runs the programme (`/combo-rewards` answers `enabled: true`
 * with the customer's stamps). Switched off on the server (the state of 29.10.2026), signed out,
 * still loading or unreadable: no card, instead of «Отметки пока у кассира».
 */
export function comboCardShown(
  progress: ComboProgressState | undefined,
  store = STORE_BUILD,
  preview = false,
): boolean {
  return preview || !store || (progress?.status === 'ready' && !!progress.commercial);
}

/**
 * Push settings («О моих заказах», «События и предложения»). In the App Store build they are hidden
 * while the server's push service is not connected for this platform, instead of disabled switches
 * and «Сервис уведомлений ещё не подключён». The web notice and the sign-in hint stay (true).
 */
export function pushSettingsShown(
  reason: 'web' | 'login' | 'service' | null,
  store = STORE_BUILD,
): boolean {
  return !store || reason !== 'service';
}

/**
 * The fiscal receipt block of an order. `deferred` is the policy of every app order today
 * (`fiscalPolicy: deferred_pilot`, cloud orders carry no receipt): no block at all instead of «чек
 * пока не выпускается - подключаем сервис». A pending or issued receipt is a real state and stays.
 */
export function receiptShown(receipt: 'deferred' | 'pending' | 'issued'): boolean {
  return receipt !== 'deferred';
}
