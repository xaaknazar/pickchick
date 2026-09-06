import type { CartLine, CatalogMode, Product } from './model';

export const MAX_ITEM_QUANTITY = 20;

export function money(minor: string): string {
  if (!/^(0|[1-9]\d{0,18})$/.test(minor)) throw new Error('Invalid money');
  const value = BigInt(minor);
  const whole = (value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const fraction = value % 100n;
  return `${whole}${fraction ? `,${fraction.toString().padStart(2, '0')}` : ''} ₸`;
}

export function cartTotal(lines: CartLine[]): string {
  return lines
    .reduce((total, line) => total + BigInt(line.product.priceMinor) * BigInt(line.quantity), 0n)
    .toString();
}

// A late approval response must not erase a different basket the guest built
// while the request was pending, or while viewing an older order.
export function clearMatchingCart(
  lines: CartLine[],
  expected?: { id: string; quantity: number }[],
): CartLine[] {
  if (
    expected &&
    (lines.length !== expected.length ||
      new Set(expected.map((line) => line.id)).size !== expected.length ||
      !lines.every((line) =>
        expected.some((item) => item.id === line.product.id && item.quantity === line.quantity),
      ))
  )
    return lines;
  return [];
}

export function updateQuantity(lines: CartLine[], product: Product, quantity: number): CartLine[] {
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_ITEM_QUANTITY) return lines;
  if (lines.some((line) => line.product.source !== product.source)) return lines;
  const rest = lines.filter((line) => line.product.id !== product.id);
  if (quantity === 0) return rest;
  const existing = lines.findIndex((line) => line.product.id === product.id);
  const next = { product, quantity };
  if (existing < 0) return [...rest, next];
  return lines.map((line) => (line.product.id === product.id ? next : line));
}

export interface SavedPreferences {
  version: 1;
  catalogMode: CatalogMode;
  diningMode: 'takeaway' | 'dine_in';
  locale: 'ru' | 'kk';
  nickname: string;
  branchId: string | null;
  releaseId: string | null;
  lines: { id: string; quantity: number }[];
}

export function parsePreferences(raw: string | null): SavedPreferences | null {
  if (!raw || raw.length > 20000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const p = value as Record<string, unknown>;
    if (
      p.version !== 1 ||
      !['server', 'design'].includes(String(p.catalogMode)) ||
      !['takeaway', 'dine_in'].includes(String(p.diningMode)) ||
      !['ru', 'kk'].includes(String(p.locale)) ||
      typeof p.nickname !== 'string' ||
      p.nickname.length > 32 ||
      !(p.branchId === null || typeof p.branchId === 'string') ||
      !(p.releaseId === null || typeof p.releaseId === 'string') ||
      !Array.isArray(p.lines) ||
      p.lines.length > 100
    )
      return null;
    const ids = new Set<string>();
    for (const line of p.lines) {
      if (
        !line ||
        typeof line !== 'object' ||
        typeof line.id !== 'string' ||
        line.id.length > 100 ||
        !Number.isInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > MAX_ITEM_QUANTITY ||
        ids.has(line.id)
      )
        return null;
      ids.add(line.id);
    }
    return p as unknown as SavedPreferences;
  } catch {
    return null;
  }
}

export function restoreCart(
  preferences: SavedPreferences | null,
  products: Product[],
  currentReleaseId: string | null,
): CartLine[] {
  if (!preferences || preferences.releaseId !== currentReleaseId) return [];
  const byId = new Map(products.map((product) => [product.id, product]));
  return preferences.lines.flatMap((line) => {
    const product = byId.get(line.id);
    return product && product.source === preferences.catalogMode
      ? [{ product, quantity: line.quantity }]
      : [];
  });
}
