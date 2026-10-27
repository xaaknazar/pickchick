import { randomUUID } from 'expo-crypto';
import { useLocalSearchParams } from 'expo-router';
import { createSlidePayIntents } from './slide-pay-intent';

/** Route parameter of `/checkout` that carries a slide-to-pay intent from the cart bar. */
export const SLIDE_PAY_PARAM = 'slide';

/** One registry per app process; nothing is persisted (see slide-pay-intent.ts). */
export const slidePayIntents = createSlidePayIntents({ now: Date.now, nonce: randomUUID });

/** The raw intent of the current checkout route, if any. Taking it is up to the checkout. */
export function useSlidePayIntent(active: boolean): string | null {
  const params = useLocalSearchParams<{ slide?: string | string[] }>();
  const raw = params[SLIDE_PAY_PARAM];
  return active && typeof raw === 'string' && raw ? raw : null;
}
