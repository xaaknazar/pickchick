import { randomUUID } from 'expo-crypto';
import { useLocalSearchParams } from 'expo-router';
import { createSlidePayIntents } from './slide-pay-intent';

/** Route parameter of `/cart` (the Kaspi cart with payment) that carries a slide-to-pay intent. */
export const SLIDE_PAY_PARAM = 'slide';

/** One registry per app process; nothing is persisted (see slide-pay-intent.ts). */
export const slidePayIntents = createSlidePayIntents({ now: Date.now, nonce: randomUUID });

/** The raw intent of the current cart route, if any. Taking it is up to the cart's session. */
export function useSlidePayIntent(active: boolean): string | null {
  const params = useLocalSearchParams<{ slide?: string | string[] }>();
  const raw = params[SLIDE_PAY_PARAM];
  return active && typeof raw === 'string' && raw ? raw : null;
}
