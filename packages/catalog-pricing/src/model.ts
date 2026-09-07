import { z } from 'zod';
import { CatalogProductSchema, CatalogTextSchema } from '@pickchick/catalog-admin/contracts';

export const MAX_MINOR = 9_000_000_000_000_000n;
export const MAX_QUOTE_BYTES = 1_048_576;
export const MinorSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/)
  .refine((value) => /^(0|[1-9][0-9]{0,15})$/.test(value) && BigInt(value) <= MAX_MINOR);
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const Sku = CatalogProductSchema.shape.sku;
export const CartInputSchema = z.strictObject({
  catalog_version: z.int().positive(),
  service_mode: z.enum(['takeaway', 'dine_in']),
  items: z
    .array(
      z.strictObject({
        sku: Sku,
        quantity: z.int().min(1).max(1000),
        selections: z
          .array(
            z.strictObject({
              group_id: Slug,
              option_id: Slug,
              quantity: z.int().min(1).max(40),
            }),
          )
          .max(40),
      }),
    )
    .min(1)
    .max(200),
});
export const PricingScopeSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid(),
  customerId: z.uuid().nullable(),
  channel: z.enum(['mobile', 'kiosk']),
});
export const CatalogReferenceSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid(),
  version: z.int().positive(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  publishedAt: z.iso.datetime(),
});
const NutritionValues = z.strictObject({
  energy_kcal: z.number().nonnegative(),
  protein_g: z.number().nonnegative(),
  fat_g: z.number().nonnegative(),
  carbs_g: z.number().nonnegative(),
});
const AllergenDeclaration = z.strictObject({
  status: CatalogProductSchema.shape.allergens_status,
  values: CatalogProductSchema.shape.allergens,
});
export const SelectedDetailsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: CatalogProductSchema.shape.name,
  description: CatalogTextSchema,
  servingLabel: CatalogProductSchema.shape.serving_label,
  ingredients: CatalogTextSchema,
  weightG: CatalogProductSchema.shape.weight_g,
  volumeMl: CatalogProductSchema.shape.volume_ml,
  imageAssetKey: CatalogProductSchema.shape.image_asset_key,
  kind: CatalogProductSchema.shape.kind,
  contentSource: z.enum(['mockup', 'operator']),
  allergens: AllergenDeclaration,
  nutrition: z.strictObject({
    declaration: CatalogProductSchema.shape.nutrition,
    sourceStatus: CatalogProductSchema.shape.nutrition_status,
    perServing: NutritionValues.nullable(),
    lineTotal: NutritionValues.nullable(),
    reason: z.enum([
      'operator_declaration',
      'unverified',
      'modifier_nutrition_unknown',
      'weight_unknown',
    ]),
  }),
  modifiers: z
    .array(
      z.strictObject({
        groupId: Slug,
        groupTitle: CatalogProductSchema.shape.name,
        optionId: Slug,
        label: CatalogProductSchema.shape.name,
        quantity: z.int().min(1).max(40),
        unitPriceDeltaMinor: MinorSchema,
        totalPriceDeltaMinor: MinorSchema,
        nutritionMultiplier: z.number().positive().max(100).nullable(),
        linkedProductId: Slug.nullable(),
      }),
    )
    .max(40),
  // Aggregated leaf quantities for one parent unit, not an expanded per-piece array.
  components: z
    .array(
      z.strictObject({
        productId: Slug,
        sku: Sku,
        quantity: z.int().min(1).max(1_000_000),
        name: CatalogProductSchema.shape.name,
        description: CatalogTextSchema,
        ingredients: CatalogTextSchema,
        servingLabel: CatalogProductSchema.shape.serving_label,
        weightG: CatalogProductSchema.shape.weight_g,
        volumeMl: CatalogProductSchema.shape.volume_ml,
        allergens: AllergenDeclaration,
        nutritionDeclaration: CatalogProductSchema.shape.nutrition,
        nutritionStatus: CatalogProductSchema.shape.nutrition_status,
      }),
    )
    .max(100),
});
export const PricedCatalogLineSchema = z.strictObject({
  lineId: z.uuid(),
  productId: Slug,
  sku: Sku,
  title: z.string().min(1).max(150),
  description: z.string().max(2000),
  quantity: z.int().min(1).max(1000),
  baseUnitPriceMinor: MinorSchema,
  modifiersUnitPriceMinor: MinorSchema,
  unitPriceMinor: MinorSchema,
  grossMinor: MinorSchema,
  discountMinor: z.literal('0'),
  totalMinor: MinorSchema,
  selectedDetails: SelectedDetailsSchema,
});
export const PricedCatalogQuoteSchema = z.strictObject({
  catalogReference: CatalogReferenceSchema,
  customerId: z.uuid().nullable(),
  channel: PricingScopeSchema.shape.channel,
  serviceMode: CartInputSchema.shape.service_mode,
  currency: z.literal('KZT'),
  ttlSeconds: z.literal(300),
  lines: z.array(PricedCatalogLineSchema).min(1).max(200),
  subtotalMinor: MinorSchema,
  discountMinor: z.literal('0'),
  totalMinor: MinorSchema,
});
export type CartInput = z.infer<typeof CartInputSchema>;
export type PricingScope = z.infer<typeof PricingScopeSchema>;
export type CatalogReference = z.infer<typeof CatalogReferenceSchema>;
export type SelectedDetails = z.infer<typeof SelectedDetailsSchema>;
export type PricedCatalogQuote = z.infer<typeof PricedCatalogQuoteSchema>;
export type PricingErrorCode =
  | 'INVALID_CART'
  | 'CATALOG_NOT_FOUND'
  | 'STALE_CATALOG'
  | 'CATALOG_INVALID'
  | 'SCOPE_MISMATCH'
  | 'BRANCH_UNAVAILABLE'
  | 'PRODUCT_UNAVAILABLE'
  | 'INVALID_SELECTION'
  | 'AMBIGUOUS_COMPONENT'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'QUOTE_TOO_LARGE';
export class CatalogPricingError extends Error {
  constructor(readonly code: PricingErrorCode) {
    super(code);
    this.name = 'CatalogPricingError';
  }
}
