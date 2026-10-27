import type { CartLine, CatalogMode } from './model';

/**
 * Drinkit-style cart bar (owner request 27.10.2026): Kaspi handle, the total only and photos of
 * the last added items. Pure helpers so the store, the bar and Node tests share one source.
 */
export const CART_BAR_PHOTOS = 3;
/** Stored history is bounded; the bar only shows three photos. */
export const RECENT_PRODUCTS_LIMIT = 20;

/** A saved recency list from AsyncStorage; anything unexpected is ignored, never trusted. */
export function parseRecentProductIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > RECENT_PRODUCTS_LIMIT) return undefined;
  if (!value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100))
    return undefined;
  return [...new Set(value as string[])];
}

/**
 * Newest first. Every add action moves its products to the front (adding a product again makes it
 * the newest); products no longer in the basket are dropped.
 */
export function noteCartAdditions(
  recent: readonly string[],
  added: readonly string[],
  cart: readonly Pick<CartLine, 'product'>[],
): string[] {
  const inCart = new Set(cart.map((line) => line.product.id));
  const next: string[] = [];
  for (const id of [...added].reverse()) if (inCart.has(id) && !next.includes(id)) next.push(id);
  for (const id of recent) if (inCart.has(id) && !next.includes(id)) next.push(id);
  return next.slice(0, RECENT_PRODUCTS_LIMIT);
}

/**
 * Lines whose photos the bar shows, newest first and one per product. Products without a recorded
 * add (a cart restored without history) follow in reverse cart order, the order they were added.
 */
export function recentCartLines<T extends Pick<CartLine, 'product'>>(
  cart: readonly T[],
  recent: readonly string[] | undefined,
  limit = CART_BAR_PHOTOS,
): T[] {
  const byProduct = new Map<string, T>();
  for (const line of [...cart].reverse())
    if (!byProduct.has(line.product.id)) byProduct.set(line.product.id, line);
  const ordered: T[] = [];
  for (const id of recent ?? []) {
    const line = byProduct.get(id);
    if (line && !ordered.includes(line)) ordered.push(line);
  }
  for (const line of byProduct.values()) if (!ordered.includes(line)) ordered.push(line);
  return ordered.slice(0, Math.max(0, limit));
}

export interface CartBarLayout {
  /** Photos shown at most; fewer on narrow screens and with large text. */
  photos: number;
  photoSize: number;
  handleWidth: number;
  totalSize: number;
  compact: boolean;
}

/** Large text and 320 pt screens keep the total readable by showing fewer, smaller photos. */
export function cartBarLayout(input: {
  width: number;
  fontScale: number;
  totalLength: number;
}): CartBarLayout {
  const scale = Math.min(Math.max(input.fontScale || 1, 1), 2);
  const narrow = input.width < 360;
  const long = input.totalLength > 9;
  const compact = narrow || scale > 1.2 || long;
  const photos =
    scale > 1.45 || (narrow && long && scale > 1.2)
      ? 1
      : scale > 1.2 || (narrow && long)
        ? 2
        : CART_BAR_PHOTOS;
  return {
    photos,
    photoSize: compact ? 42 : 48,
    handleWidth: compact ? 64 : 76,
    totalSize: long && narrow ? 17 : compact ? 18 : 20,
    compact,
  };
}

/** Where a released handle leads: the payment, the cart (with the reason) or nothing. */
export type SlideToPayTarget = 'checkout' | 'cart';

/**
 * The handle is a payment control only where checkout is the guarded Kaspi checkout: the build
 * enables it, it is not the order simulator, the catalogue is the server menu (not the design
 * samples or a preview) and accounts are server accounts (not the local demonstration).
 */
export function slideToPayAvailable(input: {
  kaspiCheckout: boolean;
  orderSimulator: boolean;
  catalogMode: CatalogMode;
  accountMode: 'demo' | 'server';
}): boolean {
  return (
    input.kaspiCheckout &&
    !input.orderSimulator &&
    input.catalogMode === 'server' &&
    input.accountMode === 'server'
  );
}

/** Same conditions that disable «Оформить заказ» on the cart page (M09). */
export function cartCheckoutBlocked(model: {
  cart: readonly Pick<CartLine, 'product'>[];
  catalogUpdatePending?: boolean;
  comboRewards?: { selected: boolean; giftItemIndex: number | undefined; discountMinor: string };
}): boolean {
  return (
    !model.cart.length ||
    !!model.catalogUpdatePending ||
    model.cart.some((line) => line.product.available === false) ||
    (!!model.comboRewards?.selected &&
      (model.comboRewards.giftItemIndex === undefined || model.comboRewards.discountMinor === '0'))
  );
}
