import { testLineId, TestSelectionSchema } from '@pickchick/test-order-flow/contracts';
import type { CartLine, CatalogMode, Product, Selection, PaymentMethod } from './model';

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
    .reduce((total, line) => total + BigInt(lineUnitPrice(line)) * BigInt(line.quantity), 0n)
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
        expected.some((item) => item.id === cartLineKey(line) && item.quantity === line.quantity),
      ))
  )
    return lines;
  return [];
}

export function defaultSelections(product: Product): Selection[] {
  return (product.modifierGroups ?? []).flatMap((group) =>
    group.options
      .filter(
        (option) =>
          (option.default_quantity ?? (option.default_selected ? 1 : 0)) > 0 &&
          option.available !== false,
      )
      .map((option) => ({
        group_id: group.id,
        option_id: option.id,
        quantity: option.default_quantity ?? 1,
      })),
  );
}
export function selectionKey(selections: Selection[] = []): string {
  return [...selections]
    .sort((a, b) => `${a.group_id}:${a.option_id}`.localeCompare(`${b.group_id}:${b.option_id}`))
    .map((s) => `${s.group_id}:${s.option_id}:${s.quantity}`)
    .join(',');
}
export function cartLineKey(line: Pick<CartLine, 'product' | 'selections'>): string {
  return testLineId(line.product.id, line.selections);
}
export function validSelections(product: Product, selections: Selection[]): boolean {
  if (
    !Array.isArray(selections) ||
    selections.length > 40 ||
    new Set(selections.map((s) => `${s.group_id}:${s.option_id}`)).size !== selections.length
  )
    return false;
  const groups = product.modifierGroups ?? [];
  if (
    selections.some(
      (s) =>
        !Number.isInteger(s.quantity) ||
        s.quantity < 1 ||
        s.quantity > 40 ||
        !groups.some(
          (g) =>
            g.id === s.group_id &&
            g.options.some(
              (o) =>
                o.id === s.option_id &&
                o.available !== false &&
                s.quantity <= (o.max_quantity ?? 40),
            ),
        ),
    )
  )
    return false;
  return groups.every((g) => {
    const total = selections.filter((s) => s.group_id === g.id).reduce((n, s) => n + s.quantity, 0);
    return total >= g.min && total <= g.max;
  });
}
export function lineUnitPrice(line: Pick<CartLine, 'product' | 'selections'>): string {
  return (
    BigInt(line.product.priceMinor) +
    (line.selections ?? []).reduce((sum, selected) => {
      const option = line.product.modifierGroups
        ?.find((g) => g.id === selected.group_id)
        ?.options.find((o) => o.id === selected.option_id);
      return sum + BigInt(option?.price_delta_minor ?? '0') * BigInt(selected.quantity);
    }, 0n)
  ).toString();
}
export function selectionDescription(line: Pick<CartLine, 'product' | 'selections'>): string {
  return (line.selections ?? [])
    .map((selected) => {
      const option = line.product.modifierGroups
        ?.find((g) => g.id === selected.group_id)
        ?.options.find((o) => o.id === selected.option_id);
      return option ? option.label + (selected.quantity > 1 ? ` ×${selected.quantity}` : '') : '';
    })
    .filter(Boolean)
    .join(' · ');
}
export function preparationMinutes(lines: CartLine[]): number {
  if (!lines.length) return 0;
  return Math.min(
    120,
    Math.ceil(
      Math.max(...lines.map((l) => l.product.prepMinutes ?? 7)) +
        (lines.reduce((n, l) => n + l.quantity, 0) - 1) * 1.2,
    ),
  );
}
export function updateQuantity(
  lines: CartLine[],
  product: Product,
  quantity: number,
  selections?: Selection[],
): CartLine[] {
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_ITEM_QUANTITY) return lines;
  if (lines.some((line) => line.product.source !== product.source)) return lines;
  const chosen = selections ?? defaultSelections(product);
  if (!validSelections(product, chosen)) return lines;
  const next: CartLine = { product, quantity, ...(chosen.length ? { selections: chosen } : {}) };
  const key = cartLineKey(next);
  const rest = lines.filter((line) => cartLineKey(line) !== key);
  if (quantity === 0) return rest;
  const existing = lines.findIndex((line) => cartLineKey(line) === key);
  if (existing < 0) return lines.length >= 11 ? lines : [...rest, next];
  return lines.map((line) => (cartLineKey(line) === key ? next : line));
}

/** Editing replaces one exact line atomically, merging an identical configuration without dropping food. */
export function replaceCartLine(
  lines: CartLine[],
  original: CartLine,
  selections: Selection[],
  quantity: number,
): CartLine[] {
  const key = cartLineKey(original);
  const current = lines.find((line) => cartLineKey(line) === key);
  if (
    !current ||
    current.quantity !== original.quantity ||
    current.product.catalogVersion !== original.product.catalogVersion
  )
    return lines;
  if (
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_ITEM_QUANTITY ||
    !validSelections(current.product, selections)
  )
    return lines;
  const next = { product: current.product, selections, quantity };
  const nextKey = cartLineKey(next);
  const matching = lines.find((line) => cartLineKey(line) !== key && cartLineKey(line) === nextKey);
  if ((matching?.quantity ?? 0) + quantity > MAX_ITEM_QUANTITY) return lines;
  if (matching)
    return lines
      .filter((line) => cartLineKey(line) !== key)
      .map((line) => (line === matching ? { ...line, quantity: line.quantity + quantity } : line));
  return lines.map((line) => (cartLineKey(line) === key ? next : line));
}

export interface SavedPreferences {
  version: 1;
  catalogMode: CatalogMode;
  diningMode: 'takeaway' | 'dine_in';
  locale: 'ru' | 'kk';
  nickname: string;
  paymentMethod?: PaymentMethod;
  branchId: string | null;
  releaseId: string | null;
  lines: { id: string; quantity: number; selections?: Selection[] }[];
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
      (p.paymentMethod !== undefined && !['kaspi', 'card'].includes(String(p.paymentMethod))) ||
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
        (line.selections !== undefined &&
          (!Array.isArray(line.selections) ||
            line.selections.length > 40 ||
            line.selections.some((s: unknown) => !TestSelectionSchema.safeParse(s).success))) ||
        ids.has(line.id + '|' + selectionKey(line.selections))
      )
        return null;
      ids.add(line.id + '|' + selectionKey(line.selections));
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
  const upgrade =
    preferences &&
    ((preferences.releaseId === 'test:mockup-v0.2' && currentReleaseId === 'test:mockup-v0.3') ||
      (preferences.releaseId === 'mockup-v0.2' && currentReleaseId === 'mockup-v0.3'));
  if (!preferences || (!upgrade && preferences.releaseId !== currentReleaseId)) return [];
  const byId = new Map(products.map((product) => [product.id, product]));
  return preferences.lines.flatMap((line) => {
    const product = byId.get(line.id);
    const selections = product && upgrade ? defaultSelections(product) : line.selections;
    return product &&
      product.source === preferences.catalogMode &&
      validSelections(product, selections ?? [])
      ? [{ product, quantity: line.quantity, ...(selections?.length ? { selections } : {}) }]
      : [];
  });
}
