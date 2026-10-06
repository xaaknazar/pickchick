import { restoreCart, validSelections, type SavedPreferences } from './domain.ts';
import type { CatalogMobileStorefront } from '@pickchick/catalog-admin/contracts';
import type { Product, Locale, CartLine } from './model';
const displayCopy = (text: string) => text.replace(/[\u2013\u2014]/g, '-');

// Legacy baskets have no publication snapshot. Only restore an exact bundled
// release; projecting them onto today's publication would change their prices.
export function restoreLegacyPublishedCart(
  preferences: SavedPreferences,
  legacyProducts: Product[],
): CartLine[] {
  const version = preferences.releaseId?.replace(/^test:/, '');
  if (!version || !legacyProducts.every((product) => product.catalogVersion === version)) return [];
  return restoreCart(
    preferences,
    legacyProducts.map((product) => ({ ...product, source: 'server' })),
    preferences.releaseId,
  );
}

export function publishedCartStorageRelease(cart: CartLine[], currentRelease: string | null) {
  if (!cart.length) return currentRelease;
  const version = cart[0]!.product.catalogVersion;
  if (!version || cart.some((line) => line.product.catalogVersion !== version)) return null;
  return version.startsWith('published:') ? version : `test:${version}`;
}

export function publishedProductData(
  catalog: CatalogMobileStorefront,
  locale: Locale,
): Omit<Product, 'image'>[] {
  const localized = (text: { ru: string; kk: string }) => text[locale] || text.ru;
  return catalog.payload.products.map((item) => ({
    id: item.id,
    name: localized(item.name),
    description: displayCopy(localized(item.description)),
    category: localized(catalog.payload.categories.find((c) => c.id === item.category_id)!.name),
    priceMinor: item.channel_prices_minor?.mobile ?? item.price_minor,
    catalogVersion: `published:${catalog.branch.id}:${catalog.version}`,
    source: 'server',
    available: item.available,
    servingLabel: localized(item.serving_label),
    nutrition: item.nutrition,
    ingredients: displayCopy(localized(item.ingredients)),
    allergens: item.allergens,
    prepMinutes: item.prep_minutes,
    modifierGroups: item.modifier_groups.map((g) => ({
      id: g.id,
      title: localized(g.title),
      min: g.min,
      max: g.max,
      options: g.options.map((o) => ({
        id: o.id,
        label: localized(o.label),
        price_delta_minor: o.price_delta_minor,
        default_quantity: o.default_quantity,
        max_quantity: o.max_quantity,
        available: o.available,
        ...(o.nutrition_multiplier === undefined
          ? {}
          : { nutrition_multiplier: o.nutrition_multiplier }),
      })),
    })),
  }));
}

export function publishedCartVersion(cart: CartLine[], branchId: string): number | undefined {
  const versions = cart.map((line) => line.product.catalogVersion);
  if (!versions.some((v) => v?.startsWith('published:'))) return undefined;
  const first = versions[0];
  if (!first || versions.some((v) => v !== first)) throw new Error('CONFLICT');
  const prefix = `published:${branchId}:`;
  if (!first.startsWith(prefix)) throw new Error('CONFLICT');
  const version = Number(first.slice(prefix.length));
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('CONFLICT');
  return version;
}

export function reconcilePublishedCart(cart: CartLine[], products: Product[]) {
  const removed: string[] = [];
  const next = cart.flatMap((line) => {
    const product = products.find((p) => p.id === line.product.id);
    if (
      !product ||
      product.available === false ||
      !validSelections(product, line.selections ?? [])
    ) {
      removed.push(line.product.name);
      return [];
    }
    return [{ ...line, product }];
  });
  return { cart: next, removed };
}
