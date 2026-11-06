// Frozen copies of the strict schemas installed clients bundle (shared by the catalog tests).
import { createRequire } from 'node:module';

/**
 * Strict schema bundled in the installed kiosk build 7 and mobile TestFlight builds (catalog-admin
 * contracts of c3a0fbee without the later image and kitchen_route fields), frozen as a copy so a
 * future contract change cannot move it.
 */
export function frozenStorefrontSchemas() {
  const { z } = createRequire(
    new URL('../../packages/catalog-admin/package.json', import.meta.url),
  )('zod');
  const keys = [
    'i0.jpg',
    'i1.jpg',
    'i2.jpg',
    'i4.jpg',
    'i5.jpg',
    'i6.jpg',
    'i7.jpg',
    'i8.jpg',
    'i9.jpg',
    'i10.jpg',
    'i11.jpg',
    'i12.jpg',
    'i13.jpg',
    'i14.jpg',
    'i15.jpg',
    'i16.jpg',
    'i17.jpg',
    'i18.jpg',
    'i19.jpg',
    'i20.jpg',
    'i22.jpg',
    'i23.jpg',
    'shot.jpg',
    'generic-drink',
  ];
  const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
  const Minor = z.string().regex(/^(0|[1-9][0-9]{0,15})$/);
  const Text = z.strictObject({ ru: z.string().max(2000), kk: z.string().max(2000) });
  const Title = z.strictObject({
    ru: z.string().trim().min(1).max(150),
    kk: z.string().trim().max(150),
  });
  const Modifier = z.strictObject({
    id: Id,
    title: Title,
    min: z.int().min(0).max(100),
    max: z.int().min(1).max(100),
    options: z
      .array(
        z.strictObject({
          id: Id,
          label: Title,
          price_delta_minor: Minor,
          default_quantity: z.int().min(0).max(40),
          max_quantity: z.int().min(1).max(40),
          available: z.boolean(),
          nutrition_multiplier: z.number().positive().max(100).optional(),
          linked_product_id: Id.nullable(),
        }),
      )
      .min(1)
      .max(20),
  });
  const Product = z.strictObject({
    id: Id,
    sku: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    name: Title,
    description: Text,
    category_id: Id,
    price_minor: Minor,
    channel_prices_minor: z
      .strictObject({ mobile: Minor.optional(), pos: Minor.optional(), kiosk: Minor.optional() })
      .optional(),
    image_asset_key: z.string().refine((v) => keys.includes(v)),
    available: z.boolean(),
    prep_required: z.boolean(),
    prep_minutes: z.int().min(1).max(120),
    serving_label: Title,
    weight_g: z.int().min(1).max(100000).nullable(),
    volume_ml: z.int().min(1).max(100000).nullable(),
    ingredients: Text,
    allergens: z.array(z.string().trim().min(1).max(100)).max(30),
    allergens_status: z.enum(['unknown', 'declared']),
    nutrition: z.strictObject({
      basis: z.enum(['per_serving', 'per_100_g']),
      energy_kcal: z.number().min(0).max(100000),
      protein_g: z.number().min(0).max(10000),
      fat_g: z.number().min(0).max(10000),
      carbs_g: z.number().min(0).max(10000),
    }),
    nutrition_status: z.enum(['unverified', 'operator_entered']),
    kind: z.enum(['item', 'combo', 'set']),
    combo_components: z
      .array(z.strictObject({ product_id: Id, quantity: z.int().min(1).max(1000) }))
      .max(40),
    modifier_groups: z.array(Modifier).max(10),
  });
  const Payload = z
    .strictObject({
      schema_version: z.literal(1),
      currency: z.literal('KZT'),
      content_source: z.enum(['mockup', 'operator']),
      content_reviewed: z.boolean(),
      categories: z
        .array(z.strictObject({ id: Id, name: Title }))
        .min(1)
        .max(30),
      products: z.array(Product).min(1).max(100),
      estimated_minutes: z.strictObject({
        min: z.int().min(1).max(120),
        max: z.int().min(1).max(120),
      }),
      upsell_product_ids: z.array(Id).max(20),
    })
    .superRefine((value, ctx) => {
      const issue = (message) => ctx.addIssue({ code: 'custom', message });
      const unique = (values) => new Set(values).size === values.length;
      if (Buffer.byteLength(JSON.stringify(value)) > 262144) issue('too large');
      if (
        !unique(value.categories.map((v) => v.id)) ||
        !unique(value.products.map((v) => v.id)) ||
        !unique(value.products.map((v) => v.sku))
      )
        issue('duplicate');
      const ids = new Set(value.products.map((v) => v.id)),
        categories = new Set(value.categories.map((v) => v.id));
      if (!unique(value.upsell_product_ids) || value.upsell_product_ids.some((id) => !ids.has(id)))
        issue('upsell');
      if (value.estimated_minutes.min > value.estimated_minutes.max) issue('eta');
      for (const product of value.products) {
        if (!categories.has(product.category_id)) issue('category');
        if (
          !unique(product.allergens) ||
          !unique(product.modifier_groups.map((v) => v.id)) ||
          !unique(product.combo_components.map((v) => v.product_id))
        )
          issue('dependency');
        if (product.kind === 'item' && product.combo_components.length) issue('item components');
        const links = product.combo_components.map((v) => v.product_id);
        for (const group of product.modifier_groups) {
          if (group.min > group.max || !unique(group.options.map((v) => v.id))) issue('group');
          let defaults = 0,
            capacity = 0;
          for (const option of group.options) {
            if (
              option.default_quantity > option.max_quantity ||
              (!option.available && option.default_quantity > 0)
            )
              issue('default');
            defaults += option.default_quantity;
            if (option.available) capacity += option.max_quantity;
            if (option.linked_product_id) links.push(option.linked_product_id);
          }
          if (defaults < group.min || defaults > group.max || capacity < group.min)
            issue('unsatisfiable');
        }
        if (links.some((id) => !ids.has(id))) issue('links');
      }
    });
  const Mobile = z.strictObject({
    branch: z.strictObject({
      id: z.uuid(),
      code: z.string(),
      name: z.string(),
      timezone: z.literal('Asia/Almaty'),
      ordering_enabled: z.boolean(),
    }),
    channel: z.literal('mobile'),
    version: z.int().positive(),
    published_at: z.iso.datetime(),
    payload: Payload,
  });
  return { Payload, Mobile, Kiosk: Mobile.extend({ channel: z.literal('kiosk') }) };
}
/** MenuSnapshot keys the installed edge (c3a0fbee contracts) parses strictly. */
export const EDGE_KEYS = {
  item: [
    'product_id',
    'variant_id',
    'category_id',
    'name',
    'price_minor',
    'currency',
    'image_url',
    'modifier_groups',
    'source_id',
    'sku',
    'kind',
    'sort_order',
    'description',
    'image',
    'kitchen',
  ],
  group: ['id', 'name', 'min_selected', 'max_selected', 'options'],
  option: ['id', 'name', 'price_minor', 'max_quantity', 'default_quantity', 'available'],
  kitchen: ['route', 'unexpanded_combo'],
};
