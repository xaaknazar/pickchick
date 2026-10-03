import { randomUUID } from 'node:crypto';
import { MenuSnapshotSchema } from '@pickchick/contracts';
import type { MenuSnapshot } from '@pickchick/contracts';
import { localCatalogId } from './availability.js';

/** Structural input avoids a dependency cycle between the CMS and transport. */
export interface CatalogMenuPayload {
  categories: { id: string; name: { ru: string; kk: string } }[];
  products: {
    id: string;
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

/** Shares identities with installed POS v1/v2 and the availability projection. */
export function projectCatalogMenu(
  payload: CatalogMenuPayload,
  branchId: string,
  version: number,
  publishedAt: string,
  releaseId = randomUUID(),
): MenuSnapshot {
  if (payload.products.some((p) => Object.keys(p.channel_prices_minor ?? {}).length))
    throw new Error('CHANNEL_PRICES_NOT_SUPPORTED');
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
    throw new Error('UNAVAILABLE_LINKED_PRODUCT');
  const text = (value: { ru: string; kk: string }) => ({ ru: value.ru, kk: value.kk || '-' });
  return MenuSnapshotSchema.parse({
    schema_version: 1,
    branch_id: branchId,
    release_id: releaseId,
    version,
    published_at: publishedAt,
    items: payload.products
      .filter((p) => p.available)
      .map((product) => ({
        product_id: localCatalogId(branchId, 'product', product.id),
        variant_id: localCatalogId(branchId, 'base-preview', product.id),
        category_id: localCatalogId(
          branchId,
          'category',
          payload.categories.find((c) => c.id === product.category_id)?.name.ru ??
            product.category_id,
        ),
        name: text(product.name),
        price_minor: product.price_minor,
        currency: 'KZT',
        ...(/^(?:i\d+|shot)\.jpg$/.test(product.image_asset_key)
          ? { image_url: `/assets/menu/${product.image_asset_key}` }
          : {}),
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
            };
          }),
        })),
      })),
  });
}
