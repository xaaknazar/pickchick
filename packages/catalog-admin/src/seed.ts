import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';
import { CatalogPayloadSchema } from './contracts.js';
// Source data only: never adopts TEST branch, credentials, quote or payment effects.
// RU content is the owner's mockup. KK translations and verified nutrition/allergens are not invented.
const text = (ru: string) => ({ ru, kk: '' });
const names = [...new Set(testCompleteCatalog.products.map((product) => product.category))];
const categories = names.map((name, index) => ({ id: `category-${index + 1}`, name: text(name) }));
export const mockupCatalogDraft = CatalogPayloadSchema.parse({
  schema_version: 1,
  currency: 'KZT',
  content_source: 'mockup',
  content_reviewed: false,
  categories,
  products: testCompleteCatalog.products.map((product) => ({
    id: product.id,
    sku: product.id,
    name: text(product.name),
    description: text(product.description),
    category_id: categories[names.indexOf(product.category)]!.id,
    price_minor: product.price_minor,
    image_asset_key: product.image_id,
    available: true,
    prep_required: product.prep_required,
    prep_minutes: product.prep_minutes,
    serving_label: text(product.serving_label),
    weight_g: /^\d+ г$/.test(product.serving_label)
      ? Number(product.serving_label.split(' ')[0])
      : null,
    volume_ml: /^\d+ мл$/.test(product.serving_label)
      ? Number(product.serving_label.split(' ')[0])
      : null,
    ingredients: text(product.ingredients),
    allergens: product.allergens,
    allergens_status: 'unknown',
    nutrition: product.nutrition,
    nutrition_status: 'unverified',
    kind:
      product.category === 'На компанию'
        ? 'set'
        : ['Комбо', 'На двоих'].includes(product.category)
          ? 'combo'
          : 'item',
    combo_components: [],
    modifier_groups: product.modifier_groups.map((group) => ({
      ...group,
      title: text(group.title),
      options: group.options.map((option) => ({
        ...option,
        label: text(option.label),
        linked_product_id: null,
      })),
    })),
  })),
  estimated_minutes: testCompleteCatalog.estimated_minutes,
  upsell_product_ids: testCompleteCatalog.upsell_product_ids,
});
