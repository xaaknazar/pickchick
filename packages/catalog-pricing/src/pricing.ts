import { createHash } from 'node:crypto';
import { CatalogPayloadSchema } from '@pickchick/catalog-admin/contracts';
import type { CatalogPayload, CatalogProduct } from '@pickchick/catalog-admin/contracts';
import {
  CartInputSchema,
  PricingScopeSchema,
  CatalogReferenceSchema,
  PricedCatalogQuoteSchema,
  CatalogPricingError,
  MAX_MINOR,
  MAX_QUOTE_BYTES,
  MinorSchema,
} from './model.js';
import type {
  CatalogReference,
  PricingScope,
  PricedCatalogQuote,
  PricingErrorCode,
  SelectedDetails,
  CartInput,
} from './model.js';

const fail = (code: PricingErrorCode): never => {
  throw new CatalogPricingError(code);
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function amount(value: bigint): string {
  if (value < 0n || value > MAX_MINOR) return fail('AMOUNT_OUT_OF_RANGE');
  return value.toString();
}
/** Identical schema-ordered encoding to catalog-admin publication hashing, not JSONB key order. */
export function catalogPayloadHash(payload: unknown): string {
  const parsed = CatalogPayloadSchema.safeParse(payload);
  if (!parsed.success) return fail('CATALOG_INVALID');
  return sha(JSON.stringify(parsed.data));
}
export interface TrustedCatalogPublication {
  reference: CatalogReference;
  orderingEnabled: boolean;
  payload: unknown;
}
function lineId(
  reference: CatalogReference,
  sku: string,
  selections: CartInput['items'][number]['selections'],
) {
  const bytes = createHash('sha256')
    .update(
      JSON.stringify([
        reference.organizationId,
        reference.branchId,
        reference.version,
        sku,
        selections,
      ]),
    )
    .digest()
    .subarray(0, 16);
  // UUIDv8 is a custom deterministic SHA-256 identity, not a fabricated catalog release UUID.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const textCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function choose(product: CatalogProduct, selections: CartInput['items'][number]['selections']) {
  const result: SelectedDetails['modifiers'] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    const group = product.modifier_groups.find((g) => g.id === selection.group_id);
    const option = group?.options.find((o) => o.id === selection.option_id);
    const key = `${selection.group_id}/${selection.option_id}`;
    if (
      !group ||
      !option ||
      !option.available ||
      selection.quantity > option.max_quantity ||
      seen.has(key)
    )
      return fail('INVALID_SELECTION');
    seen.add(key);
    result.push({
      groupId: group.id,
      groupTitle: group.title,
      optionId: option.id,
      label: option.label,
      quantity: selection.quantity,
      unitPriceDeltaMinor: amount(BigInt(option.price_delta_minor)),
      totalPriceDeltaMinor: amount(BigInt(option.price_delta_minor) * BigInt(selection.quantity)),
      nutritionMultiplier: option.nutrition_multiplier ?? null,
      linkedProductId: option.linked_product_id,
    });
  }
  for (const group of product.modifier_groups) {
    const count = result
      .filter((v) => v.groupId === group.id)
      .reduce((sum, v) => sum + v.quantity, 0);
    if (count < group.min || count > group.max) return fail('INVALID_SELECTION');
  }
  return result.sort(
    (a, b) => textCompare(a.groupId, b.groupId) || textCompare(a.optionId, b.optionId),
  );
}
function componentResolver(products: Map<string, CatalogProduct>) {
  const memo = new Map<string, Map<string, number>>();
  const merge = (target: Map<string, number>, id: string, quantity: number) => {
    const count = (target.get(id) ?? 0) + quantity;
    if (!Number.isSafeInteger(count) || count > 1_000_000) return fail('AMBIGUOUS_COMPONENT');
    target.set(id, count);
  };
  const leaves = (id: string): Map<string, number> => {
    const product = products.get(id);
    if (!product || !product.available) return fail('PRODUCT_UNAVAILABLE');
    if (product.modifier_groups.length) return fail('AMBIGUOUS_COMPONENT');
    const cached = memo.get(id);
    if (cached) return cached;
    const result = new Map<string, number>();
    if (!product.combo_components.length) result.set(id, 1);
    else
      for (const child of product.combo_components)
        for (const [leaf, count] of leaves(child.product_id))
          merge(result, leaf, count * child.quantity);
    memo.set(id, result);
    return result;
  };
  return (
    parent: CatalogProduct,
    modifiers: SelectedDetails['modifiers'],
    quantity: number,
  ): SelectedDetails['components'] => {
    const included = parent.combo_components.concat(
      modifiers.flatMap((v) =>
        v.linkedProductId ? [{ product_id: v.linkedProductId, quantity: v.quantity }] : [],
      ),
    );
    const counts = new Map<string, number>();
    for (const component of included)
      for (const [id, count] of leaves(component.product_id))
        merge(counts, id, count * component.quantity);
    if ([...counts.values()].reduce((sum, n) => sum + n, 0) * quantity > 1_000_000)
      return fail('AMBIGUOUS_COMPONENT');
    return [...counts]
      .sort(([a], [b]) => textCompare(a, b))
      .map(([id, count]) => {
        const p = products.get(id)!;
        return {
          productId: id,
          sku: p.sku,
          quantity: count,
          name: p.name,
          description: p.description,
          ingredients: p.ingredients,
          servingLabel: p.serving_label,
          weightG: p.weight_g,
          volumeMl: p.volume_ml,
          allergens: { status: p.allergens_status, values: p.allergens },
          nutritionDeclaration: p.nutrition,
          nutritionStatus: p.nutrition_status,
        };
      });
  };
}
function nutrition(
  product: CatalogProduct,
  modifiers: SelectedDetails['modifiers'],
  quantity: number,
): SelectedDetails['nutrition'] {
  const base = {
    declaration: product.nutrition,
    sourceStatus: product.nutrition_status,
    perServing: null,
    lineTotal: null,
  };
  if (product.nutrition_status === 'unverified') return { ...base, reason: 'unverified' };
  // Only one explicit pure size multiplier is representable; additions have no nutrient contract.
  if (
    modifiers.length &&
    !(
      modifiers.length === 1 &&
      modifiers[0]!.nutritionMultiplier !== null &&
      modifiers[0]!.quantity === 1 &&
      modifiers[0]!.linkedProductId === null
    )
  )
    return { ...base, reason: 'modifier_nutrition_unknown' };
  if (product.nutrition.basis === 'per_100_g' && product.weight_g === null)
    return { ...base, reason: 'weight_unknown' };
  const factor =
    (product.nutrition.basis === 'per_100_g' ? product.weight_g! / 100 : 1) *
    (modifiers[0]?.nutritionMultiplier ?? 1);
  const scaled = (multiply: number) => ({
    energy_kcal: Math.round(product.nutrition.energy_kcal * multiply * 1000) / 1000,
    protein_g: Math.round(product.nutrition.protein_g * multiply * 1000) / 1000,
    fat_g: Math.round(product.nutrition.fat_g * multiply * 1000) / 1000,
    carbs_g: Math.round(product.nutrition.carbs_g * multiply * 1000) / 1000,
  });
  return {
    ...base,
    perServing: scaled(factor),
    lineTotal: scaled(factor * quantity),
    reason: 'operator_declaration',
  };
}

/** Server-only boundary: publication and scope must come from authenticated server repositories. */
export function priceCatalogSnapshot(
  publication: TrustedCatalogPublication,
  trustedScope: PricingScope,
  input: unknown,
): PricedCatalogQuote {
  const cart = CartInputSchema.safeParse(input);
  if (!cart.success) return fail('INVALID_CART');
  const scope = PricingScopeSchema.safeParse(trustedScope);
  if (!scope.success) return fail('SCOPE_MISMATCH');
  const reference = CatalogReferenceSchema.safeParse(publication.reference);
  const parsed = CatalogPayloadSchema.safeParse(publication.payload);
  if (!reference.success || !parsed.success) return fail('CATALOG_INVALID');
  const payload: CatalogPayload = parsed.data;
  if (
    reference.data.organizationId !== scope.data.organizationId ||
    reference.data.branchId !== scope.data.branchId
  )
    return fail('SCOPE_MISMATCH');
  if (!payload.content_reviewed || sha(JSON.stringify(payload)) !== reference.data.payloadHash)
    return fail('CATALOG_INVALID');
  if (publication.orderingEnabled !== true) return fail('BRANCH_UNAVAILABLE');
  if (reference.data.version !== cart.data.catalog_version) return fail('STALE_CATALOG');
  const bySku = new Map(payload.products.map((v) => [v.sku, v]));
  const components = componentResolver(new Map(payload.products.map((v) => [v.id, v])));
  const seen = new Set<string>();
  let total = 0n,
    lineBytes = 0;
  const lines = cart.data.items
    .map((item) => {
      const product = bySku.get(item.sku);
      if (!product || !product.available) return fail('PRODUCT_UNAVAILABLE');
      const modifiers = choose(product, item.selections);
      const id = lineId(
        reference.data,
        item.sku,
        modifiers.map((v) => ({
          group_id: v.groupId,
          option_id: v.optionId,
          quantity: v.quantity,
        })),
      );
      if (seen.has(id)) return fail('INVALID_CART');
      seen.add(id);
      const base = BigInt(
        product.channel_prices_minor?.[scope.data.channel] ?? product.price_minor,
      );
      const delta = modifiers.reduce((sum, v) => sum + BigInt(v.totalPriceDeltaMinor), 0n);
      const unit = base + delta;
      const gross = unit * BigInt(item.quantity);
      total += gross;
      const line = {
        lineId: id,
        productId: product.id,
        sku: product.sku,
        title: product.name.ru,
        description: product.description.ru,
        quantity: item.quantity,
        baseUnitPriceMinor: amount(base),
        modifiersUnitPriceMinor: amount(delta),
        unitPriceMinor: amount(unit),
        grossMinor: amount(gross),
        discountMinor: '0' as const,
        totalMinor: amount(gross),
        selectedDetails: {
          schemaVersion: 1 as const,
          name: product.name,
          description: product.description,
          servingLabel: product.serving_label,
          ingredients: product.ingredients,
          weightG: product.weight_g,
          volumeMl: product.volume_ml,
          imageAssetKey: product.image_asset_key,
          kind: product.kind,
          contentSource: payload.content_source,
          allergens: { status: product.allergens_status, values: product.allergens },
          nutrition: nutrition(product, modifiers, item.quantity),
          modifiers,
          components: components(product, modifiers, item.quantity),
        },
      };
      lineBytes += Buffer.byteLength(JSON.stringify(line), 'utf8');
      if (lineBytes > MAX_QUOTE_BYTES) return fail('QUOTE_TOO_LARGE');
      return line;
    })
    .sort((a, b) => textCompare(a.lineId, b.lineId));
  if (total <= 0n) return fail('AMOUNT_OUT_OF_RANGE');
  const quote = PricedCatalogQuoteSchema.parse({
    catalogReference: reference.data,
    customerId: scope.data.customerId,
    channel: scope.data.channel,
    serviceMode: cart.data.service_mode,
    currency: payload.currency,
    ttlSeconds: 300,
    lines,
    subtotalMinor: amount(total),
    discountMinor: '0',
    totalMinor: amount(total),
  });
  if (Buffer.byteLength(JSON.stringify(quote), 'utf8') > MAX_QUOTE_BYTES)
    return fail('QUOTE_TOO_LARGE');
  return quote;
}

/** Allocation arithmetic only. Caller must supply a separately authorized discount policy result. */
export function allocateDiscount(
  lines: readonly { lineId: string; grossMinor: string }[],
  trustedDiscountMinor: string,
) {
  if (
    !lines.length ||
    lines.length > 200 ||
    new Set(lines.map((l) => l.lineId)).size !== lines.length ||
    lines.some((l) => !l.lineId || !MinorSchema.safeParse(l.grossMinor).success) ||
    !MinorSchema.safeParse(trustedDiscountMinor).success
  )
    return fail('AMOUNT_OUT_OF_RANGE');
  const gross = lines.reduce((sum, line) => sum + BigInt(line.grossMinor), 0n);
  amount(gross);
  const discount = BigInt(trustedDiscountMinor);
  if (discount > gross) return fail('AMOUNT_OUT_OF_RANGE');
  const shares = lines.map((line) => ({
    lineId: line.lineId,
    gross: BigInt(line.grossMinor),
    discount: gross ? (discount * BigInt(line.grossMinor)) / gross : 0n,
    remainder: gross ? (discount * BigInt(line.grossMinor)) % gross : 0n,
  }));
  let remaining = discount - shares.reduce((sum, line) => sum + line.discount, 0n);
  shares.sort((a, b) =>
    a.remainder === b.remainder
      ? textCompare(a.lineId, b.lineId)
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (const line of shares) {
    if (!remaining) break;
    if (line.discount < line.gross) {
      line.discount++;
      remaining--;
    }
  }
  return shares
    .sort((a, b) => textCompare(a.lineId, b.lineId))
    .map((line) => ({
      lineId: line.lineId,
      discountMinor: amount(line.discount),
      totalMinor: amount(line.gross - line.discount),
    }));
}
