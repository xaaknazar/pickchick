import { z } from 'zod';
export const CATALOG_MAX_PAYLOAD_BYTES = 262144;
export const CATALOG_ASSET_KEYS = [
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
] as const;
const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const Minor = z.string().regex(/^(0|[1-9][0-9]{0,15})$/);
export const CatalogTextSchema = z.strictObject({
  ru: z.string().max(2000),
  kk: z.string().max(2000),
});
const Title = z.strictObject({
  ru: z.string().trim().min(1).max(150),
  kk: z.string().trim().max(150),
});
export const CatalogModifierSchema = z.strictObject({
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
export const CatalogProductSchema = z.strictObject({
  id: Id,
  sku: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  name: Title,
  description: CatalogTextSchema,
  category_id: Id,
  price_minor: Minor,
  image_asset_key: z.string().refine((v) => CATALOG_ASSET_KEYS.some((key) => key === v)),
  available: z.boolean(),
  prep_required: z.boolean(),
  prep_minutes: z.int().min(1).max(120),
  serving_label: Title,
  weight_g: z.int().min(1).max(100000).nullable(),
  volume_ml: z.int().min(1).max(100000).nullable(),
  ingredients: CatalogTextSchema,
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
  modifier_groups: z.array(CatalogModifierSchema).max(10),
});
export const CatalogPayloadSchema = z
  .strictObject({
    schema_version: z.literal(1),
    currency: z.literal('KZT'),
    content_source: z.enum(['mockup', 'operator']),
    content_reviewed: z.boolean(),
    categories: z
      .array(z.strictObject({ id: Id, name: Title }))
      .min(1)
      .max(30),
    products: z.array(CatalogProductSchema).min(1).max(100),
    estimated_minutes: z.strictObject({
      min: z.int().min(1).max(120),
      max: z.int().min(1).max(120),
    }),
    upsell_product_ids: z.array(Id).max(20),
  })
  .superRefine((payload, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const unique = (values: readonly string[]) => new Set(values).size === values.length;
    if (new TextEncoder().encode(JSON.stringify(payload)).length > CATALOG_MAX_PAYLOAD_BYTES)
      issue('Catalog payload too large');
    if (
      !unique(payload.categories.map((v) => v.id)) ||
      !unique(payload.products.map((v) => v.id)) ||
      !unique(payload.products.map((v) => v.sku))
    )
      issue('Duplicate catalog identity');
    const ids = new Set(payload.products.map((v) => v.id)),
      categories = new Set(payload.categories.map((v) => v.id));
    if (
      !unique(payload.upsell_product_ids) ||
      payload.upsell_product_ids.some((id) => !ids.has(id))
    )
      issue('Invalid upsell dependency');
    if (payload.estimated_minutes.min > payload.estimated_minutes.max)
      issue('Invalid estimated minutes');
    const dependencies = new Map<string, string[]>();
    for (const product of payload.products) {
      if (!categories.has(product.category_id)) issue('Unknown category');
      if (
        !unique(product.allergens) ||
        !unique(product.modifier_groups.map((v) => v.id)) ||
        !unique(product.combo_components.map((v) => v.product_id))
      )
        issue('Duplicate product dependency');
      if (product.kind === 'item' && product.combo_components.length)
        issue('Item cannot contain combo components');
      const links = product.combo_components.map((v) => v.product_id);
      for (const group of product.modifier_groups) {
        if (group.min > group.max || !unique(group.options.map((v) => v.id)))
          issue('Invalid modifier identity or range');
        let defaults = 0,
          capacity = 0;
        for (const option of group.options) {
          if (
            option.default_quantity > option.max_quantity ||
            (!option.available && option.default_quantity > 0)
          )
            issue('Invalid default option');
          defaults += option.default_quantity;
          if (option.available) capacity += option.max_quantity;
          if (option.linked_product_id) links.push(option.linked_product_id);
        }
        if (defaults < group.min || defaults > group.max || capacity < group.min)
          issue('Unsatisfiable modifier group or defaults');
      }
      if (links.some((id) => !ids.has(id))) issue('Unknown component or modifier product');
      dependencies.set(product.id, links);
    }
    const visiting = new Set<string>(),
      done = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (done.has(id)) return true;
      visiting.add(id);
      for (const child of dependencies.get(id) ?? []) if (!visit(child)) return false;
      visiting.delete(id);
      done.add(id);
      return true;
    };
    if (payload.products.some((product) => !visit(product.id)))
      issue('Cyclic product dependencies');
  });
export type CatalogPayload = z.infer<typeof CatalogPayloadSchema>;
export type CatalogProduct = z.infer<typeof CatalogProductSchema>;
export type CatalogModifier = z.infer<typeof CatalogModifierSchema>;
const Branch = z.strictObject({ id: z.uuid(), code: z.string(), name: z.string() });
export const CatalogDraftSchema = z.strictObject({
  revision: z.int().positive(),
  base_version: z.int().nonnegative(),
  updated_at: z.iso.datetime(),
  updated_by: z.uuid(),
  payload: CatalogPayloadSchema,
});
export const CatalogPublishedSchema = z.strictObject({
  version: z.int().positive(),
  published_at: z.iso.datetime(),
  published_by: z.uuid(),
  payload: CatalogPayloadSchema,
});
export const CatalogStateSchema = z.strictObject({
  branch: Branch,
  draft: CatalogDraftSchema.nullable(),
  published: CatalogPublishedSchema.nullable(),
});
export type CatalogState = z.infer<typeof CatalogStateSchema>;
export const CatalogBranchesSchema = z.strictObject({
  actor: z.strictObject({ id: z.uuid(), name: z.string() }),
  branches: z.array(Branch),
});
export const CatalogPublicSchema = z.strictObject({
  branch_id: z.uuid(),
  version: z.int().positive(),
  published_at: z.iso.datetime(),
  payload: CatalogPayloadSchema,
});
export const CatalogSaveSchema = z.strictObject({
  expected_revision: z.int().positive(),
  request_id: z.uuid(),
  payload: CatalogPayloadSchema,
});
export const CatalogSeedSchema = z.strictObject({
  expected_revision: z.literal(0),
  request_id: z.uuid(),
});
export const CatalogPublishSchema = z.strictObject({
  expected_revision: z.int().positive(),
  expected_published_version: z.int().nonnegative(),
  request_id: z.uuid(),
  confirmation: z.literal('publish_catalog'),
});
export const CatalogManagerInputSchema = z
  .strictObject({
    organization_id: z.uuid(),
    name: z.string().trim().min(1).max(100),
    branch_ids: z.array(z.uuid()).min(1).max(100),
  })
  .refine((v) => new Set(v.branch_ids).size === v.branch_ids.length);
export const CatalogCredentialSchema = CatalogManagerInputSchema.safeExtend({
  actor_id: z.uuid(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  issued_at: z.iso.datetime(),
});
export type CatalogCredential = z.infer<typeof CatalogCredentialSchema>;
export type CatalogErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SERVICE_UNAVAILABLE';
export class CatalogAdminError extends Error {
  constructor(readonly code: CatalogErrorCode) {
    super(code);
    this.name = 'CatalogAdminError';
  }
}
export function parseCatalogInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new CatalogAdminError('INVALID_REQUEST');
  return result.data;
}
