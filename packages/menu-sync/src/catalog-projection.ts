import { randomUUID } from 'node:crypto';
import { MenuSnapshotSchema } from '@pickchick/contracts';
import type { MenuSnapshot } from '@pickchick/contracts';
import { localCatalogId } from './availability.js';

export type CatalogProjectionErrorCode =
  'CHANNEL_PRICES_NOT_SUPPORTED' | 'UNAVAILABLE_LINKED_PRODUCT';
/** Typed projection failure; the message stays the bare code for existing callers. */
export class CatalogProjectionError extends Error {
  constructor(readonly code: CatalogProjectionErrorCode) {
    super(code);
    this.name = 'CatalogProjectionError';
  }
}

/** Structural input avoids a dependency cycle between the CMS and transport. */
export interface CatalogMenuPayload {
  categories: { id: string; name: { ru: string; kk: string } }[];
  products: {
    id: string;
    sku: string;
    kind: 'item' | 'combo' | 'set';
    description: { ru: string; kk: string };
    prep_required: boolean;
    combo_components: readonly { product_id: string }[];
    kitchen_route?: 'prep' | 'assembly_item' | undefined;
    image?: { sha256: string } | undefined;
    category_id: string;
    image_asset_key: string;
    name: { ru: string; kk: string };
    price_minor: string;
    available: boolean;
    channel_prices_minor?:
      | { mobile?: string | undefined; pos?: string | undefined; kiosk?: string | undefined }
      | undefined;
    modifier_groups: {
      id: string;
      title: { ru: string; kk: string };
      min: number;
      max: number;
      options: {
        id: string;
        label: { ru: string; kk: string };
        price_delta_minor: string;
        default_quantity: number;
        max_quantity: number;
        available: boolean;
        linked_product_id: string | null;
      }[];
    }[];
  }[];
}

export interface CatalogProjectionOptions {
  /**
   * Cashier combo stop fields (stage 2, CATALOG_EDGE_COMBO_STOPS_ENABLED, default off): fixed
   * components as combo_component_variant_ids and option links as linked_variant_id. Off, the
   * projection is byte-identical to the one installed edges accept (same checksum).
   */
  comboStops?: boolean;
}

/** Deepest fixed-component level the combo stop rule follows (catalogStopView: depth 1..5). */
const COMPONENT_LEVELS = 5;
/** Fixed components of a product, nested combos flattened level by level, each id once. */
function fixedComponentIds(
  products: ReadonlyMap<string, CatalogMenuPayload['products'][number]>,
  productId: string,
): string[] {
  const seen = new Set<string>([productId]);
  const result: string[] = [];
  let level = [productId];
  for (let depth = 1; depth <= COMPONENT_LEVELS && level.length; depth++) {
    const next: string[] = [];
    for (const id of level)
      for (const { product_id: childId } of products.get(id)?.combo_components ?? []) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        result.push(childId);
        next.push(childId);
      }
    level = next;
  }
  return result;
}

/**
 * The publication exactly as installed edges and clients know it: the cashier combo stop fields
 * removed. Returns the same object when there is nothing to remove (byte-identical replies).
 */
export function withoutComboStopLinks(menu: MenuSnapshot): MenuSnapshot {
  const marked = menu.items.some(
    (item) =>
      item.combo_component_variant_ids !== undefined ||
      item.modifier_groups?.some((g) => g.options.some((o) => o.linked_variant_id !== undefined)),
  );
  if (!marked) return menu;
  return {
    ...menu,
    items: menu.items.map((item) => {
      const copy = { ...item };
      delete copy.combo_component_variant_ids;
      if (copy.modifier_groups)
        copy.modifier_groups = copy.modifier_groups.map((group) => ({
          ...group,
          options: group.options.map((option) => {
            const plain = { ...option };
            delete plain.linked_variant_id;
            return plain;
          }),
        }));
      return copy;
    }),
  };
}

/**
 * Shares identities with installed POS v1/v2 and the availability projection.
 * Unified-menu fields are optional additions; legacy ids, prices and option ids are unchanged.
 */
export function projectCatalogMenu(
  payload: CatalogMenuPayload,
  branchId: string,
  version: number,
  publishedAt: string,
  releaseId = randomUUID(),
  options: CatalogProjectionOptions = {},
): MenuSnapshot {
  if (payload.products.some((p) => Object.keys(p.channel_prices_minor ?? {}).length))
    throw new CatalogProjectionError('CHANNEL_PRICES_NOT_SUPPORTED');
  const available = new Set(payload.products.filter((p) => p.available).map((p) => p.id));
  if (
    payload.products.some(
      (p) =>
        p.available &&
        p.modifier_groups.some((g) =>
          g.options.some(
            (o) => o.available && o.linked_product_id && !available.has(o.linked_product_id),
          ),
        ),
    )
  )
    throw new CatalogProjectionError('UNAVAILABLE_LINKED_PRODUCT');
  const text = (value: { ru: string; kk: string }) => ({ ru: value.ru, kk: value.kk || '-' });
  const categoryId = (product: { category_id: string }) =>
    localCatalogId(
      branchId,
      'category',
      payload.categories.find((c) => c.id === product.category_id)?.name.ru ?? product.category_id,
    );
  // Category ids keep the RU-name hash; equal names already share one POS category.
  const categories = new Map<
    string,
    { id: string; source_id: string; name: { ru: string; kk: string }; sort_order: number }
  >();
  payload.categories.forEach((category, index) => {
    const id = localCatalogId(branchId, 'category', category.name.ru);
    if (!categories.has(id))
      categories.set(id, {
        id,
        source_id: category.id,
        name: text(category.name),
        sort_order: index,
      });
  });
  const order = new Map(payload.products.map((product, index) => [product.id, index]));
  const included = payload.products.filter((p) => p.available);
  const categoriesComplete = included.every((p) => categories.has(categoryId(p)));
  // Same identities and links as catalogStopView, over every catalog product (published or not).
  const byId = new Map(payload.products.map((product) => [product.id, product]));
  const stopVariant = (productId: string) => localCatalogId(branchId, 'base-preview', productId);
  const components = (productId: string) => {
    if (!options.comboStops) return {};
    const ids = fixedComponentIds(byId, productId);
    return ids.length ? { combo_component_variant_ids: ids.map(stopVariant) } : {};
  };
  const link = (option: { id: string; linked_product_id: string | null }) => {
    if (!options.comboStops) return {};
    const linked = option.linked_product_id ?? (byId.has(option.id) ? option.id : null);
    return linked === null ? {} : { linked_variant_id: stopVariant(linked) };
  };
  return MenuSnapshotSchema.parse({
    schema_version: 1,
    branch_id: branchId,
    release_id: releaseId,
    version,
    published_at: publishedAt,
    ...(categoriesComplete ? { categories: [...categories.values()] } : {}),
    items: included.map((product) => {
      const image = product.image
        ? { sha256: product.image.sha256, url: `/assets/menu/${product.image.sha256}.webp` }
        : undefined;
      return {
        product_id: localCatalogId(branchId, 'product', product.id),
        variant_id: localCatalogId(branchId, 'base-preview', product.id),
        category_id: categoryId(product),
        name: text(product.name),
        price_minor: product.price_minor,
        currency: 'KZT',
        ...(image
          ? { image_url: image.url, image }
          : /^(?:i\d+|shot)\.jpg$/.test(product.image_asset_key)
            ? { image_url: `/assets/menu/${product.image_asset_key}` }
            : {}),
        source_id: product.id,
        sku: product.sku,
        kind: product.kind,
        sort_order: order.get(product.id),
        ...(/\S/.test(product.description.ru)
          ? { description: { ru: product.description.ru, kk: product.description.kk } }
          : {}),
        kitchen: {
          route: product.kitchen_route ?? (product.prep_required ? 'prep' : 'assembly_item'),
          ...(product.kind !== 'item' && product.combo_components.length === 0
            ? { unexpanded_combo: 'whole_product' }
            : {}),
        },
        modifier_groups: product.modifier_groups.map((group) => ({
          id: localCatalogId(branchId, 'modifier-group', `${product.id}:${group.id}`),
          name: text(group.title),
          min_selected: group.min,
          max_selected: group.max,
          options: group.options.map((option) => {
            const enabled = option.available;
            return {
              id: localCatalogId(
                branchId,
                'modifier-option',
                `${product.id}:${group.id}:${option.id}`,
              ),
              name: text(option.label),
              price_minor: option.price_delta_minor,
              default_quantity: enabled ? option.default_quantity : 0,
              max_quantity: option.max_quantity,
              available: enabled,
              ...link(option),
            };
          }),
        })),
        ...components(product.id),
      };
    }),
  });
}
